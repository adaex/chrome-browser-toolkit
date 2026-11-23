import assert from 'node:assert/strict';
import test from 'node:test';

import { archiveGroup, backupGroup, initBackupAllGroups, readBackups } from '../dist/worker/backup.js';
import { forgetGroupObject, noteGroupObject } from '../dist/worker/groupCache.js';
import { createStorage, group, onlyArchive, snapshot } from './helpers.mjs';

test('归档写入失败时保留旧 active 快照', async () => {
  let failed = true;
  const local = createStorage(
    { 'tabg:meta': { lastInitAt: 0 }, 'tabg:g:1': snapshot },
    { failSet: values => failed && Object.keys(values).some(key => key.startsWith('tabg:a:')) },
  );
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return []; } },
  };

  await assert.rejects(initBackupAllGroups([], false));
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
  assert.equal(local.removals.length, 0);
  failed = false;
  await archiveGroup(group.id);
});

test('旧组归档失败期间保留快照，恢复后才允许同编号的新组写入', async () => {
  let failed = true;
  const local = createStorage({ 'tabg:g:11': { ...snapshot, id: 11 } }, {
    failSet: values => failed && Object.keys(values).some(key => key.startsWith('tabg:a:')),
  });
  globalThis.chrome = { storage: { local }, tabs: { async query() { return snapshot.tabs; } } };
  noteGroupObject({ ...group, id: 11, title: '新组' });
  await assert.rejects(archiveGroup(11));
  await assert.rejects(backupGroup(11));
  assert.equal(local.data['tabg:g:11'].title, snapshot.title);
  failed = false;
  await backupGroup(11);
  assert.equal(onlyArchive(local, 11).title, snapshot.title);
  assert.equal(local.data['tabg:g:11'].title, '新组');
});

test('归档失败后重启也会先保留旧组，再写同编号的新组', async () => {
  let failed = true;
  const oldSnapshot = { ...snapshot, id: 21, title: '旧组' };
  const local = createStorage(
    { 'tabg:meta': { lastInitAt: Date.now() }, 'tabg:g:21': oldSnapshot },
    { failSet: values => failed && Object.keys(values).some(key => key.startsWith('tabg:a:')) },
  );
  globalThis.chrome = { storage: { local } };
  const beforeRestart = await import('../dist/worker/backup.js?pending-before-restart');
  await assert.rejects(beforeRestart.archiveGroup(21));
  assert.equal(local.data['tabg:p:21'], true);

  failed = false;
  const currentGroup = { ...group, id: 21, title: '新组' };
  globalThis.chrome = { storage: { local }, tabGroups: { async query() { return [currentGroup]; } } };
  const afterRestart = await import('../dist/worker/backup.js?pending-after-restart');
  await afterRestart.initBackupAllGroups([
    { groupId: 21, index: 0, url: 'https://new.example/', title: '新标签' },
  ], false);

  assert.equal(onlyArchive(local, 21).title, '旧组');
  assert.equal(local.data['tabg:g:21'].title, '新组');
  assert.equal(local.data['tabg:p:21'], undefined);
});

test('待归档标记落盘后才读取 active', async () => {
  const local = createStorage({ 'tabg:g:31': { ...snapshot, id: 31 } });
  const get = local.get;
  const set = local.set;
  const operations = [];
  local.set = async values => {
    operations.push('set:start');
    await set(values);
    operations.push('set:end');
  };
  local.get = async keys => {
    operations.push('get');
    return get(keys);
  };
  globalThis.chrome = { storage: { local } };

  await archiveGroup(31);
  assert.deepEqual(operations.slice(0, 3), ['set:start', 'set:end', 'get']);
});

