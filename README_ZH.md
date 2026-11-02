# Supei — AI 原型画布

简体中文 | [English](README.md)

Supei 是一块与 AI 协作的无限画布：聊天生成、流式预览、点选元素定向反馈、多方案并排对比。整体效果敲定后一键导出单文件交互式预览页或各画板 HTML，交给正式开发——把「设计长什么样」从 AI 编码流程里拆出来，先讨论、后实现。

界面语言对齐 [wonder.design](https://wonder.design)：中性近黑分层、Inter / Uncut Sans / JetBrains Mono 三字体体系、蓝色高光主按钮、发丝级描边、毛玻璃浮层，支持暗黑 / 白天主题切换并持久化。AI 侧内置一套蒸馏自专业设计方法论的设计规范（设计令牌先行、字号阶梯、克制配色、非对称构图、CJK 排版纪律、反 AI 模板腔清单），并附带 9 个内置设计风格（**自动 / 编辑杂志风 / 深色科技 / 瑞士国际主义 / 温和亲和 / 新粗野主义 / 侘寂极简 / Linear 深色 SaaS / 包豪斯构成**）——生成与增量迭代都会以所选风格强约束产出。

## 核心能力

**画布**

- 无限画布：Ctrl/⌘+滚轮阻尼缩放（锚点不漂）、底部工具栏抓手（左键拖动画布，画板上方也可起手）、Space/中键平移、空白区左键框选多选（Shift 并集）、方向键微移（Shift=10px）、组拖拽整体吸附对齐、Fit 全部
- 画板：拖拽头栏移动（单选吸附对齐 + 参考线）、多选批量删除、Ctrl+A 全选、Ctrl+C/V 复制粘贴（含版本、级联偏移）、右键统一菜单（键盘可导航）
- 性能：低缩放自动切换静态快照（SVG foreignObject，IndexedDB 持久缓存）、离屏 iframe 暂停

**平铺画板与对比**

- Figma 式平铺：每次 AI 迭代 / 手动保存都在源画板右侧生成一块新画板，源画板原样保留，分支之间互不覆盖
- 方案对比：同源方案画板一键对齐排版 + 压暗其余 + 方案 A/B/C 角标
- 版本对比仍保留在画板菜单（适用于带多个版本的旧项目）：双栏并排 + 三级 diff 高亮（内容修改紫色 / 样式变化琥珀 / 删除红色，含属性签名与 `<style>` 样式表对比），统计 chip 可点击过滤类别

**AI 协作**

- v0 式对话流：AI 规划卡（澄清问题 + 风格方案 + 多方向并排生成）、迭代意图确认；每个问题都可自由输入自定义答案
- **参考图 / 资料附件**：输入卡支持选取、拖入、粘贴图片与文本资料（md / txt / csv / 代码等），图片以缩略图随消息展示，文本正文自动拼入提示词作为生成上下文
- **页面 / 组件双模式**：按需求自动判断产出整页原型还是单个 UI 组件，规划卡可改选类型；组件以状态 / 变体规格展示稿输出，不生成页面框架
- Aider 风格 **SEARCH/REPLACE 增量协议**：只改你指的地方，未提及部分逐字保留，失败自动回退全量
- 深度思考开关：透传 `reasoning_effort=high`（部分模型支持）
- 并行方案：一次需求并排 1–3 个差异化方案画板
- **本机 Agent**（桌面端）：设置里把 Claude Code / Codex 添加为模型，规划、生成、增量迭代都用你自己已登录的订阅；Claude Code 逐 token 流式，停止即杀掉 CLI 进程树

**手动编辑**

- ✎ 编辑工具：点选元素，在右侧检查器调字号 / 字重 / 行高 / 字距 / 对齐 / 文字色 / 背景 / 宽高 / 圆角 / 不透明度 / 内外边距
- 双击文字就地改字（Enter 完成、Esc 撤销）；选中后按住 Alt 悬停其它元素，测量间距
- 修改先在画板里实时预览，「保存」在源画板右侧生成含修改的新画板；未保存的修改会被带入下一次 AI 迭代，不会丢失

**代码仓库实时预览**（桌面端）

- 顶栏「代码仓库」选择本地前端项目：在画布上运行 dev server（自动识别 npm / pnpm / yarn / bun），经 Go 注入代理加载，HMR 照常工作
- 在实时页面上点选元素或直接对话：本机 Agent 直接改仓库源码，保存后热更新回画布
- 「捕获」把当前页面固化成可编辑设计稿（脚本移除、样式内联、资源地址绝对化、明暗配色冻结），再用 AI 迭代或手动编辑；满意后在画板菜单选「写回代码」，Agent 按「设计稿相对捕获时的改动清单」修改源码

**网页捕获与分享**（桌面端）

- 「捕获网页」：任意网址经本机代理加载到画布，关掉弹窗、调好状态后「捕获」为设计稿
- 「分享」：整项目或单块画板发布到本机局域网服务（优先 7788 端口），给出链接与二维码，同网络扫码即看；可随时撤销

**交付**

- 单画板导出 .html / 复制代码
- **整项目导出**：全部画板最新版 → 单文件交互式预览页（侧栏导航 + 键盘翻页，零依赖，双击即看）

**插件（Design Infra）**

四类插件（style / preset / template / icon）经统一 registry 注入：新建/编辑/导入导出（单文件 `.md` 风格包或 `.json`）/ 从插件目录热加载（桌面端监听目录变化即装即用）。详见 `docs/plugins.md`。

## 桌面端（mygo）

除浏览器访问外，仓库内的 `desktop/` 是基于 [mygo](https://github.com/egoist/mygo)（Go + 系统 webview，纯 Go 无 cgo）的桌面壳：

```bash
cd desktop
go tool mygo dev      # 桌面窗口（内嵌 Vite，--mode desktop；CLI 来自 go.mod 的 tool 指令）
go tool mygo build    # 打包出可分发的安装产物到 build/
go tool mygo doctor   # 环境自检（go/webview2/打包工具链）
```

CLI 通过 go.mod 的 `tool` 指令引入，配置在 `mygo.json`——启动桌面端只需要 Go。架构与分工：

- **前端**：仓库根目录的 Vue 应用原样复用，打包时嵌入 `../dist`。
- **Go 服务**（`desktop/*.go`，经 `mygo generate` 生成 `src/services/mygo-client.ts`）：
  - `LLMService.Stream` — OpenAI 兼容请求在 Go 侧发起，token 以 Channel 流式推给前端，**彻底绕开浏览器 CORS**；停止生成 = 关闭 Channel，Go 侧请求随之取消；
  - `StorageService.SaveHTML` — 导出走**原生保存对话框**；
  - `StorageService.ReadPluginDir / WatchPluginDir` — 读取并监听用户插件目录，热加载；
  - `AgentService.Detect / Run`（`agent.go`）— 探测并运行本机 `claude` / `codex`：design 模式无工具、空目录，等同纯文本模型；code 模式在仓库里改代码。prompt 走 stdin，解析 stream-json / JSONL 事件；
  - `DevServerService.PickRepo / Start / Proxy`（`devserver.go`）— 运行仓库 dev server，从输出里识别地址，再起一个注入代理（把 bridge 脚本注入 HTML、去掉 CSP / X-Frame-Options、透传 HMR WebSocket）；
  - `ShareService.Publish / List / Unpublish`（`share.go`）— 局域网分享服务，页面存放在用户配置目录 `ai-design-canvas/shares/`，重启后链接仍有效。
- 子进程（CLI、dev server）在 Windows 上隐藏控制台窗口，取消时用 `taskkill /T` 杀掉整棵进程树，不留孤儿 node 进程。
- 前端通过 `services/desktop.ts` 区分环境：桌面桥接用 `isMyGo()` 运行时真实探测，普通浏览器打开同一页面自动回退纯 Web 路径（fetch 直连），同一份代码两种形态。

Windows 注意（两个常见坑，`desktop/main.go` 已内置处理/说明）：

1. **WebView2 Runtime 探测**：mygo 依赖 EdgeUpdate 注册表记录。若机器上 runtime 文件存在但记录缺失（精简系统常见），应用会静默退出——把该值指向 `EdgeWebView\Application\<版本>` 目录即可修复。
2. **GPU 白屏**：部分显卡/驱动上 WebView2 硬件加速白屏。`main.go` 启动时默认设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu`；若 GPU 正常想要硬件加速，删掉 main.go 里这段即可。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5188
```

首次使用需先配置模型：输入区的模型选择器会引导你打开「设置 → 模型设置」。

## 接入真实模型

顶栏「设置」→ 模型设置 → **+ 添加服务商**，任意 OpenAI 兼容接口均可；设置弹窗内置预设可一键快速添加：

| 服务商 | Base URL | 模型示例 |
| --- | --- | --- |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Magpie 网关（本机） | `http://127.0.0.1:3425/v1` | 从网关自动拉取模型列表 |

API Key 仅保存在本机 localStorage。桌面端请求经 Go 代理发出（无 CORS 限制）；浏览器直连时若服务商不允许跨域，换用支持的服务商即可。配置错误（地址/Key 无效）会得到明确的错误卡与一键重试，不会卡死。

## 使用流程

1. 新建项目 → 左侧聊天描述需求（或点预设提示词），AI 流式生成 v1 原型画板；
2. 开启「⌖ 点选模式」点击页面元素，在气泡中输入定向反馈（或快捷指令），AI 以增量协议在右侧生成一块新画板；
3. 用「方案对比」把同源画板对齐比较，或在画板菜单里点「对比上一版」看 diff 高亮；
4. 顶栏「导出预览」一键产出全部画板的单文件交互式预览页；
5. 完整快捷键清单见应用内 `?` 帮助（17 项）。

## 技术栈

Vue 3 + TypeScript + Vite + Pinia + vue-router；UI 基座 antdv-next，AI 聊天组件 @antdv-next/x（Bubble）；持久化 IndexedDB（画板数据 + 缩略图缓存双库）；LLM 双路径——桌面 Go 代理 / 浏览器 fetch 直连的 OpenAI 兼容 SSE，运行时自动探测降级。

原型画板为沙箱 iframe 渲染的自包含 HTML；点选功能通过注入 iframe 的 bridge 脚本实现（hover 高亮、点击拦截、Ctrl+滚轮缩放与键盘事件转发）。迭代采用 Aider 风格增量协议：模型只输出 `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` 修改块，应用时先精确匹配再按行 trim 宽松匹配，任一块失败自动回退全量重生成。

AI 侧设计规范与内置风格位于 `src/plugins/registry.ts`（插件化 registry）与 `src/services/generator.ts` 的 `SYSTEM_PROMPT`；端到端验收脚本见 `scripts/e2e-final.mjs`。

## 脚本

- `npm run dev` — 开发服务器
- `npm run build` — 类型检查 + 生产构建
- `npm run preview` — 预览构建产物
- `npm run build:desktop` — 桌面模式构建
