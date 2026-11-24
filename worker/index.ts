import { archiveGroup, backupGroup, initBackupAllGroups } from './backup.js';
import {
  forgetGroupObject,
  forgetTab,
  formerGroupOf,
  noteGroup,
  noteGroupObject,
  resolveGroupObject,
} from './groupCache.js';
import { catchError, Queue, queue } from './queue.js';
import { applyProxyWrite, PROXY_MESSAGE, syncProxyIndicator } from './proxy.js';
import { loadFeatureSettings } from './settings.js';
import { checkDuplicate, effectiveUrl, isProxySwitchUrl, toFullscreenWindow } from './tabs.js';

const proxyWriteQueue = new Queue();

function startNormalMode() {
  // 去重查询读取当时的标签，不依赖事件里的网址；查询发出前，同一标签只排一次
  type TabCheck = { tabId: number; newWindowId?: number; focusedWindowId?: number; merged: boolean };
  const pendingTabChecks = new Map<number, TabCheck>();
  const changedTabs = new Set<number>(); // 只跟踪当前查询期间导航或关闭的标签
  const isCurrent = (id: number) => !changedTabs.has(id);
  let checking: TabCheck | undefined;
  function scheduleTabCheck(tabId: number, newWindowId?: number, focusedWindowId?: number) {
    const pending = pendingTabChecks.get(tabId);
    if (pending) {
      pending.merged = true;
      pending.newWindowId ??= newWindowId;
      return;
    }
    const check: TabCheck = { tabId, newWindowId, focusedWindowId, merged: false };
    pendingTabChecks.set(tabId, check);
    queue.run(async () => {
      if (pendingTabChecks.get(tabId) !== check) return;
      try {
        const settings = await loadFeatureSettings();
        if (pendingTabChecks.get(tabId) !== check) return;
        pendingTabChecks.delete(tabId);
        checking = check;
        if (settings.deduplicate && check.focusedWindowId !== undefined) {
          const sourceWindow = await chrome.windows.get(check.focusedWindowId);
          if (!sourceWindow.focused || !isCurrent(tabId)) return;
        }
        const removed = settings.deduplicate && await checkDuplicate(
          tabId,
          isCurrent,
          check.focusedWindowId !== undefined,
        );
        if (!isCurrent(tabId) || removed || !settings.fullscreen || check.newWindowId === undefined) return;
        check.merged = false;
        await toFullscreenWindow(tabId, check.newWindowId, () => {
          if (!isCurrent(tabId)) return false;
          check.newWindowId = undefined; // 本次已决定移动，之后的导航只需去重
          return true;
        });
      } catch (error) {
        // 读取失败时，给已合并的事件一次机会；关闭或导航后的旧任务不重排
        const pending = pendingTabChecks.get(tabId) === check;
        if (pending) pendingTabChecks.delete(tabId);
        if (check.merged && (pending || (checking === check && isCurrent(tabId)))) {
          scheduleTabCheck(tabId, check.newWindowId, check.focusedWindowId);
        }
        throw error;
      } finally {
        checking = undefined;
        changedTabs.clear();
      }
    });
  }

  // 同组只保留一个待执行备份；执行期间又来了事件，可再排一个尾随备份读取最新状态
  const groupBackups = new Map<number, { pending: boolean }>();
  function scheduleBackup(groupId: number | undefined) {
    if (groupId === undefined || groupId < 0) return;
    const batch = groupBackups.get(groupId) ?? { pending: false };
    if (batch.pending) return;
    batch.pending = true;
    groupBackups.set(groupId, batch);
    const isCurrent = () => groupBackups.get(groupId) === batch;
    queue.run(async () => {
      if (!isCurrent()) return;
      batch.pending = false;
      try {
        await backupGroup(groupId, isCurrent);
      } finally {
        if (!batch.pending && isCurrent()) groupBackups.delete(groupId);
      }
    });
  }

  const refreshProxyIndicator = () => {
    syncProxyIndicator().catch(catchError('proxyIndicator'));
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== PROXY_MESSAGE) return;
    proxyWriteQueue.run(async () => {
      try {
        sendResponse(await applyProxyWrite(message));
      } catch (error) {
        catchError('proxyWrite')(error);
        sendResponse({ ok: false });
      }
    });
    return true;
  });

  chrome.proxy.settings.onChange.addListener(refreshProxyIndicator);
  refreshProxyIndicator();

  // 启动对账占据队首，从第一次查询起记录组的变动
  const startup = initBackupAllGroups();
  queue.run(() => startup);

  chrome.tabs.onCreated.addListener(tab => {
    const tabId = tab.id;
    if (tabId == null) return;
    noteGroup(tabId, tab.groupId);

    // 一次性代理切换页不参与标签管理，避免失败后的同 URL 重试被合并或移动
    if (isProxySwitchUrl(effectiveUrl(tab))) return;

    scheduleTabCheck(tabId, tab.openerTabId == null && tab.index === 0 ? tab.windowId : undefined);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const groupChanged = changeInfo.groupId != null;
    const prevGroupId = groupChanged ? formerGroupOf(tabId) : undefined;
    noteGroup(tabId, tab.groupId);

    if (changeInfo.url) {
      if (checking) changedTabs.add(tabId);
      if (isProxySwitchUrl(changeInfo.url)) pendingTabChecks.delete(tabId);
      // 已有后台标签的跳转不新排去重，避免激活旧标签或聚焦其他窗口；
      // 创建检查已经排队的标签仍要完成本次检查，新窗口吸附也不因后续导航丢失
      else if (tab.active || pendingTabChecks.has(tabId) || checking?.tabId === tabId) {
        const current = checking?.tabId === tabId ? checking : undefined;
        const focusedWindowId = current
          ? current.focusedWindowId
          : pendingTabChecks.has(tabId) ? undefined : tab.windowId;
        scheduleTabCheck(tabId, current?.newWindowId, focusedWindowId);
      }
    }

    // complete 后拍下当前标题；之后 SPA 等场景再改标题时补拍
    if (changeInfo.status === 'complete' || (changeInfo.title != null && tab.status === 'complete')) {
      scheduleBackup(tab.groupId);
    }

    // 入组、离组、跨组移动：新组要拍，旧组少了标签也要拍（独立分支，不与上面互斥）
    if (groupChanged) {
      if (prevGroupId !== tab.groupId) scheduleBackup(prevGroupId);
      scheduleBackup(tab.groupId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    pendingTabChecks.delete(tabId);
    if (checking) changedTabs.add(tabId);
    const groupId = formerGroupOf(tabId);
    forgetTab(tabId);

    // 整窗关闭时组本身也会被删，tabGroups.onRemoved 会归档整组，这里不用再拍
    if (!removeInfo.isWindowClosing) scheduleBackup(groupId);
  });

  // 同窗拖动会改变组内顺序，跨窗拖出会改变原组成员；两种事件都不带 groupId
  const backupAfterMove = (tabId: number) => scheduleBackup(formerGroupOf(tabId));
  chrome.tabs.onMoved.addListener(backupAfterMove);
  chrome.tabs.onDetached.addListener(backupAfterMove);

  chrome.tabGroups.onUpdated.addListener(group => {
    const previous = resolveGroupObject(group.id);
    noteGroupObject(group);

    // 快照不保存 collapsed，纯折叠/展开无需重写；缓存 miss 时保守拍一次
    if (!previous || previous.title !== group.title || previous.color !== group.color) {
      scheduleBackup(group.id);
    }
  });

  chrome.tabGroups.onRemoved.addListener(group => {
    // 组被删除时归档快照，误删可从归档找回
    groupBackups.delete(group.id);
    forgetGroupObject(group.id);
    queue.run(() => archiveGroup(group.id));
  });
}

// split 的无痕进程与普通进程共享 storage.local；不注册业务监听，避免操作或备份无痕标签
if (chrome.extension?.inIncognitoContext !== true) startNormalMode();