test('单组备份恢复待归档标记时不全量读取归档', async () => {
  const oldSnapshot = { ...snapshot, id: 41, title: '旧组' };
  const local = createStorage({
    'tabg:g:41': oldSnapshot,
    'tabg:p:41': true,
    'tabg:a:40:1700000000000:00000000-0000-4000-8000-000000000000': { title: '既有归档' },
  });
  local.getKeys = undefined;
  const get = local.get;
  const reads = [];
  local.get = async keys => {
    reads.push(keys);
    return get(keys);
  };
  const currentGroup = { ...group, id: 41, title: '新组' };
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [{ groupId: 41, index: 0, url: 'https://new.example/', title: '新标签' }]; } },
    tabGroups: { async get() { return currentGroup; } },
  };
  const backup = await import('../dist/worker/backup.js?pending-single-group');

  await backup.backupGroup(41);

  assert.equal(reads[0], 'tabg:p:41');
  assert.equal(reads.includes(null), false);
  assert.equal(onlyArchive(local, 41).title, '旧组');
  assert.equal(local.data['tabg:g:41'].title, '新组');
});

for (const pending of [true, false]) {
  test(`一个组归档失败时不会提前启动其他组的归档（pending=${pending}）`, async () => {
    const first = { ...snapshot, id: 31, title: '组 31' };
    const second = { ...snapshot, id: 32, title: '组 32' };
    const local = createStorage({
      'tabg:g:31': first,
      'tabg:g:32': second,
      ...(pending ? { 'tabg:p:31': true, 'tabg:p:32': true } : {}),
    });
    const set = local.set;
    let failed = true;
    const writes = [];
    local.set = async values => {
      const keys = Object.keys(values);
      writes.push(keys);
      if (failed && keys.some(key => key.startsWith('tabg:a:31:'))) throw new Error('模拟组 31 归档失败');
      return set(values);
    };
    globalThis.chrome = {
      storage: { local },
      tabGroups: { async query() { return []; } },
    };
    const backup = await import(`../dist/worker/backup.js?archive-order-${pending}`);

    await assert.rejects(backup.initBackupAllGroups([], true));
    const secondStarted = writes.some(keys => keys.includes('tabg:p:32'));
    failed = false;
    await backup.archiveGroup(31);
    await backup.archiveGroup(32);
    assert.equal(secondStarted, false);
  });
}

for (const live of [true, false]) {
  test(`恢复 v2 归档后残留 v1 不会重复或复活同编号快照（live=${live}）`, async () => {
    const v2 = { ...snapshot, id: 33, title: 'v2 新快照' };
    const v1 = { ...snapshot, id: 33, title: 'v1 旧快照' };
    const local = createStorage({
      'tabg:g:33': v2,
      'tabg:p:33': true,
      tabGroupBackup: { version: 1, active: { 33: v1 } },
    });
    globalThis.chrome = {
      storage: { local },
      tabGroups: { async query() { return live ? [{ ...group, id: 33 }] : []; } },
    };
    const backup = await import(`../dist/worker/backup.js?recovery-precedence-${live}`);

    await backup.initBackupAllGroups([], true);
    assert.equal(onlyArchive(local, 33).title, 'v2 新快照');
    assert.equal(local.data['tabg:g:33'], undefined);
    assert.equal(local.data.tabGroupBackup, undefined);
  });
}

test('非法编号或与 active 键不一致的快照不会写到其他组归档', async () => {
  for (const id of [Number.NaN, -1, 1.5, 2]) {
    const local = createStorage({ 'tabg:g:1': { ...snapshot, id } });
    globalThis.chrome = { storage: { local } };
    await archiveGroup(1);

    assert.equal(Object.keys(local.data).some(key => key.startsWith('tabg:a:')), false);
    assert.equal(local.data['tabg:g:1'].id, id);
    assert.equal(local.data['tabg:p:1'], undefined);
  }
});

test('启动对账会纠正 active 键与快照编号不一致的数据', async () => {
  for (const hasGetKeys of [true, false]) {
    const local = createStorage({ 'tabg:g:1': { ...snapshot, id: 2 } });
    if (!hasGetKeys) local.getKeys = undefined;
    globalThis.chrome = { storage: { local }, tabGroups: { async query() { return [group]; } } };
    await initBackupAllGroups([
      { groupId: 1, index: 0, url: 'https://example.com/', title: '当前标签' },
    ], true);

    assert.equal(local.data['tabg:g:1'].id, 1);
    assert.equal(Object.keys(local.data).some(key => key.startsWith('tabg:a:')), false);
  }
});

