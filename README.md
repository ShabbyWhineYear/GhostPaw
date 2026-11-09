# 🐾 GhostPaw — Phantom Background Computer-Use for Multi-Agent Harnesses

<p align="center">
  <img src="./assets/ghostpaw-showcase-banner.png" alt="GhostPaw Neon Hollow Cursor Showcase" width="100%" />
</p>

<p align="center">
  <b>Background Window Activation · Occluded Window Passthrough · Multi-Sub-Agent Parallel Neon Hollow Cursors</b><br/>
  <sub>Built for <b>DeepSeek Harness (dsh)</b> · <b>Claude Code</b> · <b>OpenAI Codex</b> · <b>Google Antigravity</b> · <b>Cursor</b> · <b>Windsurf</b></sub>
</p>

---

## ✨ Why GhostPaw?

Traditional `computer-use` tools hijack your physical mouse cursor and force target windows to the foreground — making it impossible for you to use your computer while an AI agent works, and impossible for multiple sub-agents to operate different desktop apps in parallel.

**GhostPaw** solves this at the OS window-manager level:

1. **🔇 100% Non-Focus-Stealing Background Launch & Activation (`launch_background`)**:
   - Launches or restores desktop applications in the background (`ShowWindowAsync(SW_SHOWNOACTIVATE)` + Foreground Focus Shield on Windows, background X11/CGEvent routing on Linux/macOS) without ever stealing your active keyboard/mouse focus or altering your foreground Z-order.
2. **👻 Occluded Window Passthrough Click, Type & Screenshot (`GhostPawWin32BgV4`)**:
   - Sends clicks, double-clicks, right-clicks, text input (`WM_CHAR` / `EM_REPLACESEL` / UIA `ValuePattern`), keystrokes, and mouse wheel scrolling directly to background or partially/fully occluded windows (`HWND` / `CoreWindow` / `UIA` / `AT-SPI` / `AXUIElement`).
   - Captures crystal-clear screenshots of occluded windows via DWM `PrintWindow(PW_RENDERFULLCONTENT)` without bringing them to the front.
3. **🐾 Multi-Sub-Agent Parallel Execution & Neon Hollow GhostPaw Cursor**:
   - Multiple sub-agents (plus the main agent) can operate different desktop windows **at the exact same millisecond** without interfering with each other or with your physical mouse.
   - Each agent displays an independent **Neon Hollow GhostPaw Cursor** (Aurora Mint-Cyan `#00FFD6` → Cyber Magenta `#FF248F` glowing hollow paw print with a transparent core so underlying button text remains readable right through the cursor!) + a live status bubble that automatically vanishes after 10 seconds of inactivity.

---

## 🚀 Quick Start by Harness

### 1. DeepSeek Harness (`dsh`)

#### Option A — Via DSH Decentralized Plugin Market (`market-index.json`)
Add the GhostPaw Market Index URL to your DSH Plugin Market sources:
```text
https://raw.githubusercontent.com/ShabbyWhineYear/GhostPaw/main/market-index.json
```
Then search for **`ghost-paw`** in DSH and click install.

#### Option B — Direct Profile Installation (`cordis.patch.yml`)
Install into your DSH profile (`~/.dsh/profiles/desktop`) and enable in `cordis.patch.yml`:
```yaml
plugins:
  ghost-paw:
    enableSystemPrompt: true
    systemPromptOrder: 45
```

---

### 2. Claude Code (`claude`)

Add GhostPaw as an MCP server with a single command:
```bash
claude mcp add ghost-paw -- npx -y github:ShabbyWhineYear/GhostPaw mcp
```
*(Or copy [`skills/ghost-paw/SKILL.md`](./skills/ghost-paw/SKILL.md) into `~/.claude/skills/ghost-paw/SKILL.md`.)*

---

### 3. OpenAI Codex CLI / App (`codex`)

Add to `~/.codex/config.toml`:
```toml
[mcp_servers.ghost_paw]
command = "npx"
args = ["-y", "github:ShabbyWhineYear/GhostPaw", "mcp"]
```

---

### 4. Google Antigravity (`agy`) / Cursor / Windsurf / Cline

Add to your `mcp_config.json` (or `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "ghost-paw": {
      "command": "npx",
      "args": ["-y", "github:ShabbyWhineYear/GhostPaw", "mcp"]
    }
  }
}
```

---

## 🛠️ Provided Tools (`agent_desktop` & `computer`)

### `agent_desktop` (Semantic + Coordinate Background Engine)

| Action | Description |
| :--- | :--- |
| `launch` | Launch or attach to an app (`app: "calc"`, `headed: false`) in the background without stealing focus; returns `window_id` (`w-<hwnd>`). |
| `list_windows` | List all open desktop windows with `id`, `title`, `app`, `pid`, and `bounds`. |
| `snapshot` | Capture the accessibility tree (`@s1:e1`, `@s1:e2`...) and element bounds of a target `windowId` or `app`. |
| `click` / `double_click` / `right_click` | Click a semantic `ref` (e.g. `"e5"`) or explicit `(x, y)` inside `windowId` in the background while presenting the Neon Hollow GhostPaw cursor. |
| `set_value` / `type` / `clear` | Input text into a background control or editor (`ref` or `x, y` + `windowId`) without stealing keyboard focus. |
| `press` | Send keyboard shortcuts (`key: "ctrl+s"`, `"return"`, `"escape"`) directly to a background window. |
| `scroll` | Scroll (`direction: "down"`, `amount: 3`) inside a background window. |
| `screenshot` | Capture a background/occluded window via DWM `PrintWindow`. |
| `batch` | Execute a sequence of background actions atomically with continuous GhostPaw cursor animation. |

### Multi-Sub-Agent Parallel Example

When spawning multiple sub-agents to operate different desktop windows simultaneously, pass a distinct `agentId` and `windowId` per sub-agent:

```json
// Sub-Agent #1 (Operating Windows Calculator in background)
{
  "action": "click",
  "windowId": "w-131820",
  "ref": "e18",
  "agentId": "subagent-calc",
  "cursorLabel": "CalcAgent · Clicking 9",
  "headed": false
}
```

```json
// Sub-Agent #2 (Operating Windows Notepad at the exact same instant)
{
  "action": "type",
  "windowId": "w-263044",
  "x": 980,
  "y": 420,
  "text": "Written in parallel without focus conflict!\n",
  "agentId": "subagent-notepad",
  "cursorLabel": "NotepadAgent · Typing line",
  "headed": false
}
```

---

## 📄 License

[MIT](./LICENSE) © ShabbyWhineYear
