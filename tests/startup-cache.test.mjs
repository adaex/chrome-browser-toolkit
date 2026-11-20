import assert from 'node:assert/strict';
import test from 'node:test';

import { formerGroupOf } from '../dist/worker/groupCache.js';
import { createEventRegistry, createProxyIndicatorMock, createStorage, flush } from './helpers.mjs';

async function pauseInitialQuery(name, latestTabs = []) {
  const { listeners, tabEvents, groupEvents } = createEventRegistry();
  const counts = { tabs: 0, groups: 0 };
  let resolveInitial;
  const initialQuery = new Promise(resolve => { resolveInitial = resolve; });
  const local = createStorage({ 'tabg:meta': { lastInitAt: Date.now() } });
  globalThis.chrome = {
    ...createProxyIndicatorMock(),
    tabs: { ...tabEvents, async query() { return ++counts.tabs === 1 ? initialQuery : latestTabs; } },
    tabGroups: { ...groupEvents, async query() { counts.groups++; return []; } },
    storage: { local },
  };
  await import(`../dist/worker/index.js?${name}`);
  return { listeners, resolveInitial, counts };
}

test('onCreated 写入的归属不会被稍晚返回的启动旧快照清掉', async () => {
  const { listeners, resolveInitial } = await pauseInitialQuery('created');
  listeners.created({ id: 100, groupId: 5, index: 1, windowId: 1 });
  resolveInitial([]);
  await flush();

  assert.equal(formerGroupOf(100), 5);
});

for (const [name, id, changeInfo, expected] of [
  ['图标更新不触发全量对账', 101, { favIconUrl: 'https://example.invalid/icon.png' }, { tabs: 1, groups: 0 }],
  ['离组时仍重新查询并对账', 102, { groupId: -1 }, { tabs: 2, groups: 1 }],
]) {
  test(`启动查询返回前，${name}`, async () => {
    const tab = { id, groupId: -1 };
    const { listeners, resolveInitial, counts } = await pauseInitialQuery(id, [tab]);
    listeners.updated(id, changeInfo, tab);
    resolveInitial([]);
    await flush();
    assert.deepEqual(counts, expected);
    assert.equal(formerGroupOf(id), -1);
  });
}
