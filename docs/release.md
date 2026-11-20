# 发布流程

完整发版与 Chrome 应用商店开发者后台的操作流程。`yarn release` 只生成本地 zip，不等于发布

## 指令语义

“提交、合并发布”是完整发版指令：按“基线 → 评审与本地包 → 商店送审 → 确认结果 → 代码收尾 → 环境收尾”一次走完，不停在 zip 或“待审核”

只有取消正在审核的版本等会改变既有商店状态的操作需要单独确认。上传、保存或送审失败、状态不明时先停下核实，不自动收尾

## 命令行发布配置

`scripts/chrome-web-store.mjs` 是仓库自带的 Node.js 脚本，不需要安装 npm 发布工具。使用 Node.js 22 或更高版本，以及 `PATH` 中的 `gcloud`，也可把 Google Cloud CLI 解压到主工作树的 `tools/google-cloud-sdk/`

只在主工作树的 `.env` 填写 `CWS_PUBLISHER_ID`、`CWS_EXTENSION_ID`、`CWS_PROJECT_ID` 和 `CWS_SERVICE_ACCOUNT`，文件权限设为 `600`。这些是标识，不是私钥；其他工作树共用这份配置，但只打包当前工作树的代码

首次使用时，按[商店服务账号指南](https://developer.chrome.com/docs/webstore/service-accounts)绑定账号，在专用项目启用 Chrome Web Store API 和 IAM Service Account Credentials API，给操作者授予该服务账号的 Token Creator 角色。在 `CLOUDSDK_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/cws-publisher/private-browser-toolkit"` 下运行 `gcloud auth application-default login --impersonate-service-account=<服务账号邮箱> --scopes=https://www.googleapis.com/auth/chromewebstore --disable-quota-project`。此后命令按需取得短期令牌，不需要导出私钥或打开 Chrome

## 完整流程

### 1. 基线

先运行 `git worktree list --porcelain` 并逐树核对未提交工作。全量评审、修改和测试都在包含本次工作的同一个 worktree 中进行，禁止只看主仓重做或宣称全部代码已提交

确认基线后 `git fetch`、更新 `main` 并建 `release/<version>` 分支

先运行 `yarn store:status` 核对线上版本和已送审版本。API 不返回未送审草稿的版本；如果有单独上传过的草稿，去后台「文件包」核对

仅需改商品资料、权限声明或核实后台状态时才打开网页。检查 `http://127.0.0.1:9222/json/version`，未启动就执行 `chrome cdp`，再用 `playwright.chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true })` 连接。缺少 Playwright 时装到 `/tmp`，不全局安装。复用一个页面并核对发布者和扩展 ID

### 2. 评审与本地包

代码完成后先执行 `/code-review` 并处理发现，需要简化时再执行 `/simplify`；评审未结束不得上传

升 `manifest.json` 的 `version`，确保高于线上和草稿版本。先运行 `yarn test`，再用 `node scripts/package-extension.mjs zip` 打包刚通过测试的 `dist/`，核对 ZIP 版本与文件清单。独立运行 `yarn release` 时仍会先重新构建；打包和校验分别使用系统的 `zip` 和 `unzip`

代理、组生命周期或无痕变更还要按[测试文档](testing.md)在隔离 Chrome profile 实测，不操作用户自己的代理设置或备份数据

提交前用 `git add -A` 并检查完整暂存清单，新增运行文件不得遗漏

### 3. 商店送审

只更新代码时，在包含发布提交的干净工作树执行 `yarn store:submit <版本号>`。命令先测试，再打包、校验并上传刚通过测试的 `dist/`，确认上传成功后才送审；已有版本待审时会停下来，不会撤回。成功后直接进入第 4 步，不要再走网页上传

如需在新包上传后更新商品说明、截图或隐私声明，改走以下网页流程。打开 devconsole 上传页：

https://chrome.google.com/u/1/webstore/devconsole/27bf1380-10a4-4673-a253-0da100617e74/gnpaolggdcljndfmfealhoefoopkghch/edit/package

点击「上传新的软件包」打开对话框，再对 `input[type=file]` 设置 `extension.zip`。上传后可能自动跳到商品详情，必须回「文件包」核对版本与权限，不把跳转当失败重传

若旧版本仍在审核，先取得确认，再从「商品详情 → more_vert → 取消审核」恢复可编辑草稿，不绕过商店限制

检查「商品详情」和「隐私权规范」，保存后重新读取字段确认持久化。在「商品详情」或「隐私权规范」页点击「提请审核」（文件包页没有此按钮），确认“通过审核后自动发布”已勾选再提交

### 4. 确认结果

命令行送审时，先核对命令最后打印的状态，分别确认待审核版本和线上版本。如果还没显示本次版本，再运行 `yarn store:status` 刷新；网页送审则重新读取「状态」和「文件包」。送审成功不等于已经上线

### 5. 代码收尾

合并发布分支到 `main` 并创建合并提交，再跑 `yarn test`。推送 `origin/main`，核对本地与远端 SHA

主仓重新运行 `yarn release`，确认工作区干净后删除本次 worktree 和已合并分支；有效工作合并并核实后，清理不再需要的 stash

### 6. 环境收尾

删除本次临时依赖、脚本、截图、profile 和空过程目录，关闭自己启动的测试 Chrome 与其他进程

按扩展 ID 关闭本次使用的 devconsole 页面。已有 CDP 浏览器只关页面、不退出浏览器，也不碰其他页面

关键信息回填对应主题文档；用户可见功能与权限同步 README 和商店文案。删除重复或过期内容，不另留过程文档

最后用 `git status`、`git worktree list`、`git stash list` 和页面／进程检查确认无残留

## 商店必填项与常见退回点

- 新增权限必须在「隐私权规范」标签页填使用理由，否则报“无法发布”；改动 `permissions` 后务必检查此页
- 发版前通读「商品详情 → 说明」和「隐私权规范 → 单一用途」，删掉已移除能力的描述，确保文案与当前功能、manifest 对齐
- 本扩展不收集或传输任何数据，数据使用类别一项都不勾，即“不收集用户数据”
- 勾选三条合规声明：不出售、不用于无关用途、不用于判定信用；不收集数据时隐私政策 URL 可留空

## 可复用文案

### 权限理由

- **proxy**：用于在用户主动选择时切换 Chrome 配置文件的直连或本机 SOCKS5 代理，并读取实际代理模式与控制状态，以更新弹窗和工具栏图标。默认地址为 `127.0.0.1:7890`，端口可在设置页修改；扩展不探测代理可用性，也不自行发起网络请求
- **storage**：用于保存功能开关、本机代理端口，并将标签组（组名、颜色及组内标签的网址与标题）以快照形式保存到 `chrome.storage.local` 作为本地备份，便于标签组被误删后找回。数据仅存于本机，不上传、不共享
- **unlimitedStorage**：标签组备份与历史归档持续累积、只增不删，用于解除 `storage.local` 默认约 10MB 的存储配额。全部数据仍仅存于本机，不上传、不共享
- **tabs**：用于查询和管理标签页，检测并合并重复网址标签，并读取标签所属分组以生成本地备份
- **tabGroups**：用于读取标签组的名称、颜色及成员标签，在标签组变化或被删除时生成本地备份快照

### 单一用途

在直连与本机 SOCKS5 之间切换，自动合并重复标签、将新窗口并入全屏窗口，并将标签组自动备份到本地以防误删
