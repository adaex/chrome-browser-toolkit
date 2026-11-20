# 架构与行为约束

本文记录跨模块约束和有意产品取舍；单模块算法与具体分支以代码和测试为准

## 模块与数据

文件位置与职责见 [README 项目结构](../README.md#项目结构)

两个功能开关分别存于 `chrome.storage.local` 的 `featureSettings.deduplicate` 和 `featureSettings.fullscreen`，每次改动只写对应开关。打开或切回设置页时读取最新值，不覆盖该页尚未保存的输入。后台一次读取两个开关和旧 `featureSettings` 对象；没有单独设置的开关沿用旧值，默认开启。本机代理端口存于 `proxyPort`，默认 `7890`

## 后台入口与事件

普通进程由 `startNormalMode()` 注册监听。标签、窗口和备份任务通过串行队列执行

| 事件 | 触发行为 |
| --- | --- |
| `proxy.settings.onChange` | 重新读取实际代理状态，更新工具栏图标和悬停标题；启动时也同步一次 |
| `tabs.onCreated` | 按开关先去重，未命中且符合条件才吸附全屏窗口，避免焦点打架 |
| `tabs.onUpdated` | URL 变化时按开关去重；complete、complete 后 title 再变、groupId 变化时备份相关组，离组／换组时新旧组都拍 |
| `tabs.onRemoved` | 标签关闭后重拍其所属组；整窗关闭除外，组随窗口删除后直接归档 |
| `tabs.onMoved` / `tabs.onDetached` | 同窗拖动后更新组内顺序，跨窗拖出后重拍原组；事件不带 groupId，靠缓存定位 |
| `tabGroups.onUpdated` | 更新组对象缓存；组名或颜色变化才备份，纯折叠变化不重写，因为快照不存 collapsed |
| `tabGroups.onRemoved` | 将 active 快照移为带 deletedAt 的归档 |

首次组快照由标签入组时的 `tabs.onUpdated(groupId)` 负责，不监听 `tabGroups.onCreated`

启动时立即重建标签归属缓存，查询失败直接中止。init 默认按 5 分钟节流；若缓存就绪前发生归属事件 miss，则重新查询最新标签、重建缓存并强刷一次。重建不能让旧查询快照覆盖事件刚写入的归属

同组待执行备份会合并。备份执行期间来了新事件，可再排一次读取最新状态。删除组时取消该组尚未取齐数据的任务，以便复用编号的新组在旧组归档后单独备份

### 无痕隔离

清单声明 `incognito: "split"`，无痕进程不调用 `startNormalMode()`，不注册业务监听、不查询标签、不读写备份。split 与普通进程仍共享 `storage.local`，不能只改清单而漏掉入口隔离

弹窗与设置页在无痕上下文禁用代理修改，共享代理写入口也检查 regular 上下文，不能绕过 UI 改写 regular 代理。无痕 split 进程不注册外部代理消息入口

旧版本可能已经保存的无痕备份没有来源标记，不猜测并自动清理，避免误删正常归档

## 队列与错误处理

`Queue` 按提交顺序逐个执行任务。任务同步抛错或异步失败时记录错误，后面的任务继续执行；`catchError(context)` 也用于独立入口的错误日志

- 标签、窗口和备份任务经 `queue.run()` 串行执行
- 所有代理写入另走 `worker/index.ts` 中的 `proxyWriteQueue`，不与标签／备份任务互相阻塞
- 启动预热查询、代理状态同步等独立入口用 `catchError(context)` 兜底
- 去重、移动、删除等连续操作不在调用点吞错继续；激活等前置步骤失败必须中止当前任务

## 网络代理

相关模块为 `worker/proxy.ts`、`popup.ts`、`options.ts` 与 `switch.ts`

- 仅提供 `direct` 与本机 `socks5`，主机固定 `127.0.0.1`，`scope` 固定为 `regular`，不提供 PAC、多配置或认证管理
- 本扩展已控制本机 SOCKS5 时，保存端口也更新实际代理；若存储失败则回滚到原配置。其他情况下只保存端口偏好
- 状态以 `chrome.proxy.settings` 的实际配置和 `levelOfControl` 为准；其他扩展控制时只提示，不抢控制权，也不检查延迟或连通性
- 状态读取带版本保护，慢返回的旧结果不得覆盖新图标

本机脚本可打开 `chrome-extension://<扩展ID>/switch.html?mode=direct|socks5`，不需要常驻 helper 或新增权限。弹窗、设置页与外部页都通过 `PROXY_MESSAGE` 把写入交给普通后台，由 `proxyWriteQueue` 串行执行，避免跨页面连续操作用旧状态互相覆盖

外部命令在相同模式下跳过写入，其他扩展控制时拒绝；成功后关闭当前标签，失败保留页面。该页不得加入 `web_accessible_resources`

工具栏图标中，直连为三色实心，SOCKS5 为同外径三色空心，其他模式为灰色。图标资源与导出规则见[代理状态图标文档](../design/icon-states/README.md)

## 内存缓存

`worker/groupCache.ts` 维护两个常驻 Map：

- `tabId -> groupId` 包含未分组的 `-1`，供不带 groupId 的关闭、移动事件定位原组。启动重建与事件并发时，旧查询快照不得覆盖新归属；缓存就绪前的 miss 会触发启动强刷
- `groupId -> TabGroup` 只提供备份所需的 title/color，不参与空组判断。回填不得覆盖查询期间刚到达的新状态；缓存命中与否不得改变归档语义

## 标签页管理

`effectiveUrl(tab)` 统一使用 `pendingUrl ?? url ?? ''`，去重比对与备份拍照必须共用这一口径

`isProxySwitchUrl(url)` 只识别本扩展的 `switch.html` 及其 query/hash。一次性切换页在 `onCreated` / `onUpdated` 跳过标签管理，`checkDuplicate` 也直接保留，避免失败后的同 URL 重试被关闭

同一标签的创建和网址变化在去重查询发出前合并；若标签在排队或读取开关时关闭，不再查询全部标签。查询开始后，源标签或候选标签一旦导航或关闭，后续操作会忽略该标签的旧结果。普通网址的导航会重新排队，切换页会取消待执行的检查。`checkDuplicate(tabId)` 查询全部标签并比较查询时的有效网址。激活已有标签成功后才关闭重复的新标签；新标签保留时，才继续判断是否并入全屏窗口

同 URL 老标签有多个时，按 `pickTarget` 的优先级选择：同组／同窗、同窗可并入、跨窗可激活、保留重复的候选。不可操作候选必须垫底，避免挡住跨窗可用目标

`toFullscreenWindow(tabId, windowId)` 先确认唯一全屏普通窗口候选，再读取源窗口标签，将其中唯一的 tab 移入、激活并聚焦。移动前用最新标签再次排除代理切换页，覆盖 `onCreated` 时 URL 尚未就绪的情况

### 有意设计，勿当 bug 修

- **最小 API 调用优先**：`checkDuplicate` 开头取一次标签快照后一路 await，不补 `tabs.get` 二次核对；竞态窗口极小且队列已兜底，但前置步骤失败不得继续删除标签
- **相同 URL 去重是核心功能**：默认合并可处理的相同 URL 标签，可在设置页整体关闭；保留重复或保留新标签的例外均为预期行为
- **新标签页保留新标签**：`chrome://new*` 直接关闭重复旧标签，不特判 pinned
- **同网址 opener 保留重复**：不限于复制 tab 场景
- **标签组不跨窗口**：新标签在组里、同 URL 老标签在另一窗口且可合并时，不调必失败的 `tabs.group`，直接激活老标签、关闭新标签
- **新窗口吸附全屏窗口**：`!openerTabId && index === 0` 且源窗口仍只有当前 tab 的新普通窗口会移进唯一全屏候选，包括 Ctrl+N 和命令行开链接；多个候选时不猜目标，多标签窗口不拆散，移动失败时不抢焦点

## 标签组备份

设置页先显示备份份数。支持 `storage.local.getKeys()` 的 Chrome 不必为计数读取归档内容；展开查看或导出时才生成完整 JSON。备份仅供复制或导出后手动重建，不做一键恢复

v2 按组拆 key，v1 的单 key `tabGroupBackup` 在首次 init 时迁移后删除：

```text
tabg:meta                     { lastInitAt }，仅做 5 分钟节流
tabg:g:<groupId>              存活组快照；键集合本身就是存活组真相，不另存索引
tabg:a:<groupId>:<删除时间戳ms>:<随机ID>  已删除组归档，只增不删、无条数上限
```

快照字段以 `worker/backup.ts` 的 `GroupSnapshot` 为准；`updatedAt` 记录拍照时间，`deletedAt` 仅归档项有

### 单组备份与归档

`backupGroup(groupId)` 先读该组全部标签。组内没有可保存的网址时保留最后的存活快照，供 `onRemoved` 或下次 init 归档；有网址才读取组名和颜色。只写内容变化的相关组，使用当前 SW 内的内容指纹跳过重复写入，不能为了指纹额外读取存储；缓存未确认时保守落盘

`archiveGroup(groupId)` 先把有效 active 快照写成带 deletedAt 的随机归档 key，再删除 active key。归档失败时，后台会在同一编号的下一次备份前重试；重试成功后才写新组

有效归档只增不删、不设上限、不截断。Chrome 复用 groupId 或同毫秒重复删除也不能覆盖旧归档，靠 `unlimitedStorage` 解除默认约 10MB 配额。归档积累不得放大单组写入

### 启动对账与迁移

`initBackupAllGroups()` 从第一次标签查询前开始记录组更新和删除事件，覆盖缓存重建、节流判断和对账写入。对账按组聚合标签，再按标签的 `index` 保存顺序

- 只写新增、非规范或内容变化的存活组；规范且未变的快照保留原 updatedAt
- 查询窗口内变空的组保留 active 等归档；存储里有但实时已不存在的组移入归档
- v1 数据首次发现时迁移，有效 v2 优先于残留 v1；先写归档／迁移再删旧 key，写失败保留原数据
- 支持 `storage.getKeys()` 时只枚举键名并读回 active，不读取归档字节；老版本回退 `get(null)` 全量读
- 不维护第二份组 id 索引；meta 最后写，代表本次对账真正完成

真实 Chrome 中，取消分组与关闭最后标签都会产生组删除事件，收到事件时无法可靠区分原因。只要已有有效快照就统一归档，不恢复旧的 `preserveEmpty`／空组清理特例，也不加定时器或猜测状态。畸形或无值 active 没有可归档内容，只能移除，避免卡住后续对账

所有备份写入通过 `queue` 串行执行。读出的快照经 `sanitizeSnapshot` 归一，畸形数据当不存在，不能让后续备份永久抛错