test('畸形归档键不计数但仍保留供导出', async () => {
  for (const hasGetKeys of [true, false]) {
    const validKey = 'tabg:a:1:1700000000000:00000000-0000-4000-8000-000000000000';
    const local = createStorage({
      [validKey]: { ...snapshot, deletedAt: '2023-11-14T22:13:20.000Z' },
      'tabg:a:not-a-group': { title: '畸形归档' },
      'tabg:a:1': { title: '不完整归档' },
    });
    if (!hasGetKeys) local.getKeys = undefined;
    globalThis.chrome = { storage: { local } };

    assert.equal((await readBackups(false)).archived, 1);
    const { entries } = await readBackups(true);
    assert.equal(entries['tabg:a:not-a-group'].title, '畸形归档');
    assert.equal(entries['tabg:a:1'].title, '不完整归档');
  }
});

test('无法识别的备份格式保留原始数据供导出', async () => {
  for (const legacy of [{ groups: [snapshot] }, { version: 2, active: {}, archived: [snapshot] }]) {
    const local = createStorage({ tabGroupBackup: legacy });
    globalThis.chrome = { storage: { local }, tabGroups: { async query() { return []; } } };
    await initBackupAllGroups([], true);
    assert.deepEqual((await readBackups(true)).entries, { tabGroupBackup: legacy });
  }
});

for (const cached of [true, false]) {
  test(`空组保留最后快照供归档，缓存状态不影响结果（cached=${cached}）`, async () => {
    const local = createStorage({ 'tabg:g:1': snapshot });
    let groupReads = 0;
    globalThis.chrome = {
      storage: { local },
      tabs: { async query() { return []; } },
      tabGroups: {
        async get() {
          groupReads++;
          throw new Error('组已不存在');
        },
      },
    };
    forgetGroupObject(group.id);
    if (cached) noteGroupObject(group);

    await backupGroup(group.id);
    assert.deepEqual(local.data['tabg:g:1'], snapshot);
    await archiveGroup(group.id);

    assert.equal(groupReads, 0);
    assert.equal(local.data['tabg:g:1'], undefined);
    assert.deepEqual(onlyArchive(local, group.id).tabs, snapshot.tabs);
  });
}

test('非空组在缓存 miss 时仍读取组对象并写入快照', async () => {
  const local = createStorage();
  let groupReads = 0;
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [{ id: 2, groupId: 1, url: 'https://example.com/', title: '新' }]; } },
    tabGroups: {
      async get() {
        groupReads++;
        return group;
      },
    },
  };
  forgetGroupObject(group.id);

  await backupGroup(group.id);
  await backupGroup(group.id);

  assert.equal(local.data['tabg:g:1'].title, group.title);
  assert.deepEqual(local.data['tabg:g:1'].tabs, [{ url: 'https://example.com/', title: '新' }]);
  assert.equal(groupReads, 1);
  assert.deepEqual(local.writes, [['tabg:g:1']]);
});

test('单组备份只写变化内容，归档后重建同内容组仍会落盘', async () => {
  const testGroup = { ...group, id: 9 };
  let tab = { id: 90, groupId: 9, url: 'https://example.com/', title: '一' };
  const local = createStorage();
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [tab]; } },
    tabGroups: { async get() { return testGroup; } },
  };
  forgetGroupObject(testGroup.id);

  await backupGroup(testGroup.id);
  await backupGroup(testGroup.id);
  assert.deepEqual(local.writes, [['tabg:g:9']]);

  tab = { ...tab, title: '二' };
  await backupGroup(testGroup.id);
  await backupGroup(testGroup.id);
  assert.deepEqual(local.writes, [['tabg:g:9'], ['tabg:g:9']]);
  assert.equal(local.data['tabg:g:9'].tabs[0].title, '二');

  await archiveGroup(testGroup.id);
  await backupGroup(testGroup.id);
  assert.equal(local.data['tabg:g:9'].tabs[0].title, '二');
  assert.equal(local.writes.filter(keys => keys.includes('tabg:g:9')).length, 3);
});

