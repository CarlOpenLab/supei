# Supei — AI Design Canvas

English | [简体中文](README_ZH.md)

**Supei** is an infinite-canvas AI design tool. Chat to generate HTML prototypes with live streaming preview, click any element for targeted feedback, compare variants side by side, and export a single-file interactive preview when the design settles — pulling "what should it look like" out of the AI coding loop: discuss first, implement later.

The interface follows the [wonder.design](https://wonder.design) language: layered near-black surfaces, Inter / Uncut Sans / JetBrains Mono, purple accent buttons, hairline strokes, frosted-glass overlays. The AI side ships a distilled design methodology (tokens first, type scale, restrained palettes, asymmetric composition, CJK typesetting discipline, an anti-AI-template checklist) plus **9 built-in design styles** — **Auto / Editorial Magazine / Dark Tech / Swiss International / Warm & Friendly / Neo-Brutalism / Wabi-Sabi Minimal / Linear Dark SaaS / Bauhaus Composition** — hard constraints applied to both full generation and incremental iteration.

## Highlights

**Canvas**

- Infinite canvas: damped Ctrl/⌘+wheel zoom anchored at the cursor, Space/middle-drag pan, marquee multi-select on empty space (Shift unions), arrow-key nudge (Shift = 10px), group drag with snap alignment & guides, fit-all
- Artboards: drag by header (snap alignment), batch-delete multi-select, Ctrl+A select all, Ctrl+C/V copy & paste (versions included, cascading offsets), unified context menu (keyboard navigable)
- Performance: low-zoom static snapshots (SVG foreignObject, cached in IndexedDB), offscreen iframes paused

**Versions & Diff**

- Per-artboard version history: `‹ ›` stepping, click the version number for a timeline with thumbnails and timestamps
- Version compare: side-by-side panes with three-level diff highlights (content edits purple / style changes amber / deletions red, attribute signatures and `<style>` sheet diff included), clickable stat chips filter categories
- Variant compare: one click aligns same-parent variant boards in a row, dims the rest, and pins 方案 A/B/C badges

**AI Collaboration**

- v0-style plan card: clarifying questions + style direction + multi-variant generation, iterate after you pick
- Aider-style **SEARCH/REPLACE incremental protocol**: only what you mention changes, everything else preserved verbatim, automatic full-regeneration fallback
- Deep-thinking toggle: passes `reasoning_effort=high` (model permitting)
- Parallel variants: 1–3 differentiated boards from one prompt
- **Local agents** (desktop): add Claude Code / Codex as models in Settings and generate with your own logged-in subscription; token-level streaming, and stopping kills the CLI process tree

**Manual Editing**

- ✎ Edit tool: select an element, adjust font size / weight / line-height / letter-spacing / alignment / text color / background / size / radius / opacity / padding / margin in the inspector
- Double-click to edit text in place (Enter commits, Esc reverts); hold Alt and hover other elements to measure spacing
- Edits preview live in the artboard; **Save** lands them as a new version (diffable). Auto-saved before AI iterations so manual work is never overwritten

**Live Repo Preview** (desktop)

- Pick a local frontend project from the top bar: the canvas runs its dev server (npm / pnpm / yarn / bun auto-detected) through a Go injecting proxy — HMR keeps working
- Click elements on the live page or just chat: the local agent edits repo source directly, and hot reload brings it back to the canvas
- **Capture** freezes the current page into an editable design (scripts removed, styles inlined, URLs absolutized, color scheme frozen) for AI iteration or manual editing; satisfied? **Write back** lets the agent apply a "design vs. capture" change list to your source

**Web Capture & Share** (desktop)

- **Capture page**: load any URL through the local proxy onto the canvas, close popups, settle the state, then capture it as a design
- **Share**: publish the whole project or a single artboard to the local LAN service (prefers port 7788) with a link and QR code; unpublish anytime

**Delivery**

- Per-artboard export `.html` / copy code
- **Whole-project export**: every latest artboard → one zero-dependency interactive preview page (sidebar navigation + keyboard paging, double-click to open)

**Plugins (Design Infra)**

Four plugin kinds (style / preset / template / icon) flow through one registry: create / edit / import / export (`.md` style packs or `.json`), hot-loaded from the user plugin directory (the desktop app watches it live). See `docs/plugins.md`.

## Desktop App (mygo)

Besides the browser, `desktop/` is a desktop shell built on [mygo](https://github.com/egoist/mygo) (Go + system webview, pure Go, no cgo):

```bash
cd desktop
go tool mygo dev      # desktop window (embeds Vite with --mode desktop)
go tool mygo build    # distributable installer into build/
go tool mygo doctor   # environment self-check (go / webview2 / toolchain)
```

The CLI comes from a `go.mod` `tool` directive configured in `mygo.json` — the desktop app needs only Go. Architecture:

- **Frontend**: the Vue app at the repo root is reused as-is; packaged releases embed `../dist`.
- **Go services** (`desktop/*.go`, client generated by `mygo generate` into `src/services/mygo-client.ts`):
  - `LLMService.Stream` — OpenAI-compatible requests fired from Go, tokens streamed to the page over a Channel, **bypassing browser CORS entirely**; stopping = closing the Channel cancels the HTTP request;
  - `StorageService.SaveHTML` — exports through the **native save dialog**;
  - `StorageService.ReadPluginDir / WatchPluginDir` — read and watch the user plugin directory for hot reload;
  - `AgentService.Detect / Run` (`agent.go`) — detect and run local `claude` / `codex`: design mode is tool-less in an empty temp dir (a plain LLM), code mode edits your repo; prompts go via stdin, stream-json / JSONL events are parsed;
  - `DevServerService.PickRepo / Start / Proxy` (`devserver.go`) — run the repo dev server, detect its URL from output, then serve an injecting proxy (bridge script into HTML, CSP / X-Frame-Options stripped, HMR WebSocket passed through);
  - `ShareService.Publish / List / Unpublish` (`share.go`) — LAN sharing; pages live under the user config dir `ai-design-canvas/shares/`, links survive restarts.
- Child processes (CLIs, dev servers) hide their console window on Windows and are killed as a full process tree with `taskkill /T` on cancel — no orphaned node processes.
- The frontend branches in `services/desktop.ts`: the desktop bridge is probed at runtime with `isMyGo()`, and the same page opened in a plain browser falls back to the pure web path (direct fetch). One codebase, two shapes.

Windows notes (two classic pitfalls, handled/documented in `desktop/main.go`):

1. **WebView2 runtime detection**: mygo relies on the EdgeUpdate registry value. On slimmed-down systems the runtime files may exist while the record is missing, and the app exits silently — point the value at `EdgeWebView\Application\<version>` to fix.
2. **GPU white screen**: on some GPU/driver combos WebView2 hardware acceleration renders blank. `main.go` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu` by default; delete that block if your GPU is fine.

## Quick Start

```bash
npm install
npm run dev        # http://localhost:5188
```

First run starts in **built-in demo mode** (no network calls, sample prototypes) so you can experience the full flow.

## Connecting Real Models

Top bar → Settings → Model providers → **+ Add provider**. Any OpenAI-compatible endpoint works:

| Provider | Base URL | Example model |
| --- | --- | --- |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.7` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |

API keys are stored only in local localStorage. Desktop requests leave through the Go proxy (no CORS limits); in the browser, pick a provider that allows cross-origin calls. Bad configs get a clear error card with one-click retry instead of a hang.

## Typical Workflow

1. New project → describe what you want in the chat (or tap a preset prompt); AI streams v1 artboard(s);
2. Turn on the ⌖ select tool, click a page element, give targeted feedback in the bubble (or quick commands); AI produces v2 via the incremental protocol;
3. Click the version number for the timeline, `‹ ›` between versions, "Compare previous" for diff highlights;
4. "Export preview" produces the single-file interactive page for all artboards;
5. Full shortcut list lives behind the in-app `?` help (17 entries).

## Tech Stack

Vue 3 + TypeScript + Vite + Pinia + vue-router; antdv-next as the UI base, @antdv-next/x (Bubble/Sender) for the AI chat; IndexedDB persistence (artboard data + thumbnail cache); dual LLM path — desktop Go proxy / browser direct fetch against OpenAI-compatible SSE with runtime auto-detection.

Prototype artboards are self-contained HTML rendered in sandboxed iframes; selection works through a bridge script injected into the iframe (hover highlight, click interception, Ctrl+wheel zoom & keyboard forwarding). Iteration uses the Aider-style incremental protocol: the model outputs `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks, matched exactly first then line-trimmed loosely, with automatic full regeneration fallback when any block fails.

The AI-side design system and built-in styles live in `src/plugins/registry.ts` (pluggable registry) and the `SYSTEM_PROMPT` in `src/services/generator.ts`; the end-to-end acceptance script is `scripts/e2e-final.mjs`.

## Scripts

- `npm run dev` — dev server
- `npm run build` — type check + production build
- `npm run preview` — preview the build
- `npm run build:desktop` — desktop-mode build
