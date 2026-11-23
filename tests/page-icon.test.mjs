import assert from 'node:assert/strict';
import test from 'node:test';

import { startProxyStatusIconSync } from '../dist/ui.js';
import { createImage, flush, localSocks, proxyResult } from './helpers.mjs';

function openPageIcon({ get = async () => proxyResult({ mode: 'direct' }), incognito = false } = {}) {
  let listener;
  let reads = 0;
  let listeners = 0;
  globalThis.chrome = {
    extension: { inIncognitoContext: incognito },
    proxy: {
      settings: {
        onChange: { addListener(callback) { listener = callback; listeners++; } },
        get() {
          reads++;
          return get();
        },
      },
    },
  };
  const image = createImage();
  startProxyStatusIconSync(image);
  return {
    image,
    emit(value) { listener(proxyResult(value)); },
    reads: () => reads,
    listeners: () => listeners,
  };
}

test('页面启动时使用当前 SOCKS5 空心图标和替代文本', async () => {
  const { image } = openPageIcon({ get: async () => proxyResult(localSocks()) });
  await flush();

  assert.equal(image.src, 'icon/socks5.svg');
  assert.equal(image.alt, '当前代理：本机 SOCKS5');
  assert.equal(image.hidden, false);
  assert.equal(image.assignments, 1);
});

test('页面品牌图随实际代理模式切换，相同模式不重复设置图片', async () => {
  let value = { mode: 'direct' };
  const { image, emit } = openPageIcon({ get: async () => proxyResult(value) });
  await flush();
  assert.equal(image.src, 'icon/icon.svg');
  assert.equal(image.alt, '当前代理：直连');
  assert.equal(image.hidden, false);
  assert.equal(image.assignments, 0);

  value = localSocks();
  emit(value);
  assert.equal(image.src, 'icon/socks5.svg');
  assert.equal(image.alt, '当前代理：本机 SOCKS5');
  assert.equal(image.assignments, 1);

  emit(value);
  assert.equal(image.assignments, 1);

  value = { mode: 'system' };
  emit(value);
  assert.equal(image.src, 'icon/other.svg');
  assert.equal(image.alt, '当前代理：跟随系统设置');
  assert.equal(image.assignments, 2);

  value = { mode: 'auto_detect' };
  emit(value);
  assert.equal(image.src, 'icon/other.svg');
  assert.equal(image.alt, '当前代理：其他代理模式');
  assert.equal(image.assignments, 2);
});

test('慢返回的启动状态不会覆盖事件带来的页面新图标', async () => {
  const pending = [];
  const { image, emit } = openPageIcon({
    get: () => new Promise(resolve => pending.push(resolve)),
  });
  assert.equal(pending.length, 1);

  emit(localSocks());
  assert.equal(image.src, 'icon/socks5.svg');

  pending[0](proxyResult({ mode: 'direct' }));
  await flush();
  assert.equal(image.src, 'icon/socks5.svg');
  assert.equal(image.alt, '当前代理：本机 SOCKS5');
});

test('状态读取失败时隐藏图标，后续事件仍能恢复', async t => {
  t.mock.method(console, 'error', () => {});
  const { image, emit } = openPageIcon({ get: async () => { throw new Error('模拟读取失败'); } });
  await flush();

  assert.equal(image.hidden, true);
  assert.equal(image.alt, '');
  assert.equal(image.assignments, 0);

  emit(localSocks());
  assert.equal(image.hidden, false);
  assert.equal(image.src, 'icon/socks5.svg');
  assert.equal(image.alt, '当前代理：本机 SOCKS5');
});

test('无痕页面不读取或监听代理状态，也不显示直连图标', async () => {
  const page = openPageIcon({ incognito: true });
  await flush();

  assert.equal(page.reads(), 0);
  assert.equal(page.listeners(), 0);
  assert.equal(page.image.src, 'icon/icon.svg');
  assert.equal(page.image.hidden, true);
  assert.equal(page.image.alt, '');
});
