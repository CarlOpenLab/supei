# AI 原型画布

在无限画布上与 AI 一起打磨网页原型：聊天生成、流式预览、点选元素定向反馈、多画板并排对比。整体效果敲定后导出 HTML，再进入正式开发——把「设计长什么样」从 AI 编码流程里拆出来，先讨论、后实现。

界面按「工作室工作台」方向设计：深炭工具栏 + 暖纸画布 + 朱红强调 + 衬线标题。AI 侧内置了一套蒸馏自专业设计方法论的设计规范（设计令牌先行、字号阶梯、克制配色、非对称构图、CJK 排版纪律、反 AI 模板腔清单），并附带 8 个内置设计风格：**自动 / 编辑杂志风 / 深色科技 / 瑞士国际主义 / 温和亲和 / 新粗野主义 / 侘寂极简 / Linear 深色 SaaS / 包豪斯构成**——在聊天底部「设计风格」选择后，生成结果会以该风格强约束产出。

## 设计风格插件（风格包）

内置风格之外，用户可以拥有自己的风格库（设置 → 设计风格）：

- **新建/编辑**：名称 + 一段风格指令（写清配色、字体、构图手法与禁止项即可）；
- **风格包分享**：每个风格可导出为单文件 `.md`（YAML frontmatter + 正文指令），也可导出全部为 `.json`；导入 `.md` / `.json` 即装即用，无需改代码；
- 内置风格只读，可「复制为自定义」后修改；
- 自定义风格保存在本机 localStorage，与内置风格在下拉中分组显示，生成与增量迭代都会携带所选风格。

## 桌面端（mygo）

除浏览器访问外，仓库内的 `desktop/` 是基于 [mygo](https://github.com/egoist/mygo)（Go + 系统 webview，纯 Go 无 cgo）的桌面壳：

```bash
cd desktop
go tool mygo dev      # 桌面窗口（内嵌 Vite，--mode desktop；CLI 来自 go.mod 的 tool 指令）
go tool mygo build    # 打包出可分发的安装产物到 build/
go tool mygo doctor   # 环境自检（go/webview2/打包工具链）
```

CLI 通过 go.mod 的 `tool` 指令引入（`go get -tool github.com/egoist/mygo/cmd/mygo`），配置在 `mygo.json`——启动桌面端只需要 Go，不再依赖 npm/bun。

架构与分工：

- **前端**：仓库根目录的 Vue 应用原样复用。`mygo dev` 拉起根目录 Vite（`--mode desktop`）并加载；打包时嵌入 `../dist`。
- **Go 服务**（`desktop/main.go`，经 `mygo generate` 生成 `src/services/mygo-client.ts`）：
  - `LLMService.Stream` — OpenAI 兼容请求在 Go 侧发起，token 以 Channel 流式推给前端，**彻底绕开浏览器 CORS**；前端停止生成 = 关闭 Channel，Go 侧请求随之取消；
  - `StorageService.SaveHTML` — 导出原型走**原生保存对话框**；
  - `StorageService.ReadStyleFiles` — 原生文件选择器读取本地 `.md`/`.json` 风格包。
- 前端通过 `services/desktop.ts` 的 `IS_DESKTOP`（Vite mode）区分环境：浏览器访问自动回退纯 Web 路径，同一份代码两种形态。

Windows 注意（两个常见坑，`desktop/main.go` 已内置处理/说明）：

1. **WebView2 Runtime 探测**：mygo 依赖 EdgeUpdate 注册表记录（`HKCU\SOFTWARE\Microsoft\EdgeUpdate\ClientState\{F3017226-…}\EBWebView`）。若机器上 runtime 文件存在但记录缺失（精简系统常见），应用会静默退出——把该值指向 `EdgeWebView\Application\<版本>` 目录即可修复。
2. **GPU 白屏**：部分显卡/驱动上 WebView2 硬件加速白屏。`main.go` 启动时默认设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu`；若你的机器 GPU 正常想要硬件加速，删掉 main.go 里这段或自行设置该变量即可。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:5188
```

首次使用默认处于「内置演示模式」（不调用网络，输出样例原型，用于体验完整流程）。

## 接入真实模型

右上角「设置」→ 添加服务商，任意 OpenAI 兼容接口均可：

| 服务商 | Base URL | 模型示例 |
| --- | --- | --- |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

API Key 仅保存在本机浏览器 localStorage，请求由浏览器直连服务商。若某服务商不允许浏览器跨域直连（CORS），换用支持的服务商即可。

## 使用流程

1. 新建项目 → 在左侧聊天中描述页面需求（或点预设提示词），AI 流式生成 v1 原型画板；
   - 底部「并行方案」可切换 1–3 个：一次需求并排出多个差异化方案画板，方便对比选型；
2. 开启画板头栏的「⌖ 点选模式」，点击页面里的任意元素，在气泡中输入定向反馈（或点快捷指令：更醒目 / 更紧凑 / 加圆角 / 换强调色…），AI 以 **SEARCH/REPLACE 增量协议** 只改你指的地方，产生 v2——未提及的部分逐字保留，失败自动回退全量生成；
3. 头栏 `‹ ›` 在版本间切换/回退；「⋯」菜单可导出 .html、复制代码、创建副本（做 A/B 方案并排对比）；
4. 画布支持滚轮平移、Ctrl/⌘+滚轮缩放、拖拽头栏移动画板、⛶ 适配全部；
5. 快捷键：`Esc` 取消选中 · `0` 缩放 100% · `1` 适配全部 · `Ctrl/⌘+D` 复制画板 · `Del` 删除画板（画板获得焦点时由 iframe 内 bridge 转发）；
6. 生成失败后消息下方可一键「重试」。

## 技术栈

Vue 3 + TypeScript + Vite + Pinia + vue-router；UI 基座 antdv-next，AI 聊天组件 @antdv-next/x（Bubble/Sender）；持久化 IndexedDB；LLM 走浏览器直连的 OpenAI 兼容 SSE。

原型画板为沙箱 iframe 渲染的自包含 HTML；点选功能通过注入 iframe 的 bridge 脚本实现（hover 高亮、点击拦截、Ctrl+滚轮缩放与键盘事件转发）。迭代采用 Aider 风格增量修改协议：模型只输出 `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` 修改块，应用时先精确匹配再按行 trim 宽松匹配，任一块失败自动回退全量重生成。

AI 侧的设计规范与风格预设位于 `src/services/styles.ts` 与 `generator.ts` 的 `SYSTEM_PROMPT`，可按需扩充自己的风格库。

## 脚本

- `npm run dev` — 开发服务器
- `npm run build` — 类型检查 + 生产构建
- `npm run preview` — 预览构建产物
