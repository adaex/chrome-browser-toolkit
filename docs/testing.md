# 测试与真实 Chrome 回归

自动化测试、真实 Chrome 回归与外部代理切换的验证方法

## 自动化回归

```bash
yarn test
```

该命令先构建，再用 Node 内置 test runner 和轻量 Chrome API mock 运行 `tests/*.test.mjs`。测试覆盖失败路径和事件时序，不需要额外测试依赖

mock 不能替代真实 Chrome 的代理设置、窗口和标签事件回归。修改代理、标签组生命周期或无痕隔离后必须实测；其他窗口／标签事件变更也不能只靠 mock 判断行为正确

## 实测边界

- 使用隔离 Chrome profile 和临时扩展副本，不操作用户自己的代理设置或备份数据
- 缺少 Playwright 时安装到 `/tmp`，不做全局安装
- 测试钩子只放临时副本，不进入提交或发布包
- 断言异步 Chrome API 的结果时，每轮先 `await page.evaluate(...)` 再判断。不要把尚未完成的 Promise 当成状态已经就绪，例如标签标题还没写入就取消分组
- 结束后关闭自己启动的浏览器和进程，删除临时依赖、脚本、截图与 profile

## Chrome 137+ 加载扩展

不要依赖已移除的 `--load-extension`。使用 `launchPersistentContext` 经 CDP pipe 启动隔离 profile，并满足以下配置：

- `ignoreDefaultArgs` 去掉 `--disable-extensions`
- `args` 加 `--enable-unsafe-extension-debugging`
- 用 `browser.newBrowserCDPSession()` 调 `Extensions.loadUnpacked` 加载构建产物或临时副本

Service Worker 调试求值不能动态 `import()`

在 `chrome://extensions/` 加载 `dist/` 后，也可以点击 Service Worker 链接查看 console 日志

## 设置与备份实测

- 在直连、本机 SOCKS5 和其他代理模式之间切换，核对工具栏、弹窗和设置页的图标始终一致；SOCKS5 下三个位置都必须是三色空心圆点，其他模式都必须是灰色。弹窗单选项与状态文字也要同步，初始化只读取一次代理配置；状态确认后更新替代文本，读取失败和无痕时隐藏页面图标
- 用 `--proxy-server=socks5://127.0.0.1:<测试端口>` 启动隔离 Chrome。只在设置页保存另一端口，确认 Chrome 实际代理和控制方都没变；再从弹窗点击已选中的「本机 SOCKS5」，确认扩展取得控制权并应用保存的端口，随后再次保存端口也应立即生效
- 分别打开「设置」和「标签组备份」，在两页各关一个不同的开关。第二页保存后，第一页在后台仍显示原值；切回后两项都应关闭，重新加载后也不变。用 Playwright 测焦点切换时，先通过各页的 CDP 会话调用 `Emulation.setFocusEmulationEnabled({ enabled: false })`，让 Chrome 发出真实的焦点事件
- 展开备份预览后改组名，等本机快照更新。不要刷新预览，直接点「导出最新备份」：下载的 JSON 应是新组名，预览仍是旧组名
- 在临时扩展副本中让归档写入失败，确认 active 和 `tabg:p:<groupId>` 标记都保留。用全新扩展上下文执行启动对账，旧 active 应先归档，再允许同编号的新快照落盘，成功后删除标记
- 测导航后的去重时，用临时扩展副本里的静态 HTML 页面作为目标。不要用 `tabs.update` 的返回值认定导航已完成，应核对最终保留的标签、网址和分组
- 调整同组标签顺序，等备份更新后取消分组。检查导出的归档顺序，不只核对标签栏
- 测启动期间的标签事件时，先准备好标签，把 `tabg:meta` 的 `lastInitAt` 设为当前时间。在临时副本中延后首次 `tabs.query({})` 返回，分别在两次启动中修改未分组标签的标题、将标签移出已有组。改标题时只查一次全部标签，离组时还会重新查询全部标签和全部组

## 外部代理切换实测

并发外部切换场景必须用外部命令直接打开目标扩展 URL，不要先 `newPage()` 创建 `about:blank`，否则页面可能在导航前被重复标签合并。在 macOS 上，直接调用 Chrome 可执行文件，传入已启动测试实例的 `--user-data-dir=<独立 profile 的绝对路径>` 和目标 URL；不要用未指定 profile 的命令，以免打开用户自己的浏览器

实测至少区分相同模式跳过写入、其他扩展控制时拒绝、成功后自动关页和失败后保留页面；不得把 `switch.html` 加入 `web_accessible_resources`
