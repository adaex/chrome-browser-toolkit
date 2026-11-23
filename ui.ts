import { pageIconForProxyMode, proxyModeLabel, proxyModeOf, readProxyStatus, type ProxyModeState } from './worker/proxy.js';

export function showStatus(element: HTMLElement, message: string, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
}

export function setProxyStatusIcon(image: HTMLImageElement, mode: ProxyModeState | null) {
  if (mode === null) {
    image.hidden = true;
    image.alt = '';
    return;
  }
  const path = pageIconForProxyMode(mode);
  if (image.getAttribute('src') !== path) image.src = path;
  image.alt = `当前代理：${proxyModeLabel(mode)}`;
  image.hidden = false;
}

// 启动读取一次，之后直接消费事件携带的配置；启动期间收到事件后不再回写旧状态
export function startProxyStatusIconSync(image: HTMLImageElement) {
  if (chrome.extension?.inIncognitoContext === true) return;
  let hasChanged = false;
  chrome.proxy.settings.onChange.addListener(details => {
    hasChanged = true;
    setProxyStatusIcon(image, proxyModeOf(details.value));
  });
  void readProxyStatus(false).then(status => {
    if (!hasChanged) setProxyStatusIcon(image, status.mode);
  }, error => {
    if (hasChanged) return;
    setProxyStatusIcon(image, null);
    console.error(error);
  });
}
