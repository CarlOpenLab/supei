# Design Infra 插件开发指南

本应用的能力层是插件化的：设计风格、需求预设、画板模板、图标集都是**插件**，通过统一的注册表（`src/plugins/registry.ts`）注入。内置插件与用户插件走同一条查询路径——任何第三方能力只要符合格式就能接入，无需改核心代码。

## 插件类型（kind）

| kind | data 结构 | 消费方 |
| --- | --- | --- |
| `style` | `{ prompt: string }` | 生成时的 system prompt 风格段（AI 规划卡选定 / 设置预设） |
| `preset` | `{ icon: string, prompt: string }` | 聊天空态的一键起点（icon 为 AppIcon 图标名） |
| `template` | `{ width: number, height: number }` | 「新建画板」尺寸预设、新画板默认尺寸 |
| `icon` | `Record<name, svgPathD>` | AppIcon 图标集扩展 |

## 插件包格式（分享 / 导入）

单文件 `.json`，一个包可携带任意数量、任意 kind 的插件：

```json
{
  "format": "mygo-design-plugin",
  "name": "我的风格包",
  "plugins": [
    { "kind": "style", "name": "孟菲斯波普", "prompt": "【设计风格：…】\n- …" },
    { "kind": "template", "name": "海报 1080×1920", "width": 1080, "height": 1920 }
  ]
}
```

兼容格式：旧版单风格包 `{ "name": "…", "prompt": "…" }` 与 `.md` 风格包（YAML frontmatter `name:` + 正文指令）自动识别为 style 插件。

## 导入方式

1. **应用内**：设置 → 插件 → 导入插件包（桌面端走原生文件对话框）；
2. **代码注册**：`import { pluginRegistry } from '@/plugins/registry'` 后调用 `pluginRegistry.addUserPlugin({ kind, name, data })`；
3. **本地目录**（规划中）：桌面壳的 `StorageService.ReadStyleFiles` 已具备读取本地目录的能力，可扩展为监听一个 plugins 目录自动加载。

## 内置插件

全部在 `src/plugins/registry.ts` 的 `BUILTINS` 数组中，与用户插件同构。想新增内置能力：往数组里加一条即可。内置插件不可删除，可停用、可「复制为自定义」后修改。

## 设计约定

- 消费方**永远**通过 `pluginRegistry.listByKind(kind)` / `stylePrompt(id)` 读取能力，禁止在组件里硬编码具体风格 / 预设 / 尺寸 / 图标；
- 用户插件持久化在 localStorage（`dc.plugins.v1`），包含启停状态；
- 插件 `data` 为纯 JSON（可序列化），保证包导入导出无损。