test('init 部分写入后失败会使内容缓存失效，后续备份不会误跳过', async () => {
  const testGroup = { ...group, id: 10 };
  let tab = { id: 100, groupId: 10, url: 'https://example.com/', title: '旧内容' };
  let failMeta = false;
  const local = createStorage({}, {
    failSet: values => failMeta && Object.keys(values).includes('tabg:meta'),
  });
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [tab]; } },
    tabGroups: {
      async get() { return testGroup; },
      async query() { return [testGroup]; },
    },
  };
  forgetGroupObject(testGroup.id);
  await backupGroup(testGroup.id);

  tab = { ...tab, title: '新内容' };
  failMeta = true;
  await assert.rejects(initBackupAllGroups([tab], true));
  assert.equal(local.data['tabg:g:10'].tabs[0].title, '新内容');

  failMeta = false;
  tab = { ...tab, title: '旧内容' };
  await backupGroup(testGroup.id);
  assert.equal(local.data['tabg:g:10'].tabs[0].title, '旧内容');
});

test('同一组同一毫秒重复归档也不会互相覆盖', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  globalThis.chrome = { storage: { local } };
  const originalNow = Date.now;
  Date.now = () => 1770000000000;
  try {
    await archiveGroup(group.id);
    local.data['tabg:g:1'] = { ...snapshot, title: '第二次' };
    await archiveGroup(group.id);
  } finally {
    Date.now = originalNow;
  }

  const archives = Object.entries(local.data).filter(([key]) => key.startsWith('tabg:a:'));
  assert.equal(archives.length, 2);
  assert.deepEqual(new Set(archives.map(([, value]) => value.title)), new Set(['工作', '第二次']));
});

test('init 对账死组时摘掉旧组对象，复用 id 的新组不会读到旧名称', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return []; } },
  };
  noteGroupObject(group);

  await initBackupAllGroups([], true);

  const newGroup = { ...group, title: '新组' };
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [{ id: 2, groupId: 1, url: 'https://new.example/', title: '新' }]; } },
    tabGroups: { async get() { return newGroup; } },
  };
  await backupGroup(group.id);
  assert.equal(local.data['tabg:g:1'].title, '新组');
  forgetGroupObject(group.id);
});

test('init 查询窗口内变空的组仍保留 active 供随后归档', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return [group]; } },
  };

  await initBackupAllGroups([], true);
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
  await archiveGroup(group.id);

  assert.deepEqual(onlyArchive(local, group.id).tabs, snapshot.tabs);
});

test('缓存回填不覆盖组对象查询期间到达的新状态', async () => {
  const local = createStorage();
  let resolveGet;
  let markGetStarted;
  const getStarted = new Promise(resolve => { markGetStarted = resolve; });
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [{ id: 2, groupId: 1, url: 'https://example.com/', title: '标签' }]; } },
    tabGroups: {
      get() {
        markGetStarted();
        return new Promise(resolve => { resolveGet = resolve; });
      },
    },
  };
  forgetGroupObject(group.id);

  const pending = backupGroup(group.id);
  await getStarted;
  noteGroupObject({ ...group, title: '新组名' });
  resolveGet({ ...group, title: '旧组名' });
  await pending;

  assert.equal(local.data['tabg:g:1'].title, '新组名');
});

