import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventRegistry, createProxyIndicatorMock, createStorage, flush, snapshot } from './helpers.mjs';

test('启动标签查询失败时中止对账并保留旧快照', async () => {
  const { tabEvents, groupEvents } = createEventRegistry();
  const local = createStorage({ 'tabg:g:1': snapshot });
  let groupQueries = 0;
  globalThis.chrome = {
    ...createProxyIndicatorMock(),
    tabs: {
      async query() { throw new Error('模拟启动查询失败'); },
      ...tabEvents,
    },
    tabGroups: {
      ...groupEvents,
      async query() {
        groupQueries++;
        return [];
      },
    },
    storage: { local },
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await import('../dist/worker/index.js');
    await flush();
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.equal(groupQueries, 0);
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
});
