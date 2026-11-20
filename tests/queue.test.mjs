import assert from 'node:assert/strict';
import test from 'node:test';

import { Queue } from '../dist/worker/queue.js';
import { flush } from './helpers.mjs';

test('同一队列按顺序执行，等待期间不阻塞其他队列', async () => {
  const tabs = new Queue();
  const proxy = new Queue();
  const calls = [];
  let release;
  tabs.run(async () => {
    calls.push('开始备份');
    await new Promise(resolve => { release = resolve; });
    calls.push('完成备份');
  });
  tabs.run(async () => { calls.push('检查标签'); });
  proxy.run(async () => { calls.push('切换代理'); });
  await flush();
  assert.deepEqual(calls, ['开始备份', '切换代理']);

  release();
  await flush();
  assert.deepEqual(calls, ['开始备份', '切换代理', '完成备份', '检查标签']);
});

test('同步抛错和异步失败都不影响后续任务', async t => {
  const queue = new Queue();
  const errors = t.mock.method(console, 'error', () => {}).mock;
  queue.run(() => { throw new Error('模拟同步失败'); });
  queue.run(async () => { throw new Error('模拟异步失败'); });
  let continued = false;
  queue.run(async () => { continued = true; });
  await flush();
  assert.equal(continued, true);
  assert.equal(errors.callCount(), 2);
});