test('启动读取 active 期间改名换色，本次对账和随后备份都使用新组信息', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  const updated = { ...group, title: '新组名', color: 'red' };
  const tab = { id: 2, groupId: group.id, ...snapshot.tabs[0] };
  const get = local.get;
  local.get = async keys => {
    const values = await get(keys);
    // 批量读取 active 时，全组查询已经返回旧对象；改名和换色的事件依次到达
    if (Array.isArray(keys)) {
      noteGroupObject({ ...group, title: updated.title });
      noteGroupObject(updated);
    }
    return values;
  };
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [tab]; } },
    tabGroups: { async query() { return [group]; } },
  };

  await initBackupAllGroups([tab], true);
  const active = local.data['tabg:g:1'];
  assert.equal(active.title, updated.title);
  assert.equal(active.color, updated.color);

  await backupGroup(group.id);
  assert.deepEqual(local.writes, [['tabg:g:1'], ['tabg:meta']]);
  forgetGroupObject(group.id);
  await archiveGroup(group.id);
  const archived = onlyArchive(local, group.id);
  assert.equal(archived.title, updated.title);
  assert.equal(archived.color, updated.color);
});

test('冷启动查询期间删除并复用组 id，旧组先归档，新组随后单独备份', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  const oldTab = { id: 2, groupId: group.id, url: 'https://old.example/', title: '查询时的旧标签' };
  const newTab = { id: 3, groupId: group.id, url: 'https://new.example/', title: '新标签' };
  const reused = { ...group, title: '复用 id 的新组', color: 'green' };
  forgetGroupObject(group.id);
  globalThis.chrome = {
    storage: { local },
    tabs: { async query() { return [newTab]; } },
    tabGroups: {
      async query() {
        await Promise.resolve();
        forgetGroupObject(group.id);
        noteGroupObject(reused);
        return [group];
      },
    },
  };

  await initBackupAllGroups([oldTab], true);
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
  await archiveGroup(group.id);
  const { deletedAt, ...archived } = onlyArchive(local, group.id);
  assert.ok(Number.isFinite(Date.parse(deletedAt)));
  assert.deepEqual(archived, snapshot);

  await backupGroup(group.id);
  const active = local.data['tabg:g:1'];
  assert.equal(active.title, reused.title);
  assert.equal(active.color, reused.color);
  assert.deepEqual(active.tabs, [{ url: newTab.url, title: newTab.title }]);
});

test('启动等待节流时间戳时删除旧组并复用编号，保留旧归档内容', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  const reused = { ...group, title: '新组' };
  const get = local.get;
  local.get = async keys => {
    if (keys === 'tabg:meta') {
      forgetGroupObject(group.id);
      noteGroupObject(reused);
    }
    return get(keys);
  };
  globalThis.chrome = { storage: { local }, tabGroups: { async query() { return [reused]; } } };
  await initBackupAllGroups([{ groupId: 1, url: 'https://example.com/old' }]);
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
});

test('整组标签尚无网址时，单组备份与启动对账都保留已有的有效快照', async () => {
  const local = createStorage({ 'tabg:g:1': snapshot });
  const tabs = [{ groupId: group.id, index: 0 }];
  globalThis.chrome = {
    storage: { local }, tabs: { async query() { return tabs; } },
    tabGroups: { async query() { return [group]; }, async get() { assert.fail('无可保存的网址时不应读取组对象'); } },
  };
  forgetGroupObject(group.id);
  await backupGroup(group.id);
  await initBackupAllGroups(tabs, true);
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
});

test('系统时钟回拨后仍执行启动对账', async () => {
  const local = createStorage({ 'tabg:meta': { lastInitAt: Date.now() + 86_400_000 }, 'tabg:g:1': snapshot });
  globalThis.chrome = { storage: { local }, tabGroups: { async query() { return []; } } };
  await initBackupAllGroups([]);
  assert.deepEqual(onlyArchive(local, 1).tabs, snapshot.tabs);
});

