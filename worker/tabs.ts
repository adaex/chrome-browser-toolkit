// 标签当前有效网址：加载中是 pendingUrl，加载完是 url。去重比对与备份拍照必须同一口径
export const effectiveUrl = (tab: chrome.tabs.Tab): string => tab.pendingUrl ?? tab.url ?? '';

export function isProxySwitchUrl(url: string): boolean {
  if (!url.startsWith('chrome-extension://')) return false;
  const switchUrl = chrome.runtime.getURL('switch.html');
  return url === switchUrl || url.startsWith(`${switchUrl}?`) || url.startsWith(`${switchUrl}#`);
}

// 监听 tab 的创建和更新事件，检查是否有重复的 tab
// 返回 true 表示新标签已被关闭（重复命中），调用方不要再操作这个标签
export async function checkDuplicate(
  tabId: number,
  isCurrent: (id: number) => boolean = () => true,
  requireActive = false,
): Promise<boolean> {
  // 获取所有的 tabs，调用浏览器 api
  const tabs = await chrome.tabs.query({});
  if (!isCurrent(tabId)) return false;

  // 获取当前 tab 和 url
  const tab = tabs.find(item => item.id === tabId);
  const url = tab ? effectiveUrl(tab) : '';

  // 异常不存在，或当前标签导航后已切到后台，直接忽略
  if (tab?.id == null || (requireActive && !tab.active)) return false;

  // 外部切换失败后可能保留页面，重试相同 URL 时不能被当成普通重复标签关掉
  if (isProxySwitchUrl(url)) return false;

  // 获取全部同 URL 的已存在标签（可能不止一个，不能吃 query 的数组顺序，要按优先级挑目标）
  // 新标签自身还没有 URL 时不去重（否则两个空 URL 标签会互相匹配）
  const duplicates = url
    ? tabs.filter(other => other.id != null && other.id !== tabId && isCurrent(other.id) && effectiveUrl(other) === url)
    : [];

  // 目标不存在，直接忽略
  if (!duplicates.length) return false;

  // 新建页面只保留最新打开的一个：直接关闭全部历史标签，保留当前标签（不查 pinned，有意）
  if (url.startsWith('chrome://new') || url === 'about:blank') {
    await chrome.tabs.remove(duplicates.map(other => other.id!));
    return false;
  }

  // 选出优先级最高的老标签，执行同一规则指定的操作
  const { target: existedTab, preference } = pickTarget(duplicates, tab);
  if (existedTab.id == null) return false;

  // 固定标签的位置是用户明确保留的，普通网址导航不把它当作可关闭的新标签
  if (tab.pinned) return false;

  // 特殊情况：复制 tab 的场景（自己打开自己），允许重复，本次操作忽略
  if (tab.openerTabId != null && duplicates.some(other => other.id === tab.openerTabId)) return false;

  if (preference === PREFERENCE.SKIP) return false;
  if (preference === PREFERENCE.MERGE) {
    await chrome.tabs.group({ tabIds: existedTab.id, groupId: tab.groupId });
  } else if (existedTab.windowId !== tab.windowId) {
    await chrome.windows.update(existedTab.windowId, { focused: true });
  }
  if (!isCurrent(tabId) || !isCurrent(existedTab.id)) return false;

  // 激活失败会抛给队列并中止，不能继续关掉用户正在打开的标签
  await chrome.tabs.update(existedTab.id, { active: true });
  if (!isCurrent(tabId) || !isCurrent(existedTab.id)) return false;
  await chrome.tabs.remove(tab.id); // 必须要等 active 完成之后再 remove，否则会 active 会乱跳
  return true;
}

// 候选处理优先级（数值越小越优先），也用于决定选定后是否并组或保留重复：
// SAME    同组，或新标签未分组时的同窗候选：直接激活
// MERGE   新标签在组内，同窗未分组旧标签可并入该组
// CROSS   跨窗未分组：可聚焦另一窗口激活
// SKIP    pinned / 在别组：特判分支会保留重复，必须垫底，否则会挡住跨窗可用目标
const PREFERENCE = {
  SAME: 0,
  MERGE: 1,
  CROSS: 2,
  SKIP: 3,
} as const;

function pickTarget(duplicates: chrome.tabs.Tab[], tab: chrome.tabs.Tab) {
  const rank = (other: chrome.tabs.Tab): number => {
    if (tab.groupId >= 0) {
      if (other.groupId === tab.groupId) return PREFERENCE.SAME;
      if (other.groupId < 0 && !other.pinned) {
        return other.windowId === tab.windowId ? PREFERENCE.MERGE : PREFERENCE.CROSS;
      }
      return PREFERENCE.SKIP;
    }
    return other.windowId === tab.windowId ? PREFERENCE.SAME : PREFERENCE.CROSS;
  };
  let target = duplicates[0];
  let preference = rank(target);
  for (let i = 1; i < duplicates.length && preference !== PREFERENCE.SAME; i++) {
    const current = rank(duplicates[i]);
    if (current < preference) {
      target = duplicates[i];
      preference = current;
    }
  }
  return { target, preference };
}

// 如果有全屏的窗口，则把当前 tab 移动到全屏的窗口里去
export async function toFullscreenWindow(tabId: number, windowId: number, beginMove = () => true) {
  const windows = await chrome.windows.getAll();
  const fullscreenWindows = windows.filter(window => window.state === 'fullscreen' && window.type === 'normal');
  // 没有唯一目标时直接返回，避免为不会执行的移动再序列化源窗口的全部标签
  const fullscreenWindow = fullscreenWindows.length === 1 ? fullscreenWindows[0] : undefined;
  if (fullscreenWindow?.id == null) return;

  const currentWindow = await chrome.windows.get(windowId, { populate: true });
  // 多个全屏窗口时无法判断用户想去哪个，宁可不移动；index === 0 也不等于新窗口
  // 源窗口必须仍只有当前这一个标签，避免拆散已有多标签窗口
  if (
    currentWindow.type === 'normal' &&
    currentWindow.state === 'normal' &&
    currentWindow.tabs?.length === 1 &&
    currentWindow.tabs[0].id === tabId &&
    !isProxySwitchUrl(effectiveUrl(currentWindow.tabs[0])) &&
    beginMove()
  ) {
    await chrome.tabs.move(tabId, { windowId: fullscreenWindow.id, index: -1 });
    await chrome.tabs.update(tabId, { active: true });
    // 先移动再聚焦，移动失败时不把用户焦点抢到另一个窗口
    await chrome.windows.update(fullscreenWindow.id, { focused: true });
  }
}
