import { readBackups } from './worker/backup.js';
import { isValidProxyPort, loadProxyPort, saveProxyPort } from './worker/proxy.js';
import { Queue } from './worker/queue.js';
import { type FeatureSettings, loadFeatureSettings, saveFeatureSetting } from './worker/settings.js';
import { showStatus, startProxyStatusIconSync } from './ui.js';

const featureInputs = [
  ['deduplicate', document.querySelector<HTMLInputElement>('#deduplicate')!],
  ['fullscreen', document.querySelector<HTMLInputElement>('#fullscreen')!],
] as const;
const featureStatus = document.querySelector<HTMLParagraphElement>('#feature-status')!;
const proxyForm = document.querySelector<HTMLFormElement>('#proxy-form')!;
const proxyPort = document.querySelector<HTMLInputElement>('#proxy-port')!;
const proxySave = document.querySelector<HTMLButtonElement>('#proxy-save')!;
const proxyStatus = document.querySelector<HTMLParagraphElement>('#proxy-status')!;
const proxyStatusIcon = document.querySelector<HTMLImageElement>('#proxy-status-icon')!;
const backupStatus = document.querySelector<HTMLParagraphElement>('#backup-status')!;
const exportStatus = document.querySelector<HTMLParagraphElement>('#export-status')!;
const backupDetails = document.querySelector<HTMLDetailsElement>('#backup-details')!;
const backupOutput = document.querySelector<HTMLPreElement>('#backup-output')!;
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')!;
const exportButton = document.querySelector<HTMLButtonElement>('#export')!;

let settingsChangeVersion = 0;
let proxyPortEdited = false;
const settingsSaveQueue = new Queue();
const inIncognitoContext = chrome.extension?.inIncognitoContext === true;

if (inIncognitoContext) {
  proxyPort.disabled = true;
  proxySave.disabled = true;
  showStatus(proxyStatus, '请在普通窗口中修改代理端口');
  refreshButton.disabled = exportButton.disabled = true;
  backupDetails.hidden = true;
  showStatus(backupStatus, '请在普通窗口中查看或导出备份');
}

let settingsReadVersion = 0;
let showingReadError = false;
const settingEdits = { deduplicate: 0, fullscreen: 0 };
let settledSettingsVersion = 0; // 保存队列按编辑顺序完成，包括失败的写入
const failedSettings = new Set<keyof FeatureSettings>();
const featureLabels = { deduplicate: '合并相同网址', fullscreen: '新窗口并入全屏窗口' };

function saveSetting(feature: keyof FeatureSettings, enabled: boolean) {
  const version = ++settingsChangeVersion;
  settingEdits[feature] = version;
  showingReadError = false;
  showStatus(featureStatus, '正在保存…');

  // 连续改动按顺序落盘，避免较早的写请求最后完成、把新开关状态覆盖掉
  settingsSaveQueue.run(async () => {
    try {
      await saveFeatureSetting(feature, enabled);
      failedSettings.delete(feature);
    } catch (error) {
      failedSettings.add(feature);
      console.error(error);
    }
    settledSettingsVersion = version;
    if (version !== settingsChangeVersion) return;
    if (failedSettings.size) {
      const labels = [...failedSettings].map(key => featureLabels[key]).join('、');
      showStatus(featureStatus, `未能保存“${labels}”，请重新设置`, true);
    } else {
      showStatus(featureStatus, '已保存，更改立即生效');
    }
  });
}

for (const [feature, input] of featureInputs) {
  input.addEventListener('change', () => saveSetting(feature, input.checked));
}
proxyPort.addEventListener('input', () => {
  proxyPortEdited = true;
});

proxyForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (inIncognitoContext) {
    showStatus(proxyStatus, '请在普通窗口中修改代理端口');
    return;
  }
  const port = Number(proxyPort.value);
  if (!isValidProxyPort(port)) {
    showStatus(proxyStatus, '端口必须是 1–65535 之间的整数', true);
    return;
  }

  proxySave.disabled = true;
  showStatus(proxyStatus, '正在保存…');
  try {
    await saveProxyPort(port);
    showStatus(proxyStatus, '代理端口已保存');
  } catch (error) {
    showStatus(proxyStatus, '保存失败，请检查代理控制状态后重试', true);
    console.error(error);
  } finally {
    proxySave.disabled = inIncognitoContext;
  }
});

let backupLoadVersion = 0;

async function loadBackups() {
  const version = ++backupLoadVersion;
  refreshButton.disabled = true;
  showStatus(backupStatus, '正在读取…');
  try {
    const { entries, active, archived, legacy } = await readBackups(backupDetails.open);
    if (version !== backupLoadVersion) return;
    if (entries && backupDetails.open) backupOutput.textContent = JSON.stringify(entries, null, 2);
    const legacyNote = legacy ? '，另有旧版备份未计入' : '';
    showStatus(backupStatus, `已找到 ${active} 份组快照、${archived} 条历史归档${legacyNote}`);
  } catch (error) {
    if (version !== backupLoadVersion) return;
    backupOutput.textContent = '';
    showStatus(backupStatus, '读取备份失败，请重试', true);
    console.error(error);
  } finally {
    if (version === backupLoadVersion) refreshButton.disabled = false;
  }
}

async function exportBackups() {
  exportButton.disabled = true;
  exportStatus.hidden = false;
  showStatus(exportStatus, '正在导出…');
  try {
    const { entries } = await readBackups(true);
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tab-group-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showStatus(exportStatus, '已导出备份 JSON');
  } catch (error) {
    showStatus(exportStatus, '导出备份失败，请重试', true);
    console.error(error);
  } finally {
    exportButton.disabled = false;
  }
}

async function refreshSettings() {
  const readVersion = ++settingsReadVersion;
  const savedBeforeRead = settledSettingsVersion;
  try {
    const settings = await loadFeatureSettings();
    if (readVersion !== settingsReadVersion) return;
    for (const [feature, input] of featureInputs) {
      const edit = settingEdits[feature];
      if (edit > savedBeforeRead || failedSettings.has(feature)) continue;
      input.checked = settings[feature];
    }
    if (showingReadError) {
      showingReadError = false;
      showStatus(featureStatus, '更改立即生效');
    }
  } catch (error) {
    if (readVersion !== settingsReadVersion || savedBeforeRead !== settingsChangeVersion || failedSettings.size) return;
    showingReadError = true;
    showStatus(featureStatus, '读取设置失败，请刷新页面重试', true);
    console.error(error);
  }
}

window.addEventListener('focus', refreshSettings);
document.addEventListener('visibilitychange', () => {
  // 从其他标签切回时，键盘焦点可能还留在地址栏
  if (document.visibilityState === 'visible' && !document.hasFocus()) refreshSettings();
});
refreshSettings();
if (!inIncognitoContext) {
  refreshButton.addEventListener('click', loadBackups);
  backupDetails.addEventListener('toggle', () => {
    if (backupDetails.open) loadBackups();
    else backupOutput.textContent = '';
  });
  exportButton.addEventListener('click', exportBackups);
  loadBackups();
}
startProxyStatusIconSync(proxyStatusIcon);
loadProxyPort().then(port => {
  if (!proxyPortEdited) proxyPort.value = String(port);
}).catch(error => {
  showStatus(proxyStatus, '读取代理端口失败，请刷新页面重试', true);
  console.error(error);
});
