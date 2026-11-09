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
import type { Context } from '@deepseek-ai/cordis';
import './types.js';
export type * from './types.js';
export { GHOSTPAW_CURSOR_HOTSPOT, GHOSTPAW_CURSOR_PNG_BASE64, STAR_CURSOR_DATA_URI, } from './cursor-asset.js';
export { extractTarGzBuffer } from './tar-utils.js';
export { AGENT_DESKTOP_VERSION, AGENT_DESKTOP_RELEASE_MATRIX, CURSOR_IDLE_AUTO_HIDE_MS, STAR_CURSOR_HOTSPOT, sanitizeLosslessJson, resolveAgentDesktopTarget, getAgentDesktopRootDir, getAgentDesktopStateDir, ensureStarCursorAsset, ensureAgentDesktopBinary, runAgentDesktopCli, qualifyAgentDesktopRef, findBestRefAtPoint, resolveMacosNativeHelperPath, executeMacosBackgroundPointAction, executeMacosBackgroundPointActionAsync, executeWindowsBackgroundPointAction, executeWindowsBackgroundPointActionAsync, ensureAgentDesktopSession, configureStarCursorOverlay, presentDesktopActionCursor, hideDesktopActionCursor, buildActionChatBubbleText, executeAgentDesktopAction, applyAgentDesktopTool, } from './agent-desktop/index.js';
export type { AgentDesktopTargetInfo, AgentDesktopCliResponse, PresentDesktopCursorOptions, AgentDesktopAction, AgentDesktopToolArgs, AgentDesktopToolResult, } from './agent-desktop/index.js';
export { applyComputerUseTool, loadLibnutNative, getLibnutLoadStatus, resolveNativeLibnutPath, encodeBgraCaptureToPng, drawCoordinateGridAndCrosshair, listDesktopWindows, normalizeKeyCombo, resolveLogicalCoordinate, } from './computer-use/index.js';
export type { ComputerAction, ComputerToolArgs, ComputerToolResult, ComputerImageAttachmentRef, CoordinateSpace, DesktopWindowInfo, LibnutNativeAddon, LibnutScreenCapture, LibnutWindowRect, } from './computer-use/index.js';
export { createGhostPawStandaloneTools, startGhostPawMcpServer } from './mcp-server.js';
export type { CollectedToolDefinition } from './mcp-server.js';
export declare const name = "ghost-paw";
export declare const inject: {
    optional: readonly ["tools", "systemPrompt", "attachments"];
};
export interface GhostPawPluginConfig {
    /** Whether to inject system prompt guidelines for background computer-use (default: true) */
    readonly enableSystemPrompt?: boolean;
    /** System prompt section order (default: 45) */
    readonly systemPromptOrder?: number;
}
/**
 * DeepSeek Harness (`dsh`) / Cordis plugin entry point.
 */
export declare function apply(ctx: Context, config?: GhostPawPluginConfig): void;
declare const _default: {
    name: string;
    inject: {
        optional: readonly ["tools", "systemPrompt", "attachments"];
    };
    apply: typeof apply;
};
export default _default;
