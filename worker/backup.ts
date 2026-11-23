import {
  consumeColdMiss,
  noteGroupObject,
  rebuildGroupCache,
  resolveGroupObject,
  syncGroupObjects,
  trackGroupObjectChanges,
} from './groupCache.js';
import { effectiveUrl } from './tabs.js';

// 类型定义
type TabGroup = chrome.tabGroups.TabGroup;

interface TabSnapshot {
  url: string;
  title: string;
}

interface GroupSnapshot {
  id: number;
  title: string;
  color: string;
  tabs: TabSnapshot[];
  updatedAt: string;
  deletedAt?: string;
}

// v2 存储布局：拆 key，单次备份只写一个小组快照，不再全量重写
//   tabg:meta                     -> { lastInitAt }
//   tabg:g:<groupId>              -> 存活组的快照，每组一个 key；键集合本身就是存活组真相
//   tabg:a:<groupId>:<删除毫秒时间戳>:<随机ID> -> 已删除组的归档，只增不删，恢复靠人工读 JSON
//   tabg:p:<groupId>              -> 归档尚未完成的标记，成功后才删除
const META_KEY = 'tabg:meta';
const ACTIVE_PREFIX = 'tabg:g:';
const ARCHIVE_PREFIX = 'tabg:a:';
const PENDING_ARCHIVE_PREFIX = 'tabg:p:';
const LEGACY_KEY = 'tabGroupBackup'; // v1 的单 key，首次 init 时一次性迁移
const BROWSER_SESSION_KEY = 'tabg:browser-session'; // storage.session 只用于识别 Chrome 是否重启
const INIT_THROTTLE_MS = 5 * 60 * 1000; // SW 频繁重启，全量 init 5 分钟最多一次

const activeKey = (groupId: number) => `${ACTIVE_PREFIX}${groupId}`;
const archiveKey = (groupId: number, deletedAtMs: number) =>
  `${ARCHIVE_PREFIX}${groupId}:${deletedAtMs}:${crypto.randomUUID()}`;
const pendingArchiveKey = (groupId: number) => `${PENDING_ARCHIVE_PREFIX}${groupId}`;

function prefixedIdOf(key: string, prefix: string): number | undefined {
  if (!key.startsWith(prefix)) return;
  const id = Number(key.slice(prefix.length));
  if (Number.isSafeInteger(id) && id >= 0 && key === `${prefix}${id}`) return id;
}

function activeIdOf(key: string): number | undefined {
  return prefixedIdOf(key, ACTIVE_PREFIX);
}

