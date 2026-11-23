import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';

import { loadFeatureSettings } from '../dist/worker/settings.js';
import { createImage, createProxyIndicatorMock, createStorage, flush } from './helpers.mjs';

let pageId = 0;

async function openOptions(local, incognito = false) {
  const nodes = new Map();
  const downloads = [];
  const page = new EventTarget();
  globalThis.window = page;
  function element(selector) {
    if (!nodes.has(selector)) {
      const node = selector === '#proxy-status-icon'
        ? createImage()
        : Object.assign(new EventTarget(), {
            textContent: '', checked: false, disabled: false, classList: { toggle() {} },
            click() { if (!this.disabled) this.dispatchEvent(new Event('click')); },
          });
      nodes.set(selector, node);
    }
    return nodes.get(selector);
  }
  globalThis.chrome = {
    ...createProxyIndicatorMock(),
    storage: { local },
    extension: { inIncognitoContext: incognito },
  };
  globalThis.document = Object.assign(new EventTarget(), {
    querySelector: element,
    createElement(tag) {
      assert.equal(tag, 'a');
      return { click() { downloads.push(resolveObjectURL(this.href)); } };
    },
  });
  await import(`../dist/options.js?page=${++pageId}`);
  await flush();
  return { element, downloads, page };
}

function change(input, checked) {
  input.checked = checked;
  input.dispatchEvent(new Event('change'));
}

function toggleDetails(details, open) {
  details.open = open;
  details.dispatchEvent(new Event('toggle'));
}

test('两个设置页各改一个开关不会互相覆盖，另一页只在切回时重新读取', async t => {
  const legacy = { deduplicate: false, fullscreen: true };
  const local = createStorage({ featureSettings: legacy });
  const first = await openOptions(local);
  const second = await openOptions(local);
  assert.equal(first.element('#deduplicate').checked, false);
  assert.equal(second.element('#fullscreen').checked, true);

  const reads = t.mock.method(local, 'get').mock;
  change(first.element('#deduplicate'), true);
  change(second.element('#fullscreen'), false);
  await flush();
  assert.equal(reads.callCount(), 0);
  assert.equal(first.element('#fullscreen').checked, true);
  assert.equal(second.element('#deduplicate').checked, false);

  first.page.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(reads.callCount(), 1);
  assert.equal(first.element('#fullscreen').checked, false);
  assert.deepEqual(await loadFeatureSettings(), { deduplicate: true, fullscreen: false });
  assert.deepEqual(local.data.featureSettings, legacy);
});

test('读取设置期间点选一个开关，旧读数不盖掉输入，另一个开关仍显示并保留已保存的值', async () => {
  const local = createStorage({ featureSettings: { deduplicate: false, fullscreen: true } });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const get = local.get;
  local.get = async keys => {
    const stored = await get(keys);
    if ([keys].flat().includes('featureSettings')) await pending;
    return stored;
  };
  const { element } = await openOptions(local);
  change(element('#deduplicate'), true);
  await flush();
  release();
  await flush();

  assert.equal(element('#deduplicate').checked, true);
  assert.equal(element('#fullscreen').checked, true);
  assert.deepEqual(await loadFeatureSettings(), { deduplicate: true, fullscreen: true });
});

test('同一开关连续改动，前一次保存完成后的页面刷新不盖掉待保存的输入', async t => {
  const local = createStorage();
  const { element, page } = await openOptions(local);
  const input = element('#deduplicate');
  const save = local.set;
  let finishSecond;
  t.mock.method(local, 'set', async values => {
    if (values['featureSettings.deduplicate']) await new Promise(resolve => { finishSecond = resolve; });
    return save(values);
  });
  change(input, false);
  change(input, true);
  await flush();
  assert.equal(local.data['featureSettings.deduplicate'], false);
  page.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(input.checked, true);
  finishSecond();
  await flush();
  assert.equal(local.data['featureSettings.deduplicate'], true);
});

test('保存途中切回设置页，迟到的旧读数不盖掉刚保存的开关', async t => {
  const local = createStorage();
  const { element, page } = await openOptions(local);
  const input = element('#deduplicate');
  let finishWrite, finishRead;
  const set = local.set;
  t.mock.method(local, 'set', async values => {
    await new Promise(resolve => { finishWrite = resolve; });
    await set(values);
  });
  t.mock.method(local, 'get', () => new Promise(resolve => { finishRead = resolve; }));
  change(input, false);
  await flush();
  page.dispatchEvent(new Event('focus'));
  finishWrite();
  await flush();
  finishRead({});
  await flush();
  assert.equal(input.checked, false);
  assert.equal(local.data['featureSettings.deduplicate'], false);
});

