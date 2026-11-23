import assert from 'node:assert/strict';
import test from 'node:test';

import { queue } from '../dist/worker/queue.js';
import { createEventRegistry, createProxyIndicatorMock, createStorage, onlyArchive, waitFor } from './helpers.mjs';

const drain = () => new Promise(resolve => queue.run(async () => resolve()));
const tab = (id, groupId = -1) => ({ id, groupId, index: id - 1, windowId: 1, url: `https://example.com/${id}`, title: String(id) });

async function start(name, tabs) {
  const { listeners, tabEvents, groupEvents } = createEventRegistry();
  const local = createStorage({ 'tabg:meta': { lastInitAt: Date.now() } });
  globalThis.chrome = {
    ...createProxyIndicatorMock(),
    tabs: {
      async query({ groupId }) { return groupId === undefined ? [...tabs] : tabs.filter(tab => tab.groupId === groupId); },
      ...tabEvents,
    },
    tabGroups: groupEvents,
    storage: { local },
  };
  await import(`../dist/worker/index.js?${name}`);
  await drain();
  return { listeners, local };
}

test('批量新建并导航时每个待查标签只查一次，仍保留新窗口判断', async t => {
  const tabs = Array.from({ length: 20 }, (_, i) => tab(i + 1));
  const { listeners } = await start('batch', tabs);
  const queries = t.mock.method(chrome.tabs, 'query').mock;
  chrome.windows = { getAll: t.mock.fn(async () => []) };
  for (const item of tabs) {
    listeners.created(item);
    listeners.updated(item.id, { url: item.url }, item);
  }
  await drain();
  assert.equal(queries.callCount(), tabs.length);
  assert.equal(chrome.windows.getAll.mock.callCount(), 1);
});

test('读取设置期间关闭一批标签，不再为它们读取设置或查询全部标签', async t => {
  const tabs = Array.from({ length: 20 }, (_, i) => tab(i + 2));
  const { listeners, local } = await start('closed', tabs);
  const reads = t.mock.method(local, 'get').mock;
  const queries = t.mock.method(chrome.tabs, 'query').mock;
  let finishRead;
  reads.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  for (const item of tabs) listeners.created(item);
  await waitFor(() => !!finishRead);
  for (const item of tabs.splice(0)) listeners.removed(item.id, { isWindowClosing: false });
  finishRead({});
  await drain();
  assert.equal(reads.callCount(), 1);
  assert.equal(queries.callCount(), 0);
});

for (const read of ['设置', '标签']) {
  test(`合并事件首次读取${read}失败时，导航事件仍可完成去重`, async t => {
    const tabs = [tab(1), { ...tab(2), url: tab(1).url }];
    const { listeners, local } = await start(`read-failure-${read}`, tabs);
    t.mock.method(console, 'error', () => {});
    const mock = read === '设置' ? t.mock.method(local, 'get') : t.mock.method(chrome.tabs, 'query');
    mock.mock.mockImplementationOnce(async () => { throw new Error('模拟读取失败'); });
    const removed = [];
    chrome.tabs.update = async () => {};
    chrome.tabs.remove = async id => { removed.push(id); };
    listeners.created(tabs[1]);
    listeners.updated(2, { url: tabs[1].url }, tabs[1]);
    await waitFor(() => removed.length > 0);
    assert.deepEqual(removed, [2]);
  });
}

test('去重查询已开始时再导航，仍检查新网址', async () => {
  const tabs = [tab(1), tab(2)];
  const { listeners } = await start('navigate', tabs);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const removed = [];
  let queries = 0;
  chrome.tabs.query = async () => {
    const snapshot = structuredClone(tabs);
    if (++queries === 1) await pending;
    return snapshot;
  };
  chrome.tabs.update = async () => {};
  chrome.tabs.remove = async id => { removed.push(id); };
  listeners.created(tabs[1]);
  await waitFor(() => queries === 1);
  tabs[1].url = tabs[0].url;
  listeners.updated(2, { url: tabs[1].url }, tabs[1]);
  release();
  await drain();
  assert.equal(queries, 2);
  assert.deepEqual(removed, [2]);
});

test('去重过程中从重复网址导航到新网址，旧结果不会关闭标签', async () => {
  const tabs = [tab(1), { ...tab(2), url: tab(1).url }];
  const { listeners } = await start('navigate-away', tabs);
  let finishActivation;
  chrome.tabs.update = () => new Promise(resolve => { finishActivation = resolve; });
  const removed = [];
  chrome.tabs.remove = async id => { removed.push(id); };
  listeners.created(tabs[1]);
  await waitFor(() => !!finishActivation);
  tabs[1].url = 'https://example.com/next';
  listeners.updated(2, { url: tabs[1].url }, tabs[1]);
  finishActivation();
  await drain();
  assert.deepEqual(removed, []);
});

test('等激活时旧标签已导航，不会关闭原网址的最后一个标签', async () => {
  const tabs = [tab(1), { ...tab(2), url: tab(1).url }];
  const { listeners } = await start('target-navigated', tabs);
  let finishActivation;
  chrome.tabs.update = () => new Promise(resolve => { finishActivation = resolve; });
  const removed = [];
  chrome.tabs.remove = async id => { removed.push(id); };
  listeners.created(tabs[1]);
  await waitFor(() => !!finishActivation);
  tabs[0].url += '#next';
  listeners.updated(1, { url: tabs[0].url }, tabs[0]);
  finishActivation();
  await drain();
  assert.deepEqual(removed, []);
});

