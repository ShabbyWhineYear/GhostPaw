---
name: ghost-paw
description: Operate desktop applications in the background without stealing window focus or moving the user's physical mouse, with multi-sub-agent parallel Neon Hollow GhostPaw cursors. Use when automating Windows/macOS/Linux GUI apps, clicking occluded windows, or running multiple sub-agents on different desktop windows simultaneously.
---

# GhostPaw — Background Non-Focus-Stealing Computer-Use Skill

## Core Principles

1. **Always Keep `headed: false` (Default)**:
   - `GhostPaw` operates desktop applications in the background via OS accessibility trees (`UIA` / `AXUIElement` / `AT-SPI`), Win32 message passthrough (`PostMessage` / `SendNotifyMessage`), and DWM `PrintWindow` capture.
   - Never set `headed: true` unless explicitly requested by the user. Keeping `headed: false` guarantees the user's foreground window focus and physical mouse are never hijacked.

2. **Background App Launch (`launch`)**:
   - Launch or attach to a target desktop app without stealing focus:
     - MCP tool `agent_desktop`: `{ "action": "launch", "app": "calc", "headed": false }`
     - CLI: `npx ghost-paw launch --app calc`
   - Record the returned `window_id` (e.g. `"w-131820"`) and pass `windowId` in subsequent calls.

3. **Multi-Sub-Agent Parallel Execution (Zero Interference)**:
   - When multiple sub-agents operate different desktop windows simultaneously, each sub-agent MUST pass:
     - A unique `agentId` (e.g. `"subagent-calc"`, `"subagent-notepad"`)
     - Its bound `windowId` (e.g. `"w-131820"`) or `app`
     - Optional `cursorLabel` (e.g. `"SubAgent #1 · Clicking ="`)
   - `GhostPaw` automatically spawns an independent **Neon Hollow GhostPaw Cursor** + live chat bubble for each sub-agent, and routes all clicks/keystrokes directly to that sub-agent's target window handle (`HWND`).

4. **Standard Workflow**:
   - **Step 1**: `launch` or `list_windows` to obtain `windowId`.
   - **Step 2**: `snapshot` with `windowId` (`interactiveOnly: true, includeBounds: true`) to inspect interactive `@e1, @e2...` elements and their coordinates.
   - **Step 3**: `click`, `set_value`, `type`, `press`, or `scroll` using `ref` (or explicit `x, y` + `windowId`), with `agentId` set when running in parallel.
   - **Step 4**: `screenshot` with `windowId` to verify visual state via background `PrintWindow` capture.
