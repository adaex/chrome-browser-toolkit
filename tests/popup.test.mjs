import assert from 'node:assert/strict';
import test from 'node:test';

import { createImage, flush, localSocks, proxyResult } from './helpers.mjs';

let pageId = 0;

function element(extra = {}) {
  return Object.assign(new EventTarget(), {
    textContent: '', checked: false, disabled: false, classList: { toggle() {} },
  }, extra);
}

async function openPopup(incognito = false, get) {
  const direct = element({ value: 'direct', disabled: true });
  const socks5 = element({ value: 'socks5', disabled: true });
  const status = element();
  const image = createImage();
  const nodes = { '#proxy-status': status, '#socks-endpoint': element(), '#proxy-status-icon': image };
  globalThis.document = {
    querySelectorAll() { return [direct, socks5]; },
    querySelector(selector) { return nodes[selector]; },
  };

  let value = { mode: 'direct' };
  let getImpl = get ?? (async () => proxyResult(value));
  let listener;
  let reads = 0;
  let listeners = 0;
  const messages = [];
  globalThis.chrome = {
    extension: { inIncognitoContext: incognito },
    storage: { local: { async get() { return {}; } } },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        return { ok: true };
      },
    },
    proxy: {
      settings: {
        onChange: { addListener(callback) { listener = callback; listeners++; } },
        get() {
          reads++;
          return getImpl();
        },
      },
    },
  };

  await import(`../dist/popup.js?page=${++pageId}`);
  await flush();
  return {
    direct, socks5, status, image, messages,
    reads: () => reads,
    listeners: () => listeners,
    setGet(implementation) { getImpl = implementation; },
    emit(nextValue) { value = nextValue; listener(proxyResult(nextValue)); },
  };
}

test('弹窗初始化只读一次，代理事件统一刷新图标、单选项和状态文字', async () => {
  const page = await openPopup();
  assert.equal(page.reads(), 1);
  assert.equal(page.direct.checked, true);
  assert.equal(page.image.src, 'icon/icon.svg');
  assert.equal(page.image.hidden, false);
  assert.equal(page.image.alt, '当前代理：直连');

  page.emit(localSocks());
  await flush();
  assert.equal(page.reads(), 2);
  assert.equal(page.direct.checked, false);
  assert.equal(page.socks5.checked, true);
  assert.equal(page.status.textContent, '当前：本机 SOCKS5');
  assert.equal(page.image.src, 'icon/socks5.svg');
  assert.equal(page.image.alt, '当前代理：本机 SOCKS5');

  // currentStatus 已更新，点击直连不会被误判为同模式而忽略
  page.direct.checked = true;
  page.direct.dispatchEvent(new Event('click'));
  await flush();
  assert.deepEqual(page.messages.map(message => [message.operation, message.mode]), [['setMode', 'direct']]);
});

test('慢返回的旧弹窗刷新不会覆盖事件带来的新状态', async () => {
  const page = await openPopup();
  let resolveStale;
  page.setGet(() => new Promise(resolve => { resolveStale = () => resolve(proxyResult({ mode: 'system' })); }));
  page.emit({ mode: 'system' });
  page.setGet(async () => proxyResult(localSocks()));
  page.emit(localSocks());
  await flush();
  assert.equal(page.socks5.checked, true);
  assert.equal(page.image.src, 'icon/socks5.svg');

  resolveStale();
  await flush();
  assert.equal(page.socks5.checked, true);
  assert.equal(page.status.textContent, '当前：本机 SOCKS5');
  assert.equal(page.image.src, 'icon/socks5.svg');
});

test('初始化事件刷新完成前不会被旧请求提前启用控件', async () => {
  const pending = [];
  const page = await openPopup(false, () => new Promise(resolve => pending.push(resolve)));
  assert.equal(pending.length, 1);
  assert.equal(page.direct.disabled, true);

  page.emit(localSocks());
  assert.equal(pending.length, 2);
  pending[0](proxyResult({ mode: 'direct' }));
  await flush();
  assert.equal(page.direct.disabled, true);
  assert.equal(page.socks5.disabled, true);

  pending[1](proxyResult(localSocks()));
  await flush();
  assert.equal(page.direct.disabled, false);
  assert.equal(page.socks5.disabled, false);
  assert.equal(page.socks5.checked, true);
  assert.equal(page.status.textContent, '当前：本机 SOCKS5');
});

test('系统代理显示独立状态且不误选直连或 SOCKS5', async () => {
  const page = await openPopup(false, async () => proxyResult({ mode: 'system' }));
  assert.equal(page.direct.checked, false);
  assert.equal(page.socks5.checked, false);
  assert.equal(page.status.textContent, '当前：跟随系统设置');
  assert.equal(page.image.src, 'icon/other.svg');
  assert.equal(page.image.alt, '当前代理：跟随系统设置');
});

test('弹窗刷新失败时隐藏旧图标', async t => {
  t.mock.method(console, 'error', () => {});
  const page = await openPopup();
  page.setGet(async () => { throw new Error('模拟读取失败'); });
  page.emit(localSocks());
  await flush();

  assert.equal(page.image.hidden, true);
  assert.equal(page.image.alt, '');
  assert.equal(page.status.textContent, '读取代理状态失败，请重新打开弹窗');
});

test('无痕弹窗不读取或监听代理，也不显示默认直连图标', async () => {
  const page = await openPopup(true);
  assert.equal(page.reads(), 0);
  assert.equal(page.listeners(), 0);
  assert.equal(page.image.hidden, true);
  assert.equal(page.image.alt, '');
  assert.equal(page.status.textContent, '请在普通窗口中切换代理');
});