function archiveIdOf(key: string): number | undefined {
  const match = /^tabg:a:(0|[1-9]\d*):(-?(?:0|[1-9]\d*)):[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.exec(key);
  if (!match) return;
  const id = Number(match[1]);
  const deletedAtMs = Number(match[2]);
  if (Number.isSafeInteger(id) && Number.isSafeInteger(deletedAtMs)) return id;
}

function pendingArchiveIdOf(key: string): number | undefined {
  return prefixedIdOf(key, PENDING_ARCHIVE_PREFIX);
}

function backupKind(key: string) {
  if (activeIdOf(key) !== undefined) return 'active';
  if (archiveIdOf(key) !== undefined) return 'archived';
  if (key === LEGACY_KEY) return 'legacy';
}

export async function readBackups(includeEntries: boolean) {
  const storage = chrome.storage.local;
  // 归档会更换键名，查看和导出必须在同一次读取中取得键和值；只计数时优先只取键名
  const stored = includeEntries || typeof storage.getKeys !== 'function' ? await storage.get(null) : undefined;
  const keys = stored ? Object.keys(stored) : await storage.getKeys();
  const result = { active: 0, archived: 0, legacy: 0, entries: includeEntries ? stored : undefined };
  for (const key of keys) {
    const kind = backupKind(key);
    if (kind) result[kind]++;
    // 格式异常的原始快照和归档仍可导出供人工查看，但不计入有效份数
    else if (result.entries && !key.startsWith(ACTIVE_PREFIX) && !key.startsWith(ARCHIVE_PREFIX)) delete result.entries[key];
  }
  return result;
}

async function readLastInitAt(): Promise<number> {
  const result = await chrome.storage.local.get(META_KEY);
  const meta = result[META_KEY];
  return meta && typeof meta === 'object' && typeof (meta as { lastInitAt?: unknown }).lastInitAt === 'number'
    ? (meta as { lastInitAt: number }).lastInitAt
    : 0;
}

// 读出的数据不信任形状，归一失败就当不存在，避免一份畸形数据让所有备份永久抛错
function sanitizeSnapshot(value: unknown, expectedId?: number): GroupSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== 'number' ||
    !Number.isSafeInteger(v.id) ||
    v.id < 0 ||
    (expectedId !== undefined && v.id !== expectedId) ||
    typeof v.title !== 'string' ||
    typeof v.color !== 'string' ||
    typeof v.updatedAt !== 'string' ||
    !Array.isArray(v.tabs)
  ) {
    return null;
  }

  const tabs: TabSnapshot[] = [];
  for (const item of v.tabs) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.url === 'string' && typeof t.title === 'string') {
      tabs.push({ url: t.url, title: t.title });
    }
  }

  const snapshot: GroupSnapshot = {
    id: v.id,
    title: v.title,
    color: v.color,
    tabs,
    updatedAt: v.updatedAt,
  };
  if (typeof v.deletedAt === 'string') snapshot.deletedAt = v.deletedAt;
  return snapshot;
}

// sanitize 后的内容相同还不够：原始 active 含多余字段、畸形标签或无效时间时仍需借 init 写回清洗
function isCanonicalSnapshot(value: unknown, snapshot: GroupSnapshot): boolean {
  const v = value as Record<string, unknown>;
  const expectedKeys = Object.keys(snapshot);
  if (
    Object.keys(v).length !== expectedKeys.length ||
    !expectedKeys.every(key => key in v) ||
    !Number.isFinite(Date.parse(snapshot.updatedAt))
  ) {
    return false;
  }

  const rawTabs = v.tabs as unknown[];
  if (rawTabs.length !== snapshot.tabs.length) return false;
  for (let i = 0; i < rawTabs.length; i++) {
    const rawTab = rawTabs[i] as Record<string, unknown>;
    const cleanTab = snapshot.tabs[i];
    if (Object.keys(rawTab).length !== 2 || rawTab.url !== cleanTab.url || rawTab.title !== cleanTab.title) {
      return false;
    }
  }
  return true;
}

// 归档条目：归档 key 与 deletedAt 盖戳的约定只此一处
function archiveEntry(snapshot: GroupSnapshot, deletedAtMs: number): [string, GroupSnapshot] {
  return [
    archiveKey(snapshot.id, deletedAtMs),
    { ...snapshot, deletedAt: new Date(deletedAtMs).toISOString() },
  ];
}

// 入参是该组独有的标签数组。没有有效网址时不生成快照，保留上次备份
function snapshotTabs(tabs: chrome.tabs.Tab[]): TabSnapshot[] | undefined {
  const entries: TabSnapshot[] = [];
  for (const tab of tabs.sort((a, b) => a.index - b.index)) {
    const url = effectiveUrl(tab);
    if (url) entries.push({ url, title: tab.title ?? '' });
  }
  return entries.length ? entries : undefined;
}

function snapshotGroup(group: TabGroup, tabs: TabSnapshot[], updatedAt: string): GroupSnapshot {
  return { id: group.id, title: group.title ?? '', color: group.color, tabs, updatedAt };
}

// Chrome 只在单个浏览器会话内保证组 ID 唯一。恢复会话时用稳定内容寻找旧快照；
// 标签标题会在加载后变化，不参与匹配，调用方还要求旧组和新组都唯一，避免猜测
function restoreIdentityOf(snapshot: GroupSnapshot): string {
  return JSON.stringify([snapshot.title, snapshot.color, snapshot.tabs.map(tab => tab.url)]);
}