test('后台导航不新排去重，当前标签导航仍执行', async t => {
  const tabs = [tab(1), tab(2), { ...tab(3), active: true }];
  const { listeners } = await start('background-navigation', tabs);
  const queries = t.mock.method(chrome.tabs, 'query').mock;
  const activated = [];
  const removed = [];
  chrome.tabs.update = async id => { activated.push(id); };
  chrome.tabs.remove = async id => { removed.push(id); };
  chrome.windows = { async get() { return { focused: true }; } };
  tabs[1].url = tabs[0].url;

  listeners.updated(2, { url: tabs[1].url }, { ...tabs[1], active: false });
  await drain();
  assert.equal(queries.callCount(), 0);
  assert.deepEqual(activated, []);
  assert.deepEqual(removed, []);

  listeners.updated(2, { url: tabs[1].url }, { ...tabs[1], active: true });
  await drain();
  assert.equal(queries.callCount(), 1);
  assert.deepEqual(activated, [1]);
  assert.deepEqual(removed, [2]);
});

test('后台窗口的选中标签导航不触发去重或聚焦其他窗口', async t => {
  const existing = tab(1);
  const source = { ...tab(2), active: true, windowId: 2, url: existing.url };
  const { listeners } = await start('unfocused-window-navigation', [existing, source]);
  const queries = t.mock.method(chrome.tabs, 'query').mock;
  const focused = [];
  let focusReads = 0;
  chrome.windows = {
    async get() { focusReads++; return { focused: false }; },
    async update(id) { focused.push(id); },
  };

  listeners.updated(source.id, { url: source.url }, source);
  await drain();

  assert.equal(focusReads, 1);
  assert.equal(queries.callCount(), 0);
  assert.deepEqual(focused, []);
});

test('查询期间关闭新标签页，不再根据旧结果关闭另一个新标签页', async () => {
  const tabs = [1, 2].map(id => ({ ...tab(id), url: 'chrome://newtab/' }));
  const { listeners } = await start('source-closed', tabs);
  let finishQuery;
  chrome.tabs.query = () => new Promise(resolve => { finishQuery = resolve; });
  const removed = [];
  chrome.tabs.remove = async id => { removed.push(id); };
  listeners.created(tabs[1]);
  await waitFor(() => !!finishQuery);
  listeners.removed(2, { isWindowClosing: false });
  finishQuery(tabs);
  await drain();
  assert.deepEqual(removed, []);
});

test('全屏吸附读取源窗口期间导航到切换页，不能按旧窗口内容移动', async () => {
  const item = tab(1);
  const { listeners } = await start('late-switch', [item]);
  chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
  let finishWindow;
  chrome.windows = {
    async getAll() { return [{ id: 2, type: 'normal', state: 'fullscreen' }]; },
    get() { return new Promise(resolve => { finishWindow = resolve; }); },
  };
  const moves = [];
  chrome.tabs.move = async id => { moves.push(id); };
  listeners.created(item);
  await waitFor(() => !!finishWindow);
  const url = chrome.runtime.getURL('switch.html?mode=direct');
  listeners.updated(1, { url }, { ...item, url });
  finishWindow({ type: 'normal', state: 'normal', tabs: [item] });
  await drain();
  assert.deepEqual(moves, []);
});

test('查询前已导航到切换页，取消原来的创建任务', async t => {
  const item = tab(1);
  const { listeners } = await start('queued-switch', [item]);
  chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
  const queries = t.mock.method(chrome.tabs, 'query').mock;
  listeners.created(item);
  const url = chrome.runtime.getURL('switch.html?mode=direct');
  listeners.updated(1, { url }, { ...item, url });
  await drain();
  assert.equal(queries.callCount(), 0);
});

test('待备份组被删除后同一编号再次入组，先归档旧组，再备份新组', async () => {
  const tabs = [tab(1, 0)];
  const { listeners, local } = await start('reuse', tabs);
  listeners.groupUpdated({ id: 0, title: '旧组', color: 'blue' });
  await drain();
  listeners.moved(1, {});
  listeners.groupRemoved({ id: 0 });
  tabs[0] = tab(2, 0);
  listeners.groupUpdated({ id: 0, title: '新组', color: 'red' });
  await drain();
  assert.equal(onlyArchive(local, 0).tabs[0].title, '1');
  assert.equal(local.data['tabg:g:0'].tabs[0].title, '2');
});

test('仅调整组内顺序也会更新快照，随后归档保留新顺序', async () => {
  const tabs = [tab(1, 7), tab(2, 7), tab(3, 7)];
  const { listeners, local } = await start('reorder', tabs);
  listeners.groupUpdated({ id: 7, title: '排序', color: 'blue' });
  await drain();
  const titles = snapshot => snapshot.tabs.map(tab => tab.title);
  assert.deepEqual(titles(local.data['tabg:g:7']), ['1', '2', '3']);

  [tabs[1].index, tabs[2].index] = [tabs[2].index, tabs[1].index];
  listeners.moved(3, { windowId: 1, fromIndex: 2, toIndex: 1 });
  await drain();
  assert.deepEqual(titles(local.data['tabg:g:7']), ['1', '3', '2']);

  tabs.length = 0;
  listeners.groupRemoved({ id: 7 });
  await drain();
  assert.deepEqual(titles(onlyArchive(local, 7)), ['1', '3', '2']);
});