test('标签页重新可见但焦点仍在地址栏时也加载最新开关', async () => {
  const local = createStorage();
  const { element } = await openOptions(local);
  local.data['featureSettings.fullscreen'] = false;
  Object.assign(document, { visibilityState: 'visible', hasFocus: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(element('#fullscreen').checked, false);
});

test('设置读取重试成功后清除上次的错误提示', async t => {
  const local = createStorage();
  const { element, page } = await openOptions(local);
  t.mock.method(console, 'error', () => {});
  t.mock.method(local, 'get').mock.mockImplementationOnce(async () => { throw new Error('模拟读取失败'); });
  page.dispatchEvent(new Event('focus'));
  await flush();
  assert.match(element('#feature-status').textContent, /读取设置失败/);
  page.dispatchEvent(new Event('focus'));
  await flush();
  assert.doesNotMatch(element('#feature-status').textContent, /失败/);
});

test('没有独立布尔值时沿用旧值，仅显式 false 关闭，读取不迁移数据', async () => {
  const local = createStorage();
  globalThis.chrome = { storage: { local } };
  assert.deepEqual(await loadFeatureSettings(), { deduplicate: true, fullscreen: true });
  local.data.featureSettings = { deduplicate: false, fullscreen: 0 };
  local.data['featureSettings.deduplicate'] = 'invalid';
  assert.deepEqual(await loadFeatureSettings(), { deduplicate: false, fullscreen: true });
  assert.deepEqual(local.writes, []);
});

test('计数期间展开预览，旧计数先返回也要等预览读完才能刷新', async t => {
  const local = createStorage({ 'tabg:a:1:100:00000000-0000-4000-8000-000000000000': { title: '归档' } });
  const { element } = await openOptions(local);
  let finishListing, finishPreview;
  t.mock.method(local, 'getKeys', () => new Promise(resolve => { finishListing = resolve; }));
  const reads = t.mock.method(local, 'get').mock;
  reads.mockImplementationOnce(() => new Promise(resolve => { finishPreview = resolve; }));

  const refresh = element('#refresh');
  refresh.click();
  toggleDetails(element('#backup-details'), true);
  finishListing(Object.keys(local.data));
  await flush();
  assert.match(element('#backup-status').textContent, /正在读取/);
  assert.equal(refresh.disabled, true);
  refresh.click();
  assert.equal(reads.callCount(), 1);

  finishPreview({ ...local.data });
  await flush();
  assert.equal(refresh.disabled, false);
  assert.deepEqual(JSON.parse(element('#backup-output').textContent), local.data);
});

test('预览已展开时连点刷新只读一次，读取失败后可以重试', async t => {
  const local = createStorage({ 'tabg:a:1:100:00000000-0000-4000-8000-000000000000': { title: '归档' } });
  const { element } = await openOptions(local);
  toggleDetails(element('#backup-details'), true);
  await flush();

  let rejectRead;
  const reads = t.mock.method(local, 'get').mock;
  reads.mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }));
  t.mock.method(console, 'error', () => {});
  const refresh = element('#refresh');
  for (let i = 0; i < 4; i++) refresh.click();
  assert.equal(reads.callCount(), 1);
  assert.equal(refresh.disabled, true);

  rejectRead(new Error('模拟读取失败'));
  await flush();
  assert.match(element('#backup-status').textContent, /读取备份失败/);
  assert.equal(refresh.disabled, false);
  refresh.click();
  await flush();
  assert.equal(reads.callCount(), 2);
  assert.equal(refresh.disabled, false);
  assert.deepEqual(JSON.parse(element('#backup-output').textContent), local.data);
});

test('无痕设置页不会枚举、显示或导出普通窗口的备份', async t => {
  const local = createStorage({ 'tabg:g:1': { title: '普通窗口' } });
  const enumerate = t.mock.method(local, 'getKeys').mock;
  const reads = t.mock.method(local, 'get').mock;
  const { element, downloads } = await openOptions(local, true);
  element('#refresh').dispatchEvent(new Event('click'));
  element('#export').dispatchEvent(new Event('click'));
  toggleDetails(element('#backup-details'), true);
  await flush();
  assert.equal(enumerate.callCount(), 0);
  assert.ok(reads.calls.every(({ arguments: [keys] }) => keys != null && ![keys].flat().includes('tabg:g:1')));
  assert.deepEqual(downloads, []);
  assert.equal(element('#backup-output').textContent, '');
});