// updatedAt 只记录拍照时间；内容没变时无需为了刷新时间戳再写一次存储
function sameSnapshotContent(a: GroupSnapshot, b: GroupSnapshot): boolean {
  if (
    a.id !== b.id ||
    a.title !== b.title ||
    a.color !== b.color ||
    a.deletedAt !== b.deletedAt ||
    a.tabs.length !== b.tabs.length
  ) {
    return false;
  }
  for (let i = 0; i < a.tabs.length; i++) {
    if (a.tabs[i].url !== b.tabs[i].url || a.tabs[i].title !== b.tabs[i].title) return false;
  }
  return true;
}

// 与 sameSnapshotContent 同口径，但不保留完整快照；每组只常驻 64 个十六进制字符
async function snapshotFingerprint(snapshot: GroupSnapshot): Promise<string> {
  const content = JSON.stringify([
    snapshot.id,
    snapshot.title,
    snapshot.color,
    snapshot.deletedAt,
    snapshot.tabs.map(tab => [tab.url, tab.title]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// 当前 SW 内已确认与存储一致的 active 指纹；complete/title 重复事件无需再写相同快照
// 不为此增加存储读取；SW 重启后缓存自然清空，首次备份仍保守写入
const activeSnapshotCache = new Map<number, string>();
const unfinishedArchives = new Set<number>();
let unfinishedArchivesLoaded = false;

// 每个 SW 只恢复一次持久化标记，避免重启后同编号的新组覆盖尚未归档的旧快照
// 返回首次枚举结果，未发生归档恢复时供对账复用，避免重复读取全库
async function ensureUnfinishedArchives() {
  if (unfinishedArchivesLoaded) return;
  const storage = chrome.storage.local;
  const keysOrRecord = typeof storage.getKeys === 'function' ? await storage.getKeys() : await storage.get(null);
  const keys = Array.isArray(keysOrRecord) ? keysOrRecord : Object.keys(keysOrRecord);
  for (const key of keys) {
    const id = pendingArchiveIdOf(key);
    if (id !== undefined) unfinishedArchives.add(id);
  }
  unfinishedArchivesLoaded = true;
  return keysOrRecord;
}

async function ensureUnfinishedArchive(groupId: number) {
  if (unfinishedArchivesLoaded || unfinishedArchives.has(groupId)) return;
  const key = pendingArchiveKey(groupId);
  const result = await chrome.storage.local.get(key);
  if (result[key] !== undefined) unfinishedArchives.add(groupId);
}

// 备份单个标签组：常规路径只写该组 active，不读取其他组的内容
export async function backupGroup(groupId: number, isCurrent = () => true) {
  // 启动对账尚未恢复标记时，只检查当前组，避免归档积累放大单组备份
  await ensureUnfinishedArchive(groupId);
  // 编号被复用时，旧快照必须先成功归档，新组才能占用同一个键
  if (unfinishedArchives.has(groupId)) await archiveGroup(groupId);
  const tabs = await chrome.tabs.query({ groupId });
  if (!isCurrent()) return;
  const entries = snapshotTabs(tabs);
  if (!entries) return;

  let group = resolveGroupObject(groupId);
  if (!group) {
    const fetched = await chrome.tabGroups.get(groupId);
    if (!isCurrent()) return;
    // get 期间若来了 onUpdated，保留事件刚写入的新对象
    group = resolveGroupObject(groupId) ?? fetched;
    noteGroupObject(group);
  }
  const next = snapshotGroup(group, entries, new Date().toISOString());
  const fingerprint = await snapshotFingerprint(next);
  if (activeSnapshotCache.get(groupId) === fingerprint) return;

  await chrome.storage.local.set({ [activeKey(groupId)]: next });
  // 只有确认落盘后才更新缓存；写失败时后续事件仍会重试
  activeSnapshotCache.set(groupId, fingerprint);
}

// 归档已删除的标签组：active key 移为归档 key（打 deletedAt），不丢弃；无快照则无需动作
export async function archiveGroup(groupId: number) {
  // 归档可能改变或移除 active；先失效，失败时也只是后续备份多写一次
  activeSnapshotCache.delete(groupId);
  unfinishedArchives.add(groupId);
  const pendingKey = pendingArchiveKey(groupId);
  const storage = chrome.storage.local;
  // 标记必须先落盘，再读取 active；失败时不能留下迟到的标记写入
  await storage.set({ [pendingKey]: true });
  const key = activeKey(groupId);
  const result = await storage.get(key);
  const snapshot = sanitizeSnapshot(result[key], groupId);
  if (snapshot) {
    const [archiveK, archiveV] = archiveEntry(snapshot, Date.now());
    await storage.set({ [archiveK]: archiveV });
    await storage.remove(key);
  }
  await storage.remove(pendingKey);
  unfinishedArchives.delete(groupId);
}

// 启动时全量对账：刷新存活组、把存储中已不存在的组移入归档、顺带迁移 v1 数据。
// 从第一次标签查询前开始跟踪删除事件，直到写入完成，避免跨组拼接快照
export function initBackupAllGroups(allTabs?: chrome.tabs.Tab[], force = false) {
  return trackGroupObjectChanges(async () => {
    // session 在 SW 休眠后仍保留，只在 Chrome 重启后清空；首次运行也按新会话对账
    // 会话标记与 local 的待归档枚举互不依赖，启动时并行读取
    const session = chrome.storage.session;
    const [sessionValue, initialStorage] = await Promise.all([
      typeof session?.get === 'function' ? session.get(BROWSER_SESSION_KEY) : null,
      ensureUnfinishedArchives(),
    ]);
    const browserRestart = sessionValue !== null && sessionValue[BROWSER_SESSION_KEY] !== true;
    if (browserRestart) force = true;

    // 有待归档快照时跳过节流，优先保住旧组，再处理可能复用编号的新组
    if (unfinishedArchives.size) force = true;
    let tabs = allTabs ?? await rebuildGroupCache();
    if (!allTabs && consumeColdMiss()) {
      tabs = await rebuildGroupCache();
      force = true;
    }
    if (!force) {
      const lastInitAt = await readLastInitAt();
      const elapsed = Date.now() - lastInitAt;
      if (elapsed >= 0 && elapsed < INIT_THROTTLE_MS) return;
    }
    await reconcileBackup(tabs, initialStorage, browserRestart);
    // 对账失败时不落标记，下次 SW 启动仍按新浏览器会话重试
    if (browserRestart) await session.set({ [BROWSER_SESSION_KEY]: true });
  });
}

function isLegacyBackup(value: unknown): value is { active?: Record<string, unknown>; archived?: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { version, active, archived } = value as Record<string, unknown>;
  return (version === undefined || version === 1) && (active !== undefined || archived !== undefined) &&
    (active === undefined || (active !== null && typeof active === 'object' && !Array.isArray(active))) &&
    (archived === undefined || Array.isArray(archived));
}

async function reconcileBackup(
  allTabs: chrome.tabs.Tab[],
  initialStorage?: string[] | Record<string, unknown>,
  browserRestart = false,
) {
  // 对账可能分批写 active、删旧 key；任一步失败都只损失缓存命中，后续备份会保守重写
  activeSnapshotCache.clear();

  const storage = chrome.storage.local;
  // 先恢复未完成归档，再读取存储；串行确保失败后没有迟到写入越过队列
  const recoveredArchiveIds = new Set(unfinishedArchives);
  for (const groupId of recoveredArchiveIds) await archiveGroup(groupId);

  // Chrome 130+ 可只枚举键名：归档字节完全不读；老版本回退全量读取
  const hasGetKeys = typeof storage.getKeys === 'function';
  // 恢复归档会改写存储，只有无需恢复时才能复用启动时的枚举结果
  const reusableStorage = recoveredArchiveIds.size === 0 ? initialStorage : undefined;

  // 实时存活组、存储侧键集合、v1 旧数据三件互不依赖的事并行
  const [groups, keysOrRecord, legacyWrap] = await Promise.all([
    chrome.tabGroups.query({}),
    reusableStorage !== undefined
      ? Promise.resolve(reusableStorage)
      : hasGetKeys ? storage.getKeys() : storage.get(null),
    hasGetKeys ? storage.get(LEGACY_KEY) : Promise.resolve(null),
  ]);

  const fullRecord = hasGetKeys ? null : (keysOrRecord as Record<string, unknown>);
  const storedKeys = hasGetKeys ? (keysOrRecord as string[]) : Object.keys(fullRecord!);
  const legacy = hasGetKeys
    ? (legacyWrap as Record<string, unknown> | null)?.[LEGACY_KEY]
    : fullRecord![LEGACY_KEY];

  const liveIds = new Set(groups.map(group => group.id));

  // prior：存储侧 active 快照，死组归档与存活组内容比较共用，只 sanitize 一次
  const prior = new Map<number, GroupSnapshot>();
  const storedActiveIds = new Set<number>();
  const canonicalActiveIds = new Set<number>();
  for (const key of storedKeys) {
    const id = activeIdOf(key);
    if (id === undefined) continue;
    storedActiveIds.add(id);
    if (fullRecord) {
      const snapshot = sanitizeSnapshot(fullRecord[key], id);
      if (snapshot) {
        prior.set(id, snapshot);
        if (isCanonicalSnapshot(fullRecord[key], snapshot)) canonicalActiveIds.add(id);
      }
    }
  }

  // getKeys 路径一次读回 active 值，仍不读取任何归档字节
  if (hasGetKeys && storedActiveIds.size) {
    const activeRecord = await storage.get([...storedActiveIds].map(activeKey));
    for (const id of storedActiveIds) {
      const snapshot = sanitizeSnapshot(activeRecord[activeKey(id)], id);
      if (snapshot) {
        prior.set(id, snapshot);
        if (isCanonicalSnapshot(activeRecord[activeKey(id)], snapshot)) canonicalActiveIds.add(id);
      }
    }
  }

  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];
  const currentSnapshots: GroupSnapshot[] = [];

  // v1 迁移：旧的单 key 对象拆进 v2 布局，随本次 init 落盘后删除旧 key
  if (isLegacyBackup(legacy)) {
    for (const value of Object.values(legacy.active ?? {})) {
      const snapshot = sanitizeSnapshot(value);
      // 待归档标记也代表 v2 已处理删除，残留 v1 不得重复归档或复活
      if (!snapshot || prior.has(snapshot.id) || recoveredArchiveIds.has(snapshot.id)) continue;
      if (liveIds.has(snapshot.id)) {
        // 存活组仍按 active 迁移，下面的实时快照会更新内容和时间
        prior.set(snapshot.id, snapshot);
        toSet[activeKey(snapshot.id)] = snapshot;
      } else {
        // 已删除组直接写归档，不把 v1 数据混入 v2 active 对账
        const [key, archiveValue] = archiveEntry(snapshot, Date.now());
        toSet[key] = archiveValue;
      }
    }
    if (legacy.archived) {
      for (const item of legacy.archived) {
        const snapshot = sanitizeSnapshot(item);
        if (!snapshot) continue;
        const parsedDeletedAt = Date.parse(snapshot.deletedAt ?? '');
        const deletedAtMs = Number.isNaN(parsedDeletedAt) ? Date.now() : parsedDeletedAt;
        const [key, value] = archiveEntry(snapshot, deletedAtMs);
        toSet[key] = value;
      }
    }
    toRemove.push(LEGACY_KEY);
  }

  const tabsByGroup = new Map<number, chrome.tabs.Tab[]>();
  for (const tab of allTabs) {
    if (tab.groupId >= 0) {
      const list = tabsByGroup.get(tab.groupId);
      if (list) list.push(tab);
      else tabsByGroup.set(tab.groupId, [tab]);
    }
  }

  const snapshotGroups = syncGroupObjects(groups, liveIds);
  const now = new Date().toISOString();
  for (const group of snapshotGroups) {
    const tabs = tabsByGroup.get(group.id);
    const entries = tabs && snapshotTabs(tabs);
    // 查询间隙变空的组保留最后 active，交给 onRemoved 或下次 init 归档
    if (!entries) continue;
    currentSnapshots.push(snapshotGroup(group, entries, now));
  }

  const deadIds = [...storedActiveIds].filter(id => !liveIds.has(id));
  const currentSnapshotIds = new Set(currentSnapshots.map(snapshot => snapshot.id));

  // Chrome 会话恢复会更换组 ID，也可能把旧编号分配给另一个恢复组。全部旧、新快照都参与
  // 唯一匹配；编号碰撞或交换不能绕过归档，也不能在写入后删掉另一个恢复组的新 active
  const restoredActiveIds = new Map<number, number>();
  if (browserRestart) {
    const oldByIdentity = new Map<string, number[]>();
    const add = (map: Map<string, number[]>, identity: string, id: number) => {
      const ids = map.get(identity);
      if (ids) ids.push(id);
      else map.set(identity, [id]);
    };
    for (const id of storedActiveIds) {
      const snapshot = prior.get(id);
      if (snapshot) add(oldByIdentity, restoreIdentityOf(snapshot), id);
    }
    // 没有可匹配的旧快照时，不为全部实时组生成无用的恢复身份
    if (oldByIdentity.size && currentSnapshots.length) {
      const liveByIdentity = new Map<string, number[]>();
      for (const snapshot of currentSnapshots) add(liveByIdentity, restoreIdentityOf(snapshot), snapshot.id);
      for (const [identity, oldIds] of oldByIdentity) {
        const liveMatches = liveByIdentity.get(identity);
        if (oldIds.length === 1 && liveMatches?.length === 1) {
          restoredActiveIds.set(oldIds[0], liveMatches[0]);
        }
      }
    }
  }

  // 普通对账只处理死组。新会话还要先归档将被同编号新组覆盖的旧快照；已匹配恢复的旧键
  // 只有在没有其他实时快照接管该编号时才删除，避免交换编号时先写后删把新快照一起删掉
  const idsToReconcile = browserRestart ? [...storedActiveIds] : deadIds;
  for (const id of idsToReconcile) {
    const restoredId = restoredActiveIds.get(id);
    if (restoredId !== undefined) {
      if (restoredId !== id && !currentSnapshotIds.has(id)) toRemove.push(activeKey(id));
    } else if (!liveIds.has(id)) {
      if (prior.has(id)) await archiveGroup(id);
      else toRemove.push(activeKey(id));
    } else if (currentSnapshotIds.has(id) && prior.has(id)) {
      await archiveGroup(id);
    }
  }

  for (const next of currentSnapshots) {
    const key = activeKey(next.id);
    const previous = prior.get(next.id);
    // 全量对账只落盘新增、非规范或内容变化的组；规范且未变的快照保留原 updatedAt
    // v1 迁移已排的 active 写入仍换成最新快照，不让旧时间戳覆盖现有 v2 数据
    if (key in toSet || !previous || !canonicalActiveIds.has(next.id) || !sameSnapshotContent(previous, next)) {
      toSet[key] = next;
    }
  }

  // 先写后删：归档或迁移写入失败时保留旧数据，删除失败至多下次产生重复归档
  if (Object.keys(toSet).length) await storage.set(toSet);
  if (toRemove.length) await storage.remove(toRemove);
  // meta 最后写：它的时间戳代表本次对账真正完成
  await storage.set({ [META_KEY]: { lastInitAt: Date.now() } });
  for (const snapshot of currentSnapshots) {
    activeSnapshotCache.set(snapshot.id, await snapshotFingerprint(snapshot));
  }
}
