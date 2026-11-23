# Private Browser Toolkit

一个 Chrome 扩展，提供代理切换、标签页管理和标签组本地备份功能

## 功能特性

### 网络代理

- **两种模式切换**：点击工具栏图标，在弹窗中选择直连或本机 SOCKS5，对整个 Chrome 配置文件生效
- **本机代理**：默认使用 `127.0.0.1:7890`，地址与协议固定，不提供多配置、PAC 或认证管理。本扩展正在管理 SOCKS5 代理时，保存端口会立即生效。若 Chrome 原本就在使用另一个本机 SOCKS5 端口，且允许本扩展更改代理，保存后可在弹窗点击「本机 SOCKS5」应用新端口
- **状态图标**：工具栏、弹窗和设置页同步显示实际代理状态，三色实心圆点表示直连，三色空心圆点表示本机 SOCKS5，灰色表示跟随系统设置或其他代理模式；工具栏悬停可查看具体状态文字
- **真实状态**：以 Chrome 当前代理设置为准，不轮询、不探测代理可用性，也不把设置成功显示为连接健康
- **共存提示**：代理由其他扩展控制时只提示，不抢控制权；替换旧代理扩展时，先停用旧扩展再选择模式

#### 从本机脚本切换

不需要常驻辅助进程。外部脚本打开一次性扩展页面，成功后页面自动关闭，失败时保留页面显示原因；相同模式不会重复写入

```bash
# 直连
open -g -a "Google Chrome" \
  "chrome-extension://gnpaolggdcljndfmfealhoefoopkghch/switch.html?mode=direct"

# 本机 SOCKS5
open -g -a "Google Chrome" \
  "chrome-extension://gnpaolggdcljndfmfealhoefoopkghch/switch.html?mode=socks5"
```

以上使用商店版扩展 ID；加载未打包扩展时，将 URL 中的 ID 替换为 `chrome://extensions/` 显示的实际 ID。Chrome 未运行时，命令会启动 Chrome

### 标签页管理

- **重复标签检测**：自动检测并合并网址完全相同的标签页，可在设置页关闭。已有后台标签跳转不新触发去重，固定标签在普通网址下保留；`chrome://new*` 和 `about:blank` 保留新页面并关闭旧页面
- **新窗口并入全屏窗口**：只有一个全屏候选窗口时，自动将新开的单标签普通窗口并入其中，可在设置页关闭

两个开关分别保存，切回已打开的设置页时会显示最新值

### 标签组本地备份

- **自动备份**：在本机保存组名、颜色、组内标签的网址、标题和排列顺序；Chrome 重启并恢复会话后，可唯一匹配的组沿用快照，不因组编号变化额外归档
- **组删除可找回**：取消分组、关闭或移出最后标签时，只要已有有效快照就保留归档，便于误删后手动恢复
- **查看备份**：从弹窗底部进入「标签组备份」，先看份数，展开后可查看或复制 JSON。读取期间暂时不能刷新，失败后可以重试
- **导出最新备份**：点击时重新读取本机备份并导出 JSON，不必先刷新预览。可按文件中的网址和组信息手动重建标签组
- **持续保留**：有效归档只增不删；数据仅保存在本机，导出的 JSON 也请妥善保管

### 使用边界

无痕窗口中不提供代理切换或端口修改，也不执行重复标签合并、新窗口并入全屏窗口或标签组备份。请在普通窗口中查看或导出备份

## 安装方式

从 [Chrome 应用商店](https://chromewebstore.google.com/detail/gnpaolggdcljndfmfealhoefoopkghch) 安装

## 开发

### 从源码构建

```bash
git clone git@github.com:adaex/chrome-private-browser-toolkit.git
cd chrome-private-browser-toolkit
yarn
yarn build
```

然后在 Chrome 中加载扩展：

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”，选择项目的 `dist` 文件夹

### 开发模式

首次构建后，运行以下命令监听 TypeScript 变化：

```bash
yarn dev
```

### 构建与测试

- `yarn build`：构建到 `dist/`
- `yarn test`：重新构建并运行回归测试

测试使用 Node 内置 test runner 和轻量 Chrome API mock，不需要额外测试依赖，覆盖代理模式与图标、外部扩展控制、分组生命周期、无痕隔离、迁移失败和标签操作边界；真实代理设置、窗口和标签事件仍应在 Chrome 中回归

### 打包与商店发布

- `yarn release`：重新构建并替换本地 `extension.zip`，不上传
- `yarn store:status`：查询商店的线上版本和审核状态
- `yarn store:submit <版本号>`：从当前工作树测试、打包并送审，通过审核后自动发布

后两条命令需要本机发布授权，不需要打开 Chrome。配置方法和完整发版步骤见[发布流程](docs/release.md)

## 项目结构

```
├── manifest.json          # 扩展清单文件
├── package.json           # 项目配置
├── tsconfig.json          # TypeScript 配置
├── popup.html             # 工具栏代理切换弹窗
├── popup.ts               # 弹窗交互
├── switch.html            # 外部命令使用的一次性代理切换页
├── switch.ts              # 外部代理指令校验、切换与自动关页
├── ui.ts                  # 页面共用的状态展示
├── options.html           # 功能设置与备份查看页
├── options.ts             # 设置页逻辑
├── ui.css                 # 弹窗与设置页共用的亮色样式
├── icon/                  # 品牌图标与当前代理状态图标
├── design/icon-states/    # 可替换的代理图标候选，不进入发布包
├── docs/                  # 按需阅读的架构、实测与发布文档
├── scripts/               # 本地打包、商店查询和送审脚本，不进入扩展包
├── tests/                 # Node 内置 test runner 回归测试
└── worker/                # Service Worker 脚本与共享模块
    ├── queue.ts           # 串行队列实现
    ├── proxy.ts           # 代理设置、状态读取与工具栏图标
    ├── tabs.ts            # 标签页管理（重复检测、全屏窗口）
    ├── backup.ts          # 标签组本地备份（storage.local，会话标记在 storage.session）
    ├── settings.ts        # 功能开关读写
    ├── groupCache.ts      # 标签与组对象缓存
    └── index.ts           # 入口文件、事件监听器
```

## 权限说明

- `proxy`：在用户主动选择时，切换 Chrome 配置文件的直连或本机 SOCKS5 代理，并读取实际模式以更新弹窗与工具栏图标
- `tabs`：管理标签页，检测重复标签，读取组内标签以生成备份
- `tabGroups`：读取标签组名称、颜色及成员标签，在标签组变化或被删除时生成本地备份快照
- `storage`：保存功能开关、本机代理端口与标签组备份，并用会话内标记区分 Chrome 重启与 Service Worker 重启
- `unlimitedStorage`：解除本地备份持续累积时的默认存储配额

## 技术栈

TypeScript、ES Modules、Manifest V3、原生 HTML/CSS，无 UI 框架

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个项目
