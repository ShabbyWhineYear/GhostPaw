/**
 * GhostPaw — Standard Model Context Protocol (MCP) Server (stdio JSON-RPC 2.0)
 *
 * Compatible out-of-the-box with:
 * - Claude Code (`claude mcp add ghost-paw -- npx -y ghost-paw mcp`)
 * - OpenAI Codex CLI / App (`~/.codex/config.toml` -> `[mcp_servers.ghost_paw]`)
 * - Google Antigravity (AGY) (`mcp_config.json`)
 * - Cursor / Windsurf / Cline / Roo Code / Zed
 *
 * Supports both newline-delimited JSON-RPC 2.0 messages (MCP 2024-11-05 / 2025-03-26)
 * and Content-Length HTTP-header framed JSON-RPC 2.0 messages.
 */
export interface CollectedToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly execute: (args: Record<string, unknown>, execCtx?: unknown) => Promise<Record<string, unknown>>;
}
/**
 * Collects the `agent_desktop` and `computer` tools without requiring a live Cordis host.
 */
export declare function createGhostPawStandaloneTools(): Map<string, CollectedToolDefinition>;
export declare function startGhostPawMcpServer(): void;