test('一个开关写入失败，另一个保存成功后仍提示需要重试的开关', async t => {
  const local = createStorage({}, { failSet: values => 'featureSettings.deduplicate' in values });
  t.mock.method(console, 'error', () => {});
  const { element } = await openOptions(local);
  change(element('#deduplicate'), false);
  change(element('#fullscreen'), false);
  await flush();
  assert.match(element('#feature-status').textContent, /未能保存.*合并相同网址/);
  assert.deepEqual(await loadFeatureSettings(), { deduplicate: true, fullscreen: false });
});

test('预览未刷新时，导出的 JSON 仍是点击时的最新备份', async () => {
  const key = 'tabg:g:1';
  const local = createStorage({ [key]: { title: '原组名' } });
  const { element, downloads } = await openOptions(local);
  toggleDetails(element('#backup-details'), true);
  await flush();
  await local.set({ [key]: { title: '新组名' } });
  element('#export').click();
  await flush();
  assert.equal(JSON.parse(element('#backup-output').textContent)[key].title, '原组名');
  assert.equal(JSON.parse(await downloads[0].text())[key].title, '新组名');
});

test('并发刷新晚于导出失败返回时，保留导出错误提示', async t => {
  const local = createStorage();
  const { element } = await openOptions(local);
  let finish;
  t.mock.method(local, 'getKeys', () => new Promise(resolve => { finish = resolve; }));
  t.mock.method(local, 'get', async () => { throw new Error('模拟读取失败'); });
  t.mock.method(console, 'error', () => {});
  element('#refresh').click();
  element('#export').click();
  await flush();
  finish([]);
  await flush();
  assert.match(element('#export-status').textContent, /导出备份失败/);
  assert.match(element('#backup-status').textContent, /已找到/);
});

for (const hasGetKeys of [true, false]) {
  test(`收起时只计数，展开、刷新和导出按需读取新旧备份（getKeys=${hasGetKeys}）`, async t => {
    const backups = {
      'tabg:g:1': { title: '存活组' },
      'tabg:a:1:100:00000000-0000-4000-8000-000000000000': { title: '归档' },
      tabGroupBackup: { groups: {} },
    };
    const local = createStorage({ ...backups, 'tabg:meta': {}, proxyPort: 8080 });
    if (!hasGetKeys) delete local.getKeys;
    const enumerate = hasGetKeys ? t.mock.method(local, 'getKeys').mock : undefined;
    const get = t.mock.method(local, 'get').mock;
    const stringify = t.mock.method(JSON, 'stringify').mock;
    const { element, downloads } = await openOptions(local);
    const output = element('#backup-output');
    const status = element('#backup-status');
    assert.match(status.textContent, /1 份组快照、1 条历史归档.*旧版/);
    assert.equal(output.textContent, '');
    assert.equal(stringify.callCount(), 0);
    const backupReads = get.calls.map(call => call.arguments[0]).filter(keys =>
      keys == null || [keys].flat().some(key => Object.hasOwn(backups, key)));
    assert.deepEqual(backupReads, hasGetKeys ? [] : [null]);
    if (hasGetKeys) assert.equal(enumerate.callCount(), 1);

    backups['tabg:a:2:200:00000000-0000-4000-8000-000000000001'] = local.data['tabg:a:2:200:00000000-0000-4000-8000-000000000001'] = { title: '新归档' };
    get.resetCalls();
    element('#refresh').click();
    await flush();
    assert.match(status.textContent, /2 条历史归档/);
    assert.deepEqual(get.calls.map(call => call.arguments[0]), hasGetKeys ? [] : [null]);
    assert.equal(stringify.callCount(), 0);

    const details = element('#backup-details');
    toggleDetails(details, true);
    await flush();
    assert.deepEqual(JSON.parse(output.textContent), backups);
    assert.equal(get.calls.at(-1).arguments[0], null);

    backups['tabg:g:1'] = local.data['tabg:g:1'] = { title: '更新组名' };
    element('#refresh').click();
    await flush();
    assert.deepEqual(JSON.parse(output.textContent), backups);
    toggleDetails(details, false);
    assert.equal(output.textContent, '');

    delete backups['tabg:g:1'];
    delete local.data['tabg:g:1'];
    element('#export').click();
    await flush();
    assert.deepEqual(JSON.parse(await downloads[0].text()), backups);
    assert.equal(local.data.proxyPort, 8080);
    assert.equal(output.textContent, '');
  });
}
