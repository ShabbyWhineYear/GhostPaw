#!/usr/bin/env node
/**
 * GhostPaw Universal CLI & MCP Entry Point
 *
 * Usage:
 *   ghost-paw mcp                                     # Start MCP stdio server (Claude Code / Codex / Antigravity / Cursor)
 *   ghost-paw <action> [options]                      # Execute an agent_desktop action in background
 *   ghost-paw computer <action> [options]             # Execute a coordinate computer-use action
 *   ghost-paw --help | --version
 */
import { basename } from 'node:path';
import { executeAgentDesktopAction } from './agent-desktop/index.js';
import { createGhostPawStandaloneTools, startGhostPawMcpServer } from './mcp-server.js';
function parseCliFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--'))
            continue;
        const eqIdx = token.indexOf('=');
        let rawKey;
        let rawVal;
        if (eqIdx >= 0) {
            rawKey = token.slice(2, eqIdx);
            rawVal = token.slice(eqIdx + 1);
        }
        else {
            rawKey = token.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                rawVal = next;
                i++;
            }
        }
        const camelKey = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (rawVal === undefined || rawVal === 'true') {
            out[camelKey] = true;
        }
        else if (rawVal === 'false') {
            out[camelKey] = false;
        }
        else if (/^-?\d+(\.\d+)?$/.test(rawVal) && ['x', 'y', 'width', 'height', 'amount', 'maxDepth', 'timeoutMs', 'durationMs', 'windowHandle', 'pid'].includes(camelKey)) {
            out[camelKey] = Number(rawVal);
        }
        else {
            out[camelKey] = rawVal;
        }
    }
    return out;
}
function printHelp() {
    console.log(`GhostPaw v0.1.0 — Phantom Background Computer-Use & Multi-Agent Neon Hollow Cursor Engine

Usage:
  ghost-paw mcp                                     Start Standard MCP Server over stdio
  ghost-paw <action> [options]                      Run background agent_desktop action
  ghost-paw computer <action> [options]             Run coordinate computer-use action

Common Actions:
  launch            Launch or attach to an app in the background without stealing focus
  list_windows      List open desktop windows with windowId (w-<hwnd>) and bounds
  snapshot          Capture accessibility tree (@e1, @e2...) of a background window
  click             Click an @ref or (x, y) in the background with Neon Hollow GhostPaw cursor
  type              Type text into an @ref or (x, y) in the background
  set_value         Set value of an @ref control directly
  press             Send key combo (e.g. --key ctrl+s, return) to a background app
  screenshot        Capture occluded/background window via DWM PrintWindow

Options:
  --app <name>            Target application name or executable (e.g. "calc", "notepad")
  --window-id <id>        Target window ID (e.g. "w-131820")
  --ref <ref>             Target accessibility element reference (e.g. "e5" or "@s1:e5")
  --x <px> --y <px>       Target screen coordinates
  --text <str>            Text to type or set
  --key <combo>           Key or shortcut to press
  --agent-id <id>         Sub-agent identifier for parallel isolated Neon Hollow cursors
  --cursor-label <text>   Custom live chat bubble text next to the GhostPaw cursor
  --headed                Allow physical focus/mouse movement (default: false)
`);
}
async function main() {
    const binName = basename(process.argv[1] || 'ghost-paw').replace(/\.(cjs|mjs|js|ts)$/i, '');
    const args = process.argv.slice(2);
    if (binName === 'ghost-paw-mcp' || args[0] === 'mcp' || args[0] === 'serve-mcp') {
        startGhostPawMcpServer();
        return;
    }
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }
    if (args.includes('--version') || args.includes('-v')) {
        console.log('0.1.0');
        return;
    }
    if (args[0] === 'computer') {
        const subAction = args[1] || 'screenshot';
        const flags = parseCliFlags(args.slice(2));
        const tools = createGhostPawStandaloneTools();
        const compTool = tools.get('computer');
        if (!compTool) {
            throw new Error('computer tool not registered');
        }
        const res = await compTool.execute({ action: subAction, ...flags });
        console.log(JSON.stringify(res, null, 2));
        process.exit(res.ok === false ? 1 : 0);
    }
    const action = args[0];
    const flags = parseCliFlags(args.slice(1));
    const toolArgs = {
        ...flags,
        action,
    };
    const result = await executeAgentDesktopAction(toolArgs);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok === false ? 1 : 0);
}
main().catch(err => {
    console.error(JSON.stringify({ ok: false, error: { message: err instanceof Error ? err.message : String(err) } }));
    process.exit(1);
});
