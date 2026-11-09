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

import { existsSync, readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { applyAgentDesktopTool } from './agent-desktop/index.js'
import { applyComputerUseTool } from './computer-use/index.js'

export interface CollectedToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (args: Record<string, unknown>, execCtx?: unknown) => Promise<Record<string, unknown>>
}

/**
 * Collects the `agent_desktop` and `computer` tools without requiring a live Cordis host.
 */
export function createGhostPawStandaloneTools(): Map<string, CollectedToolDefinition> {
  const registry = new Map<string, CollectedToolDefinition>()
  const fakeCtx = {
    inject(_deps: unknown, callback: (innerCtx: unknown) => void) {
      callback(fakeCtx)
    },
    tools: {
      register(def: CollectedToolDefinition) {
        registry.set(def.name, def)
        return () => registry.delete(def.name)
      },
    },
    get(_name: string) {
      return undefined
    },
    systemPrompt: {
      section() {},
    },
  } as unknown as Context

  applyAgentDesktopTool(fakeCtx)
  applyComputerUseTool(fakeCtx)
  return registry
}

interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

export function startGhostPawMcpServer(): void {
  const tools = createGhostPawStandaloneTools()
  let useContentLengthFraming = false

  const sendMessage = (msg: Record<string, unknown>): void => {
    const json = JSON.stringify(msg)
    if (useContentLengthFraming) {
      const byteLen = Buffer.byteLength(json, 'utf8')
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`)
    } else {
      process.stdout.write(`${json}\n`)
    }
  }

  const handleRequest = async (req: JsonRpcRequest): Promise<void> => {
    const { id, method, params } = req
    if (!method) return

    // Notifications (no id) do not require a response
    if (id === undefined) {
      return
    }

    try {
      switch (method) {
        case 'initialize': {
          const clientProtocol =
            typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05'
          sendMessage({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: clientProtocol,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: 'ghost-paw',
                version: '0.1.0',
              },
              instructions:
                'GhostPaw provides non-focus-stealing background desktop automation (`agent_desktop`) and coordinate computer-use (`computer`) with multi-sub-agent parallel Neon Hollow GhostPaw cursors. Always keep `headed: false` (default) to avoid stealing window focus or moving the user\'s physical mouse.',
            },
          })
          return
        }

        case 'ping': {
          sendMessage({ jsonrpc: '2.0', id, result: {} })
          return
        }

        case 'tools/list': {
          const toolList = Array.from(tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          }))
          sendMessage({
            jsonrpc: '2.0',
            id,
            result: { tools: toolList },
          })
          return
        }

        case 'resources/list': {
          sendMessage({
            jsonrpc: '2.0',
            id,
            result: { resources: [] },
          })
          return
        }

        case 'prompts/list': {
          sendMessage({
            jsonrpc: '2.0',
            id,
            result: { prompts: [] },
          })
          return
        }

        case 'tools/call': {
          const toolName = String(params?.name ?? '').trim()
          const toolArgs =
            params?.arguments && typeof params.arguments === 'object'
              ? (params.arguments as Record<string, unknown>)
              : {}
          const tool = tools.get(toolName)
          if (!tool) {
            sendMessage({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: `Unknown GhostPaw tool: ${toolName}. Available tools: ${Array.from(tools.keys()).join(', ')}`,
              },
            })
            return
          }

          const res = await tool.execute(toolArgs, {})
          const content: Array<Record<string, unknown>> = [
            {
              type: 'text',
              text: `${res.summary ?? ''}\n\n\`\`\`json\n${JSON.stringify(res, null, 2)}\n\`\`\``,
            },
          ]

          // Attach base64 PNG image if screenshotPath was produced
          const shotPath = typeof res.screenshotPath === 'string' ? res.screenshotPath : undefined
          if (shotPath && existsSync(shotPath)) {
            try {
              const imgBase64 = readFileSync(shotPath).toString('base64')
              content.push({
                type: 'image',
                data: imgBase64,
                mimeType: 'image/png',
              })
            } catch {}
          }

          sendMessage({
            jsonrpc: '2.0',
            id,
            result: {
              content,
              isError: res.ok === false,
            },
          })
          return
        }

        default: {
          sendMessage({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          })
        }
      }
    } catch (err) {
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])

    while (buffer.length > 0) {
      // Check for Content-Length header framing
      const asciiPreview = buffer.subarray(0, Math.min(buffer.length, 64)).toString('ascii')
      if (/^Content-Length:/i.test(asciiPreview)) {
        useContentLengthFraming = true
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const headerStr = buffer.subarray(0, headerEnd).toString('ascii')
        const m = /Content-Length:\s*(\d+)/i.exec(headerStr)
        if (!m) {
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }
        const bodyLen = Number.parseInt(m[1]!, 10)
        const totalLen = headerEnd + 4 + bodyLen
        if (buffer.length < totalLen) return
        const bodyStr = buffer.subarray(headerEnd + 4, totalLen).toString('utf8')
        buffer = buffer.subarray(totalLen)
        try {
          const parsed = JSON.parse(bodyStr) as JsonRpcRequest
          void handleRequest(parsed)
        } catch {}
        continue
      }

      // Otherwise newline-delimited JSON-RPC
      const nlIdx = buffer.indexOf(0x0a)
      if (nlIdx < 0) return
      const lineStr = buffer.subarray(0, nlIdx).toString('utf8').trim()
      buffer = buffer.subarray(nlIdx + 1)
      if (!lineStr) continue
      try {
        const parsed = JSON.parse(lineStr) as JsonRpcRequest
        void handleRequest(parsed)
      } catch {}
    }
  })

  process.stdin.resume()
}