for (const hasGetKeys of [true, false]) {
  test(`编号格式异常的键不会覆盖正常编号的归档（getKeys=${hasGetKeys}）`, async () => {
    const local = createStorage({ 'tabg:g:1': snapshot, 'tabg:g:01': { ...snapshot, title: '异常键' } });
    if (!hasGetKeys) delete local.getKeys;
    globalThis.chrome = { storage: { local }, tabGroups: { async query() { return []; } } };
    await initBackupAllGroups([], true);
    assert.equal(onlyArchive(local, 1).title, snapshot.title);
    assert.equal(local.data['tabg:g:01'].title, '异常键');
    assert.equal((await readBackups(false)).active, 0);
    assert.equal((await readBackups(true)).entries['tabg:g:01'].title, '异常键');
    await initBackupAllGroups([], true);
    assert.equal(onlyArchive(local, 1).title, snapshot.title);
  });

  test(`init 只写内容变化的存活组（getKeys=${hasGetKeys}）`, async () => {
    const changedBefore = { ...snapshot, id: 2, title: '旧组名' };
    const local = createStorage({
      'tabg:meta': { lastInitAt: 0 },
      'tabg:g:1': snapshot,
      'tabg:g:2': changedBefore,
    });
    if (!hasGetKeys) local.getKeys = undefined;
    const changedGroup = { ...group, id: 2, title: '新组名' };
    globalThis.chrome = {
      storage: { local },
      tabGroups: { async query() { return [group, changedGroup]; } },
    };
    const tabs = [1, 2].map(groupId => ({
      id: groupId + 10,
      groupId,
      url: 'https://example.com/',
      title: 'Example',
    }));

    await initBackupAllGroups(tabs, true);

    assert.deepEqual(local.writes, [['tabg:g:2'], ['tabg:meta']]);
    assert.deepEqual(local.data['tabg:g:1'], snapshot);
    assert.equal(local.data['tabg:g:2'].title, '新组名');
    assert.notEqual(local.data['tabg:g:2'].updatedAt, changedBefore.updatedAt);

    globalThis.chrome.tabs = {
      async query({ groupId }) { return tabs.filter(tab => tab.groupId === groupId); },
    };
    await backupGroup(group.id);
    assert.deepEqual(local.writes, [['tabg:g:2'], ['tabg:meta']]);
  });

  test(`init 会写回含畸形标签或无效时间的 active（getKeys=${hasGetKeys}）`, async () => {
    const local = createStorage({
      'tabg:g:1': {
        ...snapshot,
        tabs: [snapshot.tabs[0], { url: 42, title: null }],
      },
      'tabg:g:2': { ...snapshot, id: 2, updatedAt: 'invalid-date' },
    });
    if (!hasGetKeys) local.getKeys = undefined;
    const secondGroup = { ...group, id: 2 };
    globalThis.chrome = {
      storage: { local },
      tabGroups: { async query() { return [group, secondGroup]; } },
    };
    const tabs = [1, 2].map(groupId => ({
      id: groupId + 10,
      groupId,
      url: 'https://example.com/',
      title: 'Example',
    }));

    await initBackupAllGroups(tabs, true);

    assert.deepEqual(local.data['tabg:g:1'].tabs, snapshot.tabs);
    assert.ok(Number.isFinite(Date.parse(local.data['tabg:g:2'].updatedAt)));
    assert.deepEqual(local.writes, [['tabg:g:1', 'tabg:g:2'], ['tabg:meta']]);
  });

  test(`残留 v1 不覆盖较新的有效 v2（getKeys=${hasGetKeys}）`, async () => {
    const v2Dead = { ...snapshot, title: 'v2 死组', updatedAt: '2026-03-01T00:00:00.000Z' };
    const v2Live = { ...snapshot, id: 2, title: 'v2 活组', updatedAt: '2026-03-01T00:00:00.000Z' };
    const legacy = {
      version: 1,
      active: {
        1: { ...snapshot, title: 'v1 旧死组' },
        2: { ...snapshot, id: 2, title: 'v1 旧活组' },
      },
      archived: [],
    };
    const local = createStorage({
      tabGroupBackup: legacy,
      'tabg:g:1': v2Dead,
      'tabg:g:2': v2Live,
    });
    if (!hasGetKeys) local.getKeys = undefined;
    globalThis.chrome = {
      storage: { local },
      tabGroups: { async query() { return [{ ...group, id: 2, title: 'v2 活组' }]; } },
    };

    await initBackupAllGroups([], true);

    assert.equal(local.data.tabGroupBackup, undefined);
    assert.equal(local.data['tabg:g:1'], undefined);
    assert.deepEqual(local.data['tabg:g:2'], v2Live);
    assert.equal(onlyArchive(local, 1).title, 'v2 死组');
    assert.ok(!local.writes.flat().includes('tabg:g:2'));
  });
}

