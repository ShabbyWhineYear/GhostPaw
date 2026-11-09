import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

test('1. GhostPaw Neon Hollow Cursor asset (Candidate A shape + C colorway) is valid 34x34 RGBA PNG', async () => {
  const mod = await import(join(ROOT, 'dist', 'index.js'))
  assert.deepEqual(mod.GHOSTPAW_CURSOR_HOTSPOT, { x: 11, y: 11 })
  assert.deepEqual(mod.STAR_CURSOR_HOTSPOT, { x: 11, y: 11 })
  assert.ok(typeof mod.GHOSTPAW_CURSOR_PNG_BASE64 === 'string' && mod.GHOSTPAW_CURSOR_PNG_BASE64.length > 1000)

  const pngBuf = Buffer.from(mod.GHOSTPAW_CURSOR_PNG_BASE64, 'base64')
  // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
  assert.equal(pngBuf[0], 0x89)
  assert.equal(pngBuf[1], 0x50)
  assert.equal(pngBuf[2], 0x4e)
  assert.equal(pngBuf[3], 0x47)
  // IHDR width & height at bytes 16..24
  const width = pngBuf.readUInt32BE(16)
  const height = pngBuf.readUInt32BE(20)
  assert.equal(width, 34)
  assert.equal(height, 34)

  const cursorPath = mod.ensureStarCursorAsset()
  assert.ok(existsSync(cursorPath), 'Cursor PNG should be written to ~/.ghostpaw/assets/')
})

test('2. DeepSeek Harness (dsh) Cordis plugin apply() registers agent_desktop & computer tools and systemPrompt', async () => {
  const mod = await import(join(ROOT, 'dist', 'index.js'))
  const registeredTools = new Map()
  const promptSections = []

  const fakeCtx = {
    inject(_deps, cb) {
      cb(fakeCtx)
    },
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
        return () => registeredTools.delete(def.name)
      },
    },
    systemPrompt: {
      section(sec) {
        promptSections.push(sec)
      },
    },
  }

  mod.apply(fakeCtx, { enableSystemPrompt: true })
  assert.ok(registeredTools.has('agent_desktop'), 'agent_desktop tool must be registered')
  assert.ok(registeredTools.has('computer'), 'computer tool must be registered')
  assert.equal(promptSections.length, 1)
  assert.equal(promptSections[0].name, 'ghost-paw:background-computer-use')
})

test('3. Standard MCP stdio server responds to initialize and tools/list', async () => {
  const cliPath = join(ROOT, 'dist', 'cli.js')
  const child = spawn(process.execPath, [cliPath, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const responses = []
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('MCP server test timed out'))
    }, 5000)

    let buf = ''
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        responses.push(JSON.parse(line))
        if (responses.length >= 2) {
          clearTimeout(timer)
          child.kill()
          resolve()
        }
      }
    })

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n',
    )
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }) + '\n',
    )
  })

  assert.equal(responses[0].id, 1)
  assert.equal(responses[0].result.serverInfo.name, 'ghost-paw')
  assert.equal(responses[1].id, 2)
  const toolNames = responses[1].result.tools.map(t => t.name)
  assert.ok(toolNames.includes('agent_desktop'))
  assert.ok(toolNames.includes('computer'))
})

test('4. DSH market-index.json conforms to @deepseek-ai/dsh-plugin-market Format 1 schema', () => {
  const marketJson = JSON.parse(readFileSync(join(ROOT, 'market-index.json'), 'utf8'))
  assert.equal(marketJson.format, 1)
  assert.ok(Array.isArray(marketJson.objects) && marketJson.objects.length === 1)
  const obj = marketJson.objects[0]
  assert.equal(obj.name, 'ghost-paw')
  assert.equal(obj.version, '0.1.0')
  assert.ok(obj.locales['zh-CN'].title.includes('GhostPaw'))
  assert.ok(obj.locales['en-US'].title.includes('GhostPaw'))
})

test('5. macOS Universal native helper (ghostpaw-macos-helper) is bundled and functional on darwin', async () => {
  const mod = await import(join(ROOT, 'dist', 'index.js'))
  const helperFile = join(ROOT, 'native', 'darwin-universal', 'ghostpaw-macos-helper')
  assert.ok(existsSync(helperFile), 'native/darwin-universal/ghostpaw-macos-helper must exist in package')
  assert.equal(typeof mod.resolveMacosNativeHelperPath, 'function')
  assert.equal(typeof mod.executeMacosBackgroundPointAction, 'function')

  if (process.platform === 'darwin') {
    const resolved = mod.resolveMacosNativeHelperPath()
    assert.ok(resolved && existsSync(resolved), 'resolveMacosNativeHelperPath() must resolve on darwin')
    const statusRes = await mod.executeAgentDesktopAction({ action: 'status' })
    assert.equal(statusRes.ok, true)
    assert.equal(statusRes.data.platform, 'macos')
    assert.ok(statusRes.data.trusted === true || statusRes.data.trusted === 1 || statusRes.data.trusted === false || statusRes.data.trusted === 0)
  }
})
