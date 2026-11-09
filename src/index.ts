/**
 * GhostPaw — Phantom Background Computer-Use & Multi-Agent Neon Hollow Cursor Engine
 *
 * Compatible with:
 * - DeepSeek Harness (`dsh`) via native Cordis plugin (`apply`)
 * - Claude Code, OpenAI Codex, Google Antigravity, Cursor, Windsurf, Cline via MCP (`npx -y ghost-paw mcp`)
 * - Universal CLI & Agent Skills (`ghost-paw <action>`)
 *
 * @module ghost-paw
 */

import type { Context } from '@deepseek-ai/cordis'
import './types.js'
import { applyAgentDesktopTool } from './agent-desktop/index.js'
import { applyComputerUseTool } from './computer-use/index.js'

export type * from './types.js'

export {
  GHOSTPAW_CURSOR_HOTSPOT,
  GHOSTPAW_CURSOR_PNG_BASE64,
  STAR_CURSOR_DATA_URI,
} from './cursor-asset.js'

export { extractTarGzBuffer } from './tar-utils.js'

export {
  AGENT_DESKTOP_VERSION,
  AGENT_DESKTOP_RELEASE_MATRIX,
  CURSOR_IDLE_AUTO_HIDE_MS,
  STAR_CURSOR_HOTSPOT,
  sanitizeLosslessJson,
  resolveAgentDesktopTarget,
  getAgentDesktopRootDir,
  getAgentDesktopStateDir,
  ensureStarCursorAsset,
  ensureAgentDesktopBinary,
  runAgentDesktopCli,
  qualifyAgentDesktopRef,
  findBestRefAtPoint,
  resolveMacosNativeHelperPath,
  executeMacosBackgroundPointAction,
  executeMacosBackgroundPointActionAsync,
  executeWindowsBackgroundPointAction,
  executeWindowsBackgroundPointActionAsync,
  ensureAgentDesktopSession,
  configureStarCursorOverlay,
  presentDesktopActionCursor,
  hideDesktopActionCursor,
  buildActionChatBubbleText,
  executeAgentDesktopAction,
  applyAgentDesktopTool,
} from './agent-desktop/index.js'

export type {
  AgentDesktopTargetInfo,
  AgentDesktopCliResponse,
  PresentDesktopCursorOptions,
  AgentDesktopAction,
  AgentDesktopToolArgs,
  AgentDesktopToolResult,
} from './agent-desktop/index.js'

export {
  applyComputerUseTool,
  loadLibnutNative,
  getLibnutLoadStatus,
  resolveNativeLibnutPath,
  encodeBgraCaptureToPng,
  drawCoordinateGridAndCrosshair,
  listDesktopWindows,
  normalizeKeyCombo,
  resolveLogicalCoordinate,
} from './computer-use/index.js'

export type {
  ComputerAction,
  ComputerToolArgs,
  ComputerToolResult,
  ComputerImageAttachmentRef,
  CoordinateSpace,
  DesktopWindowInfo,
  LibnutNativeAddon,
  LibnutScreenCapture,
  LibnutWindowRect,
} from './computer-use/index.js'

export { createGhostPawStandaloneTools, startGhostPawMcpServer } from './mcp-server.js'
export type { CollectedToolDefinition } from './mcp-server.js'

export const name = 'ghost-paw'

export const inject = {
  optional: ['tools', 'systemPrompt', 'attachments'] as const,
}

export interface GhostPawPluginConfig {
  /** Whether to inject system prompt guidelines for background computer-use (default: true) */
  readonly enableSystemPrompt?: boolean
  /** System prompt section order (default: 45) */
  readonly systemPromptOrder?: number
}

const DEFAULT_GHOSTPAW_SYSTEM_PROMPT = [
  '## GhostPaw — Background Non-Focus-Stealing Computer-Use Guidelines',
  '- Prefer `agent_desktop` (default `headed: false`) for operating desktop applications in the background without stealing the user\'s foreground window focus or moving the physical mouse.',
  '- To launch or attach to an app without stealing focus, call `agent_desktop` with `action: "launch"`, `app: "<AppName>"`, `headed: false`.',
  '- When running multiple sub-agents concurrently, pass a distinct `agentId` (e.g. `"subagent-calc"`, `"subagent-notepad"`) and explicit `windowId` or `app` so each sub-agent operates its own target window and renders its own independent Neon Hollow GhostPaw cursor without interference.',
].join('\n')

/**
 * DeepSeek Harness (`dsh`) / Cordis plugin entry point.
 */
export function apply(ctx: Context, config?: GhostPawPluginConfig): void {
  applyAgentDesktopTool(ctx)
  applyComputerUseTool(ctx)

  const enablePrompt = config?.enableSystemPrompt ?? true
  const anyCtx = ctx as unknown as {
    systemPrompt?: {
      section?(opts: { name: string; order?: number; interpolate?: boolean; text: string }): void
    }
  }
  if (enablePrompt && typeof anyCtx.systemPrompt?.section === 'function') {
    anyCtx.systemPrompt.section({
      name: 'ghost-paw:background-computer-use',
      order: config?.systemPromptOrder ?? 45,
      interpolate: false,
      text: DEFAULT_GHOSTPAW_SYSTEM_PROMPT,
    })
  }
}

export default {
  name,
  inject,
  apply,
}
