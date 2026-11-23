import {
  LOCAL_PROXY_HOST,
  proxyModeLabel,
  readProxyStatus,
  setProxyMode,
  type ProxyMode,
  type ProxyStatus,
} from './worker/proxy.js';
import { setProxyStatusIcon, showStatus } from './ui.js';

const modeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="proxy-mode"]'));
const statusText = document.querySelector<HTMLParagraphElement>('#proxy-status')!;
const socksEndpoint = document.querySelector<HTMLElement>('#socks-endpoint')!;
const statusIcon = document.querySelector<HTMLImageElement>('#proxy-status-icon')!;

let busy = true;
let blocked = false;
let currentStatus: ProxyStatus | undefined;
let refreshVersion = 0;
let initializing = true;

function updateDisabled() {
  for (const input of modeInputs) input.disabled = busy || blocked;
}

function render(status: ProxyStatus) {
  currentStatus = status;
  blocked = status.controlledByOther;
  setProxyStatusIcon(statusIcon, status.mode);
  socksEndpoint.textContent = `${LOCAL_PROXY_HOST}:${status.port}`;

  for (const input of modeInputs) {
    const selected = input.value === status.mode;
    input.checked = selected;
  }
  updateDisabled();

  if (status.controlledByOther) {
    showStatus(statusText,'代理由其他扩展控制，请先停用它', true);
  } else if (status.portToApply !== undefined) {
    showStatus(statusText, `点击「本机 SOCKS5」可改用已保存的端口 ${status.portToApply}`);
  } else if (status.mode === 'other') {
    showStatus(statusText,'当前是其他代理模式，选择一项即可替换');
  } else {
    showStatus(statusText, `当前：${proxyModeLabel(status.mode)}`);
  }
}

async function refresh(errorMessage?: string) {
  const version = ++refreshVersion;
  try {
    const status = await readProxyStatus();
    if (version !== refreshVersion) return;
    render(status);
    if (errorMessage) showStatus(statusText,errorMessage, true);
  } catch (error) {
    if (version !== refreshVersion) return;
    setProxyStatusIcon(statusIcon, null);
    blocked = true;
    for (const input of modeInputs) {
      input.checked = false;
    }
    updateDisabled();
    showStatus(statusText,'读取代理状态失败，请重新打开弹窗', true);
    console.error(error);
  } finally {
    // 初始化期间发生事件时，只有最新一次读取可以启用控件
    if (initializing && version === refreshVersion) {
      initializing = false;
      busy = false;
      updateDisabled();
    }
  }
}

for (const input of modeInputs) {
  input.addEventListener('click', async () => {
    if (!input.checked || busy || blocked) return;
    const mode: ProxyMode = input.value === 'socks5' ? 'socks5' : 'direct';
    if (currentStatus?.mode === mode && currentStatus.portToApply === undefined) return;
    busy = true;
    updateDisabled();
    showStatus(statusText,'正在切换…');

    try {
      await setProxyMode(mode);
      await refresh();
    } catch (error) {
      console.error(error);
      await refresh('切换失败，请重试');
    } finally {
      busy = false;
      updateDisabled();
    }
  });
}

if (chrome.extension.inIncognitoContext) {
  busy = false;
  blocked = true;
  updateDisabled();
  showStatus(statusText,'请在普通窗口中切换代理');
} else {
  chrome.proxy.settings.onChange.addListener(() => {
    void refresh();
  });
  refresh();
}