test('v1 单 key 数据成功迁移，存活与历史快照按 v2 归档', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z';
  const legacy = {
    version: 1,
    active: { 1: snapshot },
    archived: [{ ...snapshot, id: 2, deletedAt }],
  };
  const local = createStorage({ tabGroupBackup: legacy });
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return []; } },
  };

  await initBackupAllGroups([], true);

  assert.equal(local.data.tabGroupBackup, undefined);
  assert.equal(local.data['tabg:g:1'], undefined);
  assert.deepEqual(onlyArchive(local, 1).tabs, snapshot.tabs);
  assert.equal(onlyArchive(local, 2).deletedAt, deletedAt);
});

test('v1 归档迁移保留 Unix 纪元及之前的删除时间', async () => {
  for (const deletedAt of ['1970-01-01T00:00:00.000Z', '1969-12-31T23:59:59.999Z']) {
    const legacy = {
      version: 1,
      active: {},
      archived: [{ ...snapshot, id: 3, deletedAt }],
    };
    const local = createStorage({ tabGroupBackup: legacy });
    globalThis.chrome = {
      storage: { local },
      tabGroups: { async query() { return []; } },
    };

    await initBackupAllGroups([], true);

    const archives = Object.keys(local.data).filter(key => key.startsWith(`tabg:a:3:${Date.parse(deletedAt)}:`));
    assert.equal(archives.length, 1);
    assert.equal(local.data[archives[0]].deletedAt, deletedAt);
    assert.equal((await readBackups(false)).archived, 1);
  }
});

test('v1 迁移时存活空组也保留 active 供随后归档', async () => {
  const legacy = { version: 1, active: { 1: snapshot }, archived: [] };
  const local = createStorage({ tabGroupBackup: legacy });
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return [group]; } },
  };

  await initBackupAllGroups([], true);

  assert.equal(local.data.tabGroupBackup, undefined);
  assert.deepEqual(local.data['tabg:g:1'], snapshot);
  await archiveGroup(group.id);
  assert.deepEqual(onlyArchive(local, group.id).tabs, snapshot.tabs);
});

test('v1 迁移时内容变化的存活组仍写入当前拍照时间', async () => {
  const legacy = { version: 1, active: { 1: snapshot }, archived: [] };
  const local = createStorage({
    tabGroupBackup: legacy,
    'tabg:g:1': { ...snapshot, title: '旧组名', updatedAt: '2026-02-01T00:00:00.000Z' },
  });
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return [group]; } },
  };
  const tabs = [{ id: 2, groupId: 1, url: 'https://example.com/', title: 'Example' }];

  await initBackupAllGroups(tabs, true);

  assert.equal(local.data.tabGroupBackup, undefined);
  assert.equal(local.data['tabg:g:1'].title, snapshot.title);
  assert.notEqual(local.data['tabg:g:1'].updatedAt, snapshot.updatedAt);
  assert.notEqual(local.data['tabg:g:1'].updatedAt, '2026-02-01T00:00:00.000Z');
});

test('v1 迁移写失败时保留旧单 key', async () => {
  const legacy = { version: 1, active: { 1: snapshot }, archived: [] };
  const local = createStorage({ tabGroupBackup: legacy }, { failSet: () => true });
  globalThis.chrome = {
    storage: { local },
    tabGroups: { async query() { return []; } },
  };

  await assert.rejects(initBackupAllGroups([], true));
  assert.deepEqual(local.data.tabGroupBackup, legacy);
  assert.equal(local.removals.length, 0);
});
