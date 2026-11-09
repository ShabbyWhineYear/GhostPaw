/**
 * ghost-paw Computer Use (操作系统级桌面鼠键接管与多模态视觉闭环模块)
 *
 * 融合业界四大开源最佳实践：
 * 1. Anthropic `computer` 统一工具范式 + DSH 原生多模态附件通道 (`ctx.get('attachments').saveImage` + `{ type: 'image', attachment }`)；
 * 2. ByteDance UI-TARS (`@ui-tars/operator-nut-js`) 底层 C++ N-API `@nut-tree-fork/libnut` 原生驱动 + 剪贴板中英文无损输入（彻底规避中文输入法候选框吞字）+ HiDPI 逻辑坐标 1:1 映射；
 * 3. Simular Agent-S2 动作后自动截屏反馈 + 视觉坐标标尺网格 (Coordinate Grid) + 点击落点红圈准星标注 (Red Crosshair)；
 * 4. Open Interpreter / PyAutoGUI 物理鼠标急停保护 (Fail-Safe)：鼠标移至屏幕左上角 (0,0) 或人类在接管期间手动大幅晃动鼠标 (>160px) 立即中止操作并交还控制权。
 *
 * @module ghost-paw/computer-use
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { executeAgentDesktopAction as staticExecuteAgentDesktopAction, executeWindowsBackgroundPointAction as staticExecuteWindowsBackgroundPointAction, findBestRefAtPoint as staticFindBestRefAtPoint, presentDesktopActionCursor as staticPresentDesktopActionCursor, sanitizeLosslessJson, } from '../agent-desktop/index.js';
function fallbackMatchWindowsApp(query, candidate) {
    const base = String(query ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, '');
    if (!base)
        return false;
    const groups = [
        ['calc', 'calculator', 'calculatorapp', '计算器'],
        ['notepad', '记事本'],
        ['textedit', '文本编辑'],
        ['notes', '备忘录'],
        ['mspaint', 'paint', '画图'],
        ['explorer', '文件资源管理器', '资源管理器'],
        ['finder', '访达'],
        ['preview', '预览'],
        ['safari', '浏览器'],
        ['terminal', '终端'],
        ['wps', 'wps office', 'et', 'wpp', '文字', '表格', '演示'],
        ['weixin', 'wechat', '微信'],
    ];
    const tokens = new Set([base]);
    for (const g of groups) {
        if (g.some(a => base === a || base.includes(a) || a.includes(base))) {
            for (const a of g)
                tokens.add(a);
        }
    }
    const appLower = String(candidate.app ?? '').trim().toLowerCase().replace(/\.exe$/i, '');
    const titleLower = String(candidate.title ?? '').trim().toLowerCase();
    return Array.from(tokens).some(tok => (appLower && (appLower === tok || appLower.includes(tok) || tok.includes(appLower))) ||
        (titleLower && titleLower.includes(tok)));
}
function getAgentDesktopRuntime() {
    const rt = globalThis.__ghostPawDesktopRuntime;
    return {
        executeAgentDesktopAction: rt?.executeAgentDesktopAction ?? staticExecuteAgentDesktopAction,
        executeWindowsBackgroundPointAction: rt?.executeWindowsBackgroundPointAction ?? staticExecuteWindowsBackgroundPointAction,
        findBestRefAtPoint: rt?.findBestRefAtPoint ?? staticFindBestRefAtPoint,
        matchWindowsAppCandidate: rt?.matchWindowsAppCandidate ?? fallbackMatchWindowsApp,
        presentDesktopActionCursor: rt?.presentDesktopActionCursor ?? staticPresentDesktopActionCursor,
    };
}
const COMPUTER_TMP_DIR = join(tmpdir(), 'ghostpaw-computer-use');
const MAX_CANVAS_WIDTH = 2560;
const FAILSAFE_CORNER_THRESHOLD = 3;
const FAILSAFE_JOLT_DISTANCE_PX = 160;
const FAILSAFE_ACTIVE_WINDOW_MS = 15_000;
let cachedLibnut;
let cachedLibnutLoadError;
const computerAgentStates = new Map();
let lastAgentCursor;
let lastVirtualCursor;
let lastBackgroundTargetApp;
let lastBackgroundTargetHwnd;
let lastActionMarker;
const __dirname = dirname(fileURLToPath(import.meta.url));
const requireAddon = createRequire(import.meta.url);
/**
 * 解析当前平台对应的预编译 C++ N-API `libnut.node` 路径
 */
export function resolveNativeLibnutPath() {
    let platformDir = '';
    if (process.platform === 'win32') {
        platformDir = 'win32-x64';
    }
    else if (process.platform === 'darwin') {
        platformDir = 'darwin-universal';
    }
    else if (process.platform === 'linux') {
        platformDir = 'linux-x64';
    }
    else {
        return undefined;
    }
    const candidateRoots = [
        resolve(__dirname, '..', '..', 'native'),
        resolve(__dirname, '..', 'native'),
        resolve(__dirname, 'native'),
    ];
    for (const root of candidateRoots) {
        const candidate = join(root, platformDir, 'libnut.node');
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
/**
 * 加载内置 C++ `@nut-tree-fork/libnut` 原生模块（支持 Windows / macOS Universal / Linux X11）
 */
export function loadLibnutNative() {
    if (cachedLibnut !== undefined) {
        return cachedLibnut;
    }
    if (process.platform === 'linux' && !process.env.DISPLAY) {
        cachedLibnutLoadError = 'Linux DISPLAY environment variable is not set';
        cachedLibnut = null;
        return null;
    }
    try {
        const addonPath = resolveNativeLibnutPath();
        if (!addonPath) {
            cachedLibnutLoadError = `No prebuilt libnut.node found for ${process.platform}/${process.arch}`;
            cachedLibnut = null;
            return null;
        }
        const addon = requireAddon(addonPath);
        try {
            addon.setMouseDelay?.(2);
            addon.setKeyboardDelay?.(2);
        }
        catch { }
        cachedLibnut = addon;
        return addon;
    }
    catch (err) {
        cachedLibnutLoadError = err instanceof Error ? err.message : String(err);
        cachedLibnut = null;
        return null;
    }
}
export function getLibnutLoadStatus() {
    const addonPath = resolveNativeLibnutPath();
    const addon = loadLibnutNative();
    return {
        loaded: addon !== null,
        ...(addonPath ? { addonPath } : {}),
        ...(cachedLibnutLoadError ? { error: cachedLibnutLoadError } : {}),
    };
}
// ============================================================================
// 零依赖极速 PNG 编码器 + 视觉坐标网格标尺 + 红圈准星叠加层 (基于 node:zlib)
// ============================================================================
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function makePngChunk(type, data) {
    const len = data.length;
    const out = Buffer.allocUnsafe(len + 12);
    out.writeUInt32BE(len, 0);
    out.write(type, 4, 4, 'ascii');
    if (len > 0) {
        Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
    }
    const crcSlice = out.subarray(4, 8 + len);
    out.writeUInt32BE(crc32(crcSlice), 8 + len);
    return out;
}
/** 3x5 极简像素字体，用于在截图坐标网格上绘制清晰的数字与括号坐标 */
const BITMAP_FONT_3X5 = {
    '0': [0b111, 0b101, 0b101, 0b101, 0b111],
    '1': [0b010, 0b110, 0b010, 0b010, 0b111],
    '2': [0b111, 0b001, 0b111, 0b100, 0b111],
    '3': [0b111, 0b001, 0b111, 0b001, 0b111],
    '4': [0b101, 0b101, 0b111, 0b001, 0b001],
    '5': [0b111, 0b100, 0b111, 0b001, 0b111],
    '6': [0b111, 0b100, 0b111, 0b101, 0b111],
    '7': [0b111, 0b001, 0b010, 0b010, 0b010],
    '8': [0b111, 0b101, 0b111, 0b101, 0b111],
    '9': [0b111, 0b101, 0b111, 0b001, 0b111],
    ',': [0b000, 0b000, 0b000, 0b010, 0b100],
    '(': [0b010, 0b100, 0b100, 0b100, 0b010],
    ')': [0b010, 0b001, 0b001, 0b001, 0b010],
    'x': [0b000, 0b101, 0b010, 0b101, 0b000],
    'y': [0b000, 0b101, 0b010, 0b010, 0b100],
    ':': [0b000, 0b010, 0b000, 0b010, 0b000],
    ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
};
function blendPixel(rgba, width, height, x, y, r, g, b, alpha) {
    if (x < 0 || y < 0 || x >= width || y >= height)
        return;
    const idx = (y * width + x) * 4;
    const inv = 1 - alpha;
    rgba[idx] = Math.round(rgba[idx] * inv + r * alpha);
    rgba[idx + 1] = Math.round(rgba[idx + 1] * inv + g * alpha);
    rgba[idx + 2] = Math.round(rgba[idx + 2] * inv + b * alpha);
    rgba[idx + 3] = 255;
}
function fillRectAlpha(rgba, width, height, rx, ry, rw, rh, r, g, b, alpha) {
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(width, Math.ceil(rx + rw));
    const y1 = Math.min(height, Math.ceil(ry + rh));
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            blendPixel(rgba, width, height, x, y, r, g, b, alpha);
        }
    }
}
function drawBitmapText(rgba, width, height, text, startX, startY, scale = 2, fg = [255, 255, 255], bg = [15, 23, 42, 0.78]) {
    const charW = 3 * scale;
    const charH = 5 * scale;
    const gap = scale;
    const pad = scale;
    const totalW = text.length * (charW + gap) - gap + pad * 2;
    const totalH = charH + pad * 2;
    fillRectAlpha(rgba, width, height, startX - pad, startY - pad, totalW, totalH, bg[0], bg[1], bg[2], bg[3]);
    let cursorX = startX;
    for (const ch of text) {
        const glyph = BITMAP_FONT_3X5[ch] ?? BITMAP_FONT_3X5[' '];
        for (let row = 0; row < 5; row++) {
            const bits = glyph[row];
            for (let col = 0; col < 3; col++) {
                if ((bits >> (2 - col)) & 1) {
                    for (let dy = 0; dy < scale; dy++) {
                        for (let dx = 0; dx < scale; dx++) {
                            blendPixel(rgba, width, height, cursorX + col * scale + dx, startY + row * scale + dy, fg[0], fg[1], fg[2], 1);
                        }
                    }
                }
            }
        }
        cursorX += charW + gap;
    }
}
/**
 * 在 RGBA 画布上绘制半透明像素坐标网格标尺与鼠标点击准星
 */
export function drawCoordinateGridAndCrosshair(rgba, width, height, options) {
    const shouldDrawGrid = options?.drawGrid ?? true;
    if (shouldDrawGrid) {
        const minorStep = 100;
        const majorStep = 200;
        // 垂直网格线
        for (let x = minorStep; x < width; x += minorStep) {
            const isMajor = x % majorStep === 0;
            const alpha = isMajor ? 0.28 : 0.14;
            const r = isMajor ? 56 : 148;
            const g = isMajor ? 189 : 163;
            const b = isMajor ? 248 : 184;
            for (let y = 0; y < height; y++) {
                if (!isMajor && (y % 4 >= 2))
                    continue;
                blendPixel(rgba, width, height, x, y, r, g, b, alpha);
            }
            if (isMajor) {
                drawBitmapText(rgba, width, height, String(x), Math.min(width - 36, x + 3), 4, 2, [56, 189, 248], [15, 23, 42, 0.82]);
            }
        }
        // 水平网格线
        for (let y = minorStep; y < height; y += minorStep) {
            const isMajor = y % majorStep === 0;
            const alpha = isMajor ? 0.28 : 0.14;
            const r = isMajor ? 56 : 148;
            const g = isMajor ? 189 : 163;
            const b = isMajor ? 248 : 184;
            for (let x = 0; x < width; x++) {
                if (!isMajor && (x % 4 >= 2))
                    continue;
                blendPixel(rgba, width, height, x, y, r, g, b, alpha);
            }
            if (isMajor) {
                drawBitmapText(rgba, width, height, String(y), 4, Math.min(height - 16, y + 3), 2, [56, 189, 248], [15, 23, 42, 0.82]);
            }
        }
    }
    // 绘制最近一次点击/移动的红色双环准星
    const marker = options?.marker;
    if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
        const mx = Math.round(marker.x);
        const my = Math.round(marker.y);
        const outerR = 14;
        const innerR = 4;
        for (let dy = -outerR - 2; dy <= outerR + 2; dy++) {
            for (let dx = -outerR - 2; dx <= outerR + 2; dx++) {
                const dist = Math.hypot(dx, dy);
                if (Math.abs(dist - outerR) <= 1.6 || dist <= innerR) {
                    blendPixel(rgba, width, height, mx + dx, my + dy, 239, 68, 68, 0.95);
                }
                else if (Math.abs(dist - (outerR + 1.8)) <= 0.9) {
                    blendPixel(rgba, width, height, mx + dx, my + dy, 255, 255, 255, 0.85);
                }
            }
        }
        // 十字准星延伸线
        for (let d = innerR + 2; d <= outerR + 7; d++) {
            blendPixel(rgba, width, height, mx + d, my, 239, 68, 68, 0.95);
            blendPixel(rgba, width, height, mx - d, my, 239, 68, 68, 0.95);
            blendPixel(rgba, width, height, mx, my + d, 239, 68, 68, 0.95);
            blendPixel(rgba, width, height, mx, my - d, 239, 68, 68, 0.95);
        }
        const coordText = `(${mx},${my})`;
        const labelX = mx + 18 + coordText.length * 8 < width ? mx + 18 : Math.max(4, mx - 18 - coordText.length * 8);
        const labelY = my - 16 > 4 ? my - 16 : Math.min(height - 16, my + 12);
        drawBitmapText(rgba, width, height, coordText, labelX, labelY, 2, [255, 255, 255], [220, 38, 38, 0.9]);
    }
}
/**
 * 将 `libnut.captureScreen()` 返回的原始 BGRA Buffer 转换并缩放到目标逻辑分辨率 RGBA PNG Buffer
 */
export function encodeBgraCaptureToPng(capture, targetLogicalSize, overlayOptions) {
    const srcW = Math.max(1, Math.trunc(capture.width));
    const srcH = Math.max(1, Math.trunc(capture.height));
    const byteWidth = Math.max(srcW * 4, Math.trunc(capture.byteWidth || srcW * 4));
    const srcBuf = capture.image;
    let dstW = Math.max(1, Math.trunc(targetLogicalSize.width || srcW));
    let dstH = Math.max(1, Math.trunc(targetLogicalSize.height || srcH));
    if (dstW > MAX_CANVAS_WIDTH) {
        const ratio = MAX_CANVAS_WIDTH / dstW;
        dstW = MAX_CANVAS_WIDTH;
        dstH = Math.max(1, Math.round(dstH * ratio));
    }
    const rgba = new Uint8Array(dstW * dstH * 4);
    if (srcW === dstW && srcH === dstH) {
        for (let y = 0; y < dstH; y++) {
            const rowOffset = y * byteWidth;
            let dstIdx = y * dstW * 4;
            for (let x = 0; x < dstW; x++) {
                const srcIdx = rowOffset + x * 4;
                rgba[dstIdx] = srcBuf[srcIdx + 2] ?? 0; // R
                rgba[dstIdx + 1] = srcBuf[srcIdx + 1] ?? 0; // G
                rgba[dstIdx + 2] = srcBuf[srcIdx] ?? 0; // B
                rgba[dstIdx + 3] = 255; // A
                dstIdx += 4;
            }
        }
    }
    else {
        // 针对 HiDPI / Retina (如 2x 缩放) 进行快速最近邻/双线性重采样，使输出 PNG 尺寸严格等于逻辑屏幕像素尺寸
        const scaleX = srcW / dstW;
        const scaleY = srcH / dstH;
        for (let y = 0; y < dstH; y++) {
            const srcY = Math.min(srcH - 1, Math.floor(y * scaleY));
            const rowOffset = srcY * byteWidth;
            let dstIdx = y * dstW * 4;
            for (let x = 0; x < dstW; x++) {
                const srcX = Math.min(srcW - 1, Math.floor(x * scaleX));
                const srcIdx = rowOffset + srcX * 4;
                rgba[dstIdx] = srcBuf[srcIdx + 2] ?? 0;
                rgba[dstIdx + 1] = srcBuf[srcIdx + 1] ?? 0;
                rgba[dstIdx + 2] = srcBuf[srcIdx] ?? 0;
                rgba[dstIdx + 3] = 255;
                dstIdx += 4;
            }
        }
    }
    const scaledMarker = overlayOptions?.marker
        ? {
            x: Math.round((overlayOptions.marker.x * dstW) / Math.max(1, targetLogicalSize.width || dstW)),
            y: Math.round((overlayOptions.marker.y * dstH) / Math.max(1, targetLogicalSize.height || dstH)),
            label: overlayOptions.marker.label,
        }
        : undefined;
    drawCoordinateGridAndCrosshair(rgba, dstW, dstH, {
        drawGrid: overlayOptions?.drawGrid,
        marker: scaledMarker,
    });
    // 组装 PNG 扫描行（每行前置 1 字节 Filter=0 None，速度最快且对 UI 纯色块压缩率优异）
    const stride = dstW * 4;
    const rawScanlines = new Uint8Array((stride + 1) * dstH);
    for (let y = 0; y < dstH; y++) {
        const rowStart = y * (stride + 1);
        rawScanlines[rowStart] = 0;
        rawScanlines.set(rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1);
    }
    const compressed = deflateSync(rawScanlines, { level: 4 });
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(dstW, 0);
    ihdr.writeUInt32BE(dstH, 4);
    ihdr[8] = 8; // bit depth: 8-bit
    ihdr[9] = 6; // color type: 6 (RGBA)
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    const pngBuffer = Buffer.concat([
        signature,
        makePngChunk('IHDR', ihdr),
        makePngChunk('IDAT', compressed),
        makePngChunk('IEND', new Uint8Array(0)),
    ]);
    return {
        pngBuffer,
        width: dstW,
        height: dstH,
    };
}
// ============================================================================
// 剪贴板中英文无损输入 + 快捷键标准化映射 (UI-TARS 模式)
// ============================================================================
function getSystemClipboardText() {
    try {
        if (process.platform === 'darwin') {
            return execFileSync('pbpaste', [], {
                encoding: 'utf8',
                timeout: 2000,
                env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' },
            });
        }
        if (process.platform === 'win32') {
            return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw'], { encoding: 'utf8', timeout: 3000 }).replace(/\r\n$/, '');
        }
        // Linux: 依次尝试 xclip -> xsel -> wl-paste
        for (const [cmd, args] of [
            ['xclip', ['-selection', 'clipboard', '-o']],
            ['xsel', ['--clipboard', '--output']],
            ['wl-paste', ['--no-newline']],
        ]) {
            const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500 });
            if (res.status === 0 && typeof res.stdout === 'string') {
                return res.stdout;
            }
        }
    }
    catch { }
    return undefined;
}
function setSystemClipboardText(text) {
    try {
        if (process.platform === 'darwin') {
            const res = spawnSync('pbcopy', [], {
                input: text,
                encoding: 'utf8',
                timeout: 2000,
                env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8' },
            });
            return res.status === 0;
        }
        if (process.platform === 'win32') {
            const b64 = Buffer.from(text, 'utf8').toString('base64');
            const psCmd = `$b = [System.Convert]::FromBase64String('${b64}'); $s = [System.Text.Encoding]::UTF8.GetString($b); Set-Clipboard -Value $s`;
            const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
                encoding: 'utf8',
                timeout: 3000,
            });
            return res.status === 0;
        }
        // Linux: 注意 xclip 在后台 fork 持有 selection，若等待 stdout pipe 关闭可能阻塞，因此使用 ignore stdio
        for (const [cmd, args] of [
            ['xclip', ['-selection', 'clipboard', '-i']],
            ['xsel', ['--clipboard', '--input']],
            ['wl-copy', []],
        ]) {
            const res = spawnSync(cmd, args, {
                input: text,
                encoding: 'utf8',
                stdio: ['pipe', 'ignore', 'ignore'],
                timeout: 1500,
            });
            if (res.status === 0) {
                return true;
            }
        }
    }
    catch { }
    return false;
}
const KEY_ALIAS_MAP = {
    ctrl: 'control',
    control: 'control',
    ctl: 'control',
    alt: 'alt',
    option: 'alt',
    opt: 'alt',
    shift: 'shift',
    cmd: 'command',
    command: 'command',
    meta: process.platform === 'darwin' ? 'command' : 'meta',
    super: process.platform === 'darwin' ? 'command' : 'meta',
    win: process.platform === 'darwin' ? 'command' : 'meta',
    windows: process.platform === 'darwin' ? 'command' : 'meta',
    return: 'enter',
    enter: 'enter',
    kp_enter: 'enter',
    esc: 'escape',
    escape: 'escape',
    bksp: 'backspace',
    backspace: 'backspace',
    del: 'delete',
    delete: 'delete',
    ins: 'insert',
    insert: 'insert',
    tab: 'tab',
    space: 'space',
    spacebar: 'space',
    ' ': 'space',
    up: 'up',
    arrowup: 'up',
    down: 'down',
    arrowdown: 'down',
    left: 'left',
    arrowleft: 'left',
    right: 'right',
    arrowright: 'right',
    pgup: 'pageup',
    pageup: 'pageup',
    page_up: 'pageup',
    pgdn: 'pagedown',
    pagedown: 'pagedown',
    page_down: 'pagedown',
    home: 'home',
    end: 'end',
    capslock: 'caps_lock',
    caps_lock: 'caps_lock',
    prtsc: 'printscreen',
    printscreen: 'printscreen',
};
const MODIFIER_KEYS = new Set([
    'control',
    'alt',
    'shift',
    'command',
    'meta',
    'win',
    'right_control',
    'right_alt',
    'right_shift',
    'right_cmd',
    'right_win',
    'right_meta',
]);
/**
 * 将用户或模型传入的快捷键字符串（如 `"Ctrl+Shift+S"`, `"Alt+Tab"`, `"Enter"`）解析为 `libnut` 标准格式
 */
export function normalizeKeyCombo(rawKey, rawKeys) {
    const parts = [];
    if (Array.isArray(rawKeys) && rawKeys.length > 0) {
        for (const k of rawKeys) {
            if (typeof k === 'string' && k.trim()) {
                parts.push(...k.trim().split(/\s*\+\s*/));
            }
        }
    }
    else if (typeof rawKey === 'string' && rawKey.trim()) {
        if (rawKey.trim() === '+') {
            parts.push('+');
        }
        else {
            parts.push(...rawKey.trim().split(/\s*\+\s*/));
        }
    }
    const normalized = parts
        .map(p => p.trim().toLowerCase())
        .filter(Boolean)
        .map(p => KEY_ALIAS_MAP[p] ?? p);
    if (normalized.length === 0) {
        return { mainKey: 'enter', modifiers: [], rawLabel: 'enter' };
    }
    const modifiers = [];
    let mainKey = '';
    for (let i = 0; i < normalized.length; i++) {
        const token = normalized[i];
        if (i < normalized.length - 1 && MODIFIER_KEYS.has(token)) {
            if (!modifiers.includes(token)) {
                modifiers.push(token);
            }
        }
        else if (MODIFIER_KEYS.has(token) && normalized.length === 1) {
            mainKey = token;
        }
        else if (MODIFIER_KEYS.has(token) && !mainKey && i < normalized.length - 1) {
            if (!modifiers.includes(token)) {
                modifiers.push(token);
            }
        }
        else {
            mainKey = token;
        }
    }
    if (!mainKey && modifiers.length > 0) {
        mainKey = modifiers.pop();
    }
    return {
        mainKey: mainKey || 'enter',
        modifiers,
        rawLabel: [...modifiers, mainKey].filter(Boolean).join('+'),
    };
}
function sleepMs(ms) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, Math.max(0, ms)));
}
/**
 * 智能文本输入（借鉴 UI-TARS：默认通过系统剪贴板 + Ctrl/Cmd+V 粘贴后恢复原剪贴板，完美支持中文、特殊符号与防输入法吞字）
 */
async function typeTextSmart(libnut, text, options) {
    const modKey = process.platform === 'darwin' ? 'command' : 'control';
    if (options?.clearFirst) {
        libnut.keyTap('a', [modKey]);
        await sleepMs(40);
        libnut.keyTap('backspace');
        await sleepMs(40);
    }
    const trailingNewline = text.endsWith('\n');
    const cleanText = trailingNewline ? text.replace(/\r?\n$/, '') : text;
    const shouldPressEnter = options?.pressEnter ?? trailingNewline;
    if (cleanText.length > 0) {
        const prevClip = getSystemClipboardText();
        const copied = setSystemClipboardText(cleanText);
        if (copied) {
            await sleepMs(45);
            libnut.keyTap('v', [modKey]);
            await sleepMs(90);
            if (prevClip !== undefined && prevClip !== cleanText) {
                setSystemClipboardText(prevClip);
            }
            if (shouldPressEnter) {
                await sleepMs(40);
                libnut.keyTap('enter');
            }
            return { method: 'clipboard-paste' };
        }
        // 降级：直接逐字符敲击
        libnut.typeString(cleanText);
    }
    if (shouldPressEnter) {
        await sleepMs(40);
        libnut.keyTap('enter');
    }
    return { method: 'keystroke' };
}
/**
 * 列出当前桌面所有可见顶层应用窗口
 */
export function listDesktopWindows(libnut) {
    if (typeof libnut.getWindows !== 'function') {
        return [];
    }
    const activeHandle = typeof libnut.getActiveWindow === 'function'
        ? (() => {
            try {
                return libnut.getActiveWindow();
            }
            catch {
                return -1;
            }
        })()
        : -1;
    let handles = [];
    try {
        handles = libnut.getWindows() ?? [];
    }
    catch {
        return [];
    }
    const results = [];
    const seenTitles = new Set();
    for (const handle of handles) {
        try {
            const rawTitle = typeof libnut.getWindowTitle === 'function' ? (libnut.getWindowTitle(handle) ?? '') : '';
            const title = rawTitle.trim();
            if (!title)
                continue;
            if (title === 'mutter guard window' ||
                title === 'gnome-shell' ||
                title === 'Desktop' ||
                title === 'Dock' ||
                title === 'Window Server' ||
                title === 'Control Center' ||
                title === 'Notification Center' ||
                title === 'Program Manager' ||
                title === 'ghostpaw-cursor-overlay' ||
                title === 'agent-desktop cursor overlay' ||
                title.startsWith('Qt Selection Owner') ||
                title.includes('sogoupinyin-watchdog')) {
                continue;
            }
            const rect = typeof libnut.getWindowRect === 'function'
                ? libnut.getWindowRect(handle)
                : { x: 0, y: 0, width: 0, height: 0 };
            if (rect.width < 80 || rect.height < 50)
                continue;
            if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0)
                continue;
            const dedupeKey = `${title}@${rect.x},${rect.y},${rect.width}x${rect.height}`;
            if (seenTitles.has(dedupeKey))
                continue;
            seenTitles.add(dedupeKey);
            results.push({
                handle,
                title,
                rect,
                active: handle === activeHandle,
            });
        }
        catch { }
    }
    results.sort((a, b) => {
        if (a.active !== b.active)
            return a.active ? -1 : 1;
        return b.rect.width * b.rect.height - a.rect.width * a.rect.height;
    });
    return results.slice(0, 35);
}
/**
 * 检查物理鼠标 Fail-Safe 急停条件：
 * 1. 鼠标位于屏幕左上角极值区域 (x <= 3 && y <= 3) 且并非 Agent 主动放置；
 * 2. 在最近 15 秒活跃接管期内，人类手动将物理鼠标拖离了 Agent 上一次放置位置超过 160px。
 */
function checkFailSafeBeforeAction(libnut, action, resetFailSafe) {
    const pos = libnut.getMousePos();
    if (resetFailSafe) {
        lastAgentCursor = undefined;
    }
    // 只读观察操作不触发急停拦截
    if (action === 'screenshot' || action === 'cursor_position' || action === 'list_windows' || action === 'wait') {
        return { triggered: false, pos };
    }
    // 1. 左上角 (0,0) 急停角落检测
    const agentPlacedInCorner = lastAgentCursor !== undefined &&
        lastAgentCursor.x <= FAILSAFE_CORNER_THRESHOLD &&
        lastAgentCursor.y <= FAILSAFE_CORNER_THRESHOLD;
    if (pos.x <= FAILSAFE_CORNER_THRESHOLD && pos.y <= FAILSAFE_CORNER_THRESHOLD && !agentPlacedInCorner) {
        lastAgentCursor = undefined;
        return {
            triggered: true,
            pos,
            message: `🛑 [Fail-Safe 左上角物理急停] 检测到系统鼠标位于左上角急停区 (${pos.x}, ${pos.y})，已立即中止 \`${action}\` 并交还鼠标键盘控制权。若需恢复接管，请将鼠标移出左上角后重试（或传入 resetFailSafe=true）。`,
        };
    }
    // 2. 活跃接管期内人类大幅晃动/移走鼠标检测
    if (lastAgentCursor && Date.now() - lastAgentCursor.at <= FAILSAFE_ACTIVE_WINDOW_MS) {
        const drift = Math.hypot(pos.x - lastAgentCursor.x, pos.y - lastAgentCursor.y);
        if (drift > FAILSAFE_JOLT_DISTANCE_PX) {
            const prev = lastAgentCursor;
            lastAgentCursor = undefined;
            return {
                triggered: true,
                pos,
                message: `🛑 [Fail-Safe 人类鼠标接管保护] 检测到用户在 Agent 操作期间手动移动了鼠标（从 Agent 放置点 (${prev.x}, ${prev.y}) 移至 (${pos.x}, ${pos.y})，偏移 ${Math.round(drift)}px > ${FAILSAFE_JOLT_DISTANCE_PX}px）。已立即暂停操作并交还控制权；若希望继续操作，请再次调用并传入 resetFailSafe=true。`,
            };
        }
    }
    return { triggered: false, pos };
}
function recordAgentCursorPosition(libnut) {
    const pos = libnut.getMousePos();
    lastAgentCursor = { x: pos.x, y: pos.y, at: Date.now() };
    return pos;
}
/**
 * 解析并映射输入坐标到操作系统逻辑屏幕像素坐标
 */
export function resolveLogicalCoordinate(rawX, rawY, rawTuple, screenSize, coordinateSpace = 'pixels') {
    const inX = rawX ?? rawTuple?.[0];
    const inY = rawY ?? rawTuple?.[1];
    if (typeof inX !== 'number' || typeof inY !== 'number' || !Number.isFinite(inX) || !Number.isFinite(inY)) {
        return undefined;
    }
    let logicalX = inX;
    let logicalY = inY;
    if (coordinateSpace === 'normalized_1000') {
        logicalX = (inX / 1000) * screenSize.width;
        logicalY = (inY / 1000) * screenSize.height;
    }
    else if (screenSize.width > MAX_CANVAS_WIDTH) {
        const scale = screenSize.width / MAX_CANVAS_WIDTH;
        logicalX = inX * scale;
        logicalY = inY * scale;
    }
    const clampedX = Math.max(0, Math.min(screenSize.width - 1, Math.round(logicalX)));
    const clampedY = Math.max(0, Math.min(screenSize.height - 1, Math.round(logicalY)));
    return { x: clampedX, y: clampedY };
}
/**
 * 截取当前桌面屏幕并尝试通过 DSH 原生 `attachments.saveImage` 注入多模态图像块
 */
async function captureAndAttachDesktopScreenshot(ctx, libnut, screenSize, options) {
    const rawCapture = libnut.captureScreen();
    const scaleFactor = {
        x: Number((rawCapture.width / Math.max(1, screenSize.width)).toFixed(2)),
        y: Number((rawCapture.height / Math.max(1, screenSize.height)).toFixed(2)),
    };
    const encoded = encodeBgraCaptureToPng(rawCapture, screenSize, options);
    mkdirSync(COMPUTER_TMP_DIR, { recursive: true });
    const screenshotPath = join(COMPUTER_TMP_DIR, `desktop-${Date.now()}.png`);
    const latestPath = join(COMPUTER_TMP_DIR, 'latest.png');
    writeFileSync(screenshotPath, encoded.pngBuffer);
    try {
        writeFileSync(latestPath, encoded.pngBuffer);
    }
    catch { }
    let imageRef;
    try {
        const anyCtx = ctx;
        const attachments = typeof anyCtx.get === 'function' ? anyCtx.get('attachments') : undefined;
        if (attachments && typeof attachments.saveImage === 'function') {
            const saved = await attachments.saveImage({
                data: encoded.pngBuffer,
                mediaType: 'image/png',
                name: 'desktop-screenshot.png',
            });
            if (saved && typeof saved.attachmentId === 'string') {
                imageRef = saved;
            }
        }
    }
    catch {
        // 若当前宿主未开启 attachments 服务或处于纯文本通道，静默回退至本地文件路径
    }
    return {
        screenshotPath,
        screenshotSize: { width: encoded.width, height: encoded.height },
        scaleFactor,
        ...(imageRef ? { image: imageRef } : {}),
    };
}
/**
 * 在 Cordis Context 上注册统一的操作系统级鼠键接管工具 `computer`
 */
export function applyComputerUseTool(ctx) {
    try {
        const anyTools = ctx.tools;
        anyTools?._tools?.delete?.('computer');
        anyTools?.layers?.global?.tools?.data?.delete?.('computer');
        if (anyTools?.layers && typeof anyTools.layers === 'object') {
            for (const layer of Object.values(anyTools.layers)) {
                layer?.tools?.data?.delete?.('computer');
            }
        }
    }
    catch { }
    ctx.tools.register({
        name: 'computer',
        description: [
            '操作系统级桌面视觉与鼠键操作工具（默认结合 Agent-Desktop 后台无感语义/句柄透传引擎 + 圆角三角 3D 琉璃小鼠标与实时聊天气泡，不抢占用户的系统物理鼠标和前台窗口焦点）。',
            '【重要提示】：操作桌面软件时，请优先使用 `agent_desktop` 工具（`snapshot` -> `@ref` -> `click/set_value`）；当需要根据全屏多模态截图坐标 (x, y) 点击、双击、输入或滚动时，本工具默认在后台通过 Agent-Desktop 专属琉璃小鼠标 + 目标窗口句柄透传无感投递（即使目标窗口被其他窗口遮挡也能透传点击），不会移动用户的真实系统鼠标，也不会强行切走用户当前正在使用的前台窗口。',
            '操作网页请继续优先使用内置 `browser_*` 工具。每次点击/输入/按键后默认自动返回带像素坐标网格标尺与红色落点准星的多模态截图，截图上的像素坐标与本工具的 (x, y) 1:1 精确对应。',
        ].join('\n'),
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'screenshot',
                        'left_click',
                        'double_click',
                        'triple_click',
                        'right_click',
                        'middle_click',
                        'mouse_move',
                        'mouse_down',
                        'mouse_up',
                        'drag',
                        'scroll',
                        'type',
                        'key',
                        'hotkey',
                        'wait',
                        'cursor_position',
                        'list_windows',
                        'focus_window',
                    ],
                    description: '动作类型：screenshot(全屏截屏含坐标标尺)、left_click(左键单击)、double_click(左键双击，常用于打开桌面图标)、triple_click(三连击选中整行)、right_click(右键菜单)、middle_click(中键)、mouse_move(移动鼠标)、drag(拖拽)、scroll(滚轮)、type(中英文剪贴板无损输入)、key/hotkey(按键或组合键如 ctrl+c / alt+tab / Enter)、list_windows(列出桌面可见窗口)、focus_window(后台绑定目标窗口)、wait(等待)、cursor_position(获取鼠标位置)',
                },
                x: {
                    type: 'number',
                    description: '目标横坐标 X（直接读取截图顶部蓝色标尺刻度，1:1 像素对应）',
                },
                y: {
                    type: 'number',
                    description: '目标纵坐标 Y（直接读取截图左侧蓝色标尺刻度，1:1 像素对应）',
                },
                coordinate: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: '可选的 [x, y] 数组格式坐标（与 x, y 等价）',
                },
                fromX: {
                    type: 'number',
                    description: '拖拽起点 X 坐标（action="drag" 时可选，缺省使用 x 或当前鼠标位置）',
                },
                fromY: {
                    type: 'number',
                    description: '拖拽起点 Y 坐标（action="drag" 时可选，缺省使用 y 或当前鼠标位置）',
                },
                toX: {
                    type: 'number',
                    description: '拖拽终点 X 坐标（action="drag" 时必填）',
                },
                toY: {
                    type: 'number',
                    description: '拖拽终点 Y 坐标（action="drag" 时必填）',
                },
                endCoordinate: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: '可选的 [toX, toY] 数组格式拖拽终点坐标',
                },
                coordinateSpace: {
                    type: 'string',
                    enum: ['pixels', 'normalized_1000'],
                    description: '坐标空间：默认 "pixels"（直接对应截图上的标尺像素值）；若使用 0~1000 千分比坐标可传 "normalized_1000"',
                },
                text: {
                    type: 'string',
                    description: '要输入的文字内容（action="type" 时使用，自动走后台透传或剪贴板无损输入以完美支持中文）',
                },
                pressEnter: {
                    type: 'boolean',
                    description: '输入文字后是否自动按 Enter 回车键（默认 false）',
                },
                clearFirst: {
                    type: 'boolean',
                    description: '输入文字前是否先执行全选并清空原输入框内容（默认 false）',
                },
                key: {
                    type: 'string',
                    description: '按键或组合键名称（action="key" 或 "hotkey" 时使用，如 "Enter", "Escape", "Tab", "ctrl+s", "ctrl+shift+n", "alt+f4", "cmd+space"）',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '可选的组合键数组格式，如 ["ctrl", "c"]',
                },
                scrollDirection: {
                    type: 'string',
                    enum: ['up', 'down', 'left', 'right'],
                    description: '滚轮方向（action="scroll" 时使用，默认 "down"）',
                },
                scrollAmount: {
                    type: 'number',
                    description: '滚轮滚动刻度数（默认 5）',
                },
                durationMs: {
                    type: 'number',
                    description: '等待毫秒数（action="wait" 时使用，默认 1000ms）',
                },
                settleMs: {
                    type: 'number',
                    description: '动作执行后等待界面动画稳定的毫秒数（默认 320ms）',
                },
                autoScreenshot: {
                    type: 'boolean',
                    description: '动作执行后是否自动截屏并返回多模态图像（默认 true）',
                },
                grid: {
                    type: 'boolean',
                    description: '截图上是否绘制半透明像素坐标网格标尺与红圈落点准星（默认 true）',
                },
                windowTitle: {
                    type: 'string',
                    description: 'action="focus_window" 时要绑定的目标窗口标题或进程关键字（大小写不敏感子串及中英文别名匹配）',
                },
                windowHandle: {
                    type: 'number',
                    description: 'action="focus_window" 时可选的窗口句柄 ID（可从 list_windows 获取）',
                },
                resetFailSafe: {
                    type: 'boolean',
                    description: '触发物理鼠标急停保护后，若用户确认继续接管，传 true 重置急停锁',
                },
                physicalMouse: {
                    type: 'boolean',
                    description: '是否强制移动真实物理鼠标与抢占窗口焦点（默认 false！保持 false 时在 Windows 下默认通过 Agent-Desktop 后台琉璃小鼠标 + 窗口句柄透传无感投递，不抢用户鼠标和前台窗口）',
                },
                agentId: {
                    type: 'string',
                    description: '子智能体 ID（多智能体并发时可各自拥有独立标签的小鼠标与独立目标窗口上下文）',
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    action: { type: 'string' },
                    summary: { type: 'string' },
                    driver: { type: 'string', enum: ['libnut-native-cpp', 'os-cli-fallback'] },
                    screenSize: {
                        type: 'object',
                        properties: {
                            width: { type: 'number' },
                            height: { type: 'number' },
                        },
                        required: ['width', 'height'],
                        additionalProperties: false,
                    },
                    screenshotSize: {
                        type: 'object',
                        properties: {
                            width: { type: 'number' },
                            height: { type: 'number' },
                        },
                        required: ['width', 'height'],
                        additionalProperties: false,
                    },
                    scaleFactor: {
                        type: 'object',
                        properties: {
                            x: { type: 'number' },
                            y: { type: 'number' },
                        },
                        required: ['x', 'y'],
                        additionalProperties: false,
                    },
                    cursorPosition: {
                        type: 'object',
                        properties: {
                            x: { type: 'number' },
                            y: { type: 'number' },
                        },
                        required: ['x', 'y'],
                        additionalProperties: false,
                    },
                    targetCoordinate: {
                        type: 'object',
                        properties: {
                            x: { type: 'number' },
                            y: { type: 'number' },
                        },
                        required: ['x', 'y'],
                        additionalProperties: false,
                    },
                    activeWindow: { type: 'string' },
                    windows: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                handle: { type: 'number' },
                                title: { type: 'string' },
                                rect: {
                                    type: 'object',
                                    properties: {
                                        x: { type: 'number' },
                                        y: { type: 'number' },
                                        width: { type: 'number' },
                                        height: { type: 'number' },
                                    },
                                    required: ['x', 'y', 'width', 'height'],
                                    additionalProperties: false,
                                },
                                active: { type: 'boolean' },
                            },
                            required: ['handle', 'title', 'rect', 'active'],
                            additionalProperties: false,
                        },
                    },
                    screenshotPath: { type: 'string' },
                    failSafeTriggered: { type: 'boolean' },
                    image: {
                        type: 'object',
                        properties: {
                            attachmentId: { type: 'string' },
                            mediaType: { type: 'string' },
                            bytes: { type: 'number' },
                            width: { type: 'number' },
                            height: { type: 'number' },
                            name: { type: 'string' },
                            originalDimensions: {
                                type: 'object',
                                properties: {
                                    width: { type: 'number' },
                                    height: { type: 'number' },
                                },
                                required: ['width', 'height'],
                                additionalProperties: false,
                            },
                        },
                        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
                        additionalProperties: false,
                    },
                },
                required: ['ok', 'action', 'summary', 'driver', 'screenSize', 'scaleFactor', 'cursorPosition'],
                additionalProperties: false,
            },
            render(_args, value) {
                if (value.image !== undefined) {
                    return [
                        { type: 'text', text: value.summary },
                        {
                            type: 'image',
                            attachment: {
                                attachmentId: value.image.attachmentId,
                                mediaType: value.image.mediaType,
                                bytes: value.image.bytes,
                                width: value.image.width,
                                height: value.image.height,
                                ...(value.image.name !== undefined ? { name: value.image.name } : {}),
                                ...(value.image.originalDimensions !== undefined
                                    ? { originalDimensions: value.image.originalDimensions }
                                    : {}),
                            },
                        },
                    ];
                }
                return [{ type: 'text', text: value.summary }];
            },
        },
        isConcurrencySafe(args) {
            if ((process.platform === 'win32' || process.platform === 'darwin') && args.physicalMouse !== true) {
                return true;
            }
            return args.action === 'screenshot' || args.action === 'cursor_position' || args.action === 'list_windows';
        },
        async execute(args, exec) {
            const libnut = loadLibnutNative();
            if (!libnut) {
                const status = getLibnutLoadStatus();
                throw new Error(`当前系统环境无法加载 Computer Use 原生 C++ 驱动 (libnut.node): ${status.error ?? 'unknown error'}（请确认运行在带图形桌面的 Windows / macOS / Linux X11 环境）`);
            }
            const adRuntime = getAgentDesktopRuntime();
            const runtimeAgentId = args.agentId?.trim() ||
                (typeof exec?.agent?.id === 'string'
                    ? exec.agent.id
                    : undefined);
            const agentKey = runtimeAgentId || 'default';
            let agentCtx = computerAgentStates.get(agentKey);
            if (!agentCtx) {
                agentCtx = {};
                computerAgentStates.set(agentKey, agentCtx);
            }
            const screenSize = libnut.getScreenSize();
            const coordSpace = args.coordinateSpace ?? 'pixels';
            const useWinBg = (process.platform === 'win32' || process.platform === 'darwin') && args.physicalMouse !== true;
            // 1. Fail-Safe 急停保护检查（仅在真正移动物理鼠标时检查；Windows 后台琉璃鼠标模式下不拦截用户自己的物理鼠标）
            if (!useWinBg) {
                const failSafe = checkFailSafeBeforeAction(libnut, args.action, args.resetFailSafe);
                if (failSafe.triggered) {
                    return sanitizeLosslessJson({
                        ok: false,
                        action: args.action,
                        summary: failSafe.message ?? '🛑 触发物理鼠标急停保护，已中止操作。',
                        driver: 'libnut-native-cpp',
                        screenSize,
                        scaleFactor: { x: 1, y: 1 },
                        cursorPosition: failSafe.pos,
                        failSafeTriggered: true,
                    });
                }
            }
            const targetPt = resolveLogicalCoordinate(args.x, args.y, args.coordinate, screenSize, coordSpace);
            const settleMs = Math.max(0, Math.min(5000, args.settleMs ?? 320));
            const shouldAutoScreenshot = args.autoScreenshot ??
                (args.action !== 'cursor_position' && args.action !== 'list_windows');
            let actionDesc = '';
            let matchedWindows;
            const curVirtualPos = agentCtx.virtualCursor ?? lastVirtualCursor;
            const curTargetApp = agentCtx.targetApp ?? lastBackgroundTargetApp;
            const curTargetHwnd = agentCtx.targetHwnd ?? lastBackgroundTargetHwnd;
            switch (args.action) {
                case 'screenshot': {
                    actionDesc = '已截取全屏多模态图像';
                    break;
                }
                case 'cursor_position': {
                    const pos = useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos();
                    actionDesc = `当前鼠标逻辑坐标: (${pos.x}, ${pos.y})`;
                    break;
                }
                case 'list_windows': {
                    matchedWindows = listDesktopWindows(libnut);
                    const winLines = matchedWindows.length > 0
                        ? matchedWindows.map((w, idx) => `  ${idx + 1}. ${w.active ? '🟢 [当前激活] ' : ''}"${w.title}" (handle=${w.handle}, rect=${w.rect.x},${w.rect.y} ${w.rect.width}x${w.rect.height})`)
                        : ['  （未枚举到可见顶层窗口，可直接通过 screenshot 视觉定位）'];
                    actionDesc = `已列出桌面可见窗口 (${matchedWindows.length} 个):\n${winLines.join('\n')}`;
                    break;
                }
                case 'focus_window': {
                    const allWins = listDesktopWindows(libnut);
                    let targetWin;
                    if (typeof args.windowHandle === 'number') {
                        targetWin = allWins.find(w => w.handle === args.windowHandle);
                    }
                    if (!targetWin && typeof args.windowTitle === 'string' && args.windowTitle.trim()) {
                        const kw = args.windowTitle.trim().toLowerCase();
                        targetWin =
                            allWins.find(w => w.title.toLowerCase().includes(kw)) ??
                                allWins.find(w => adRuntime.matchWindowsAppCandidate(args.windowTitle, { title: w.title }));
                    }
                    if (!targetWin) {
                        throw new Error(`未找到匹配的桌面窗口（windowTitle=${JSON.stringify(args.windowTitle)}, windowHandle=${args.windowHandle}）。可先调用 computer(action="list_windows") 查看当前打开的窗口列表。`);
                    }
                    const winCenterX = Math.round(targetWin.rect.x + targetWin.rect.width / 2);
                    const winCenterY = Math.round(targetWin.rect.y + Math.min(80, targetWin.rect.height / 3));
                    agentCtx.targetApp = targetWin.title;
                    agentCtx.targetHwnd = targetWin.handle;
                    agentCtx.virtualCursor = { x: winCenterX, y: winCenterY };
                    lastBackgroundTargetApp = targetWin.title;
                    lastBackgroundTargetHwnd = targetWin.handle;
                    lastVirtualCursor = { x: winCenterX, y: winCenterY };
                    if (useWinBg) {
                        const bgRes = await adRuntime.executeWindowsBackgroundPointAction({
                            action: 'restore_no_activate',
                            windowHandle: targetWin.handle,
                            app: targetWin.title,
                        });
                        await sleepMs(Math.min(180, settleMs));
                        actionDesc = `已在后台锁定目标窗口 "${targetWin.title}" (handle=${targetWin.handle}, rect=${targetWin.rect.x},${targetWin.rect.y} ${targetWin.rect.width}x${targetWin.rect.height}, 后台无感模式=${bgRes.detail}，未改变窗口 Z 序且未抢占用户前台窗口焦点)`;
                        break;
                    }
                    await adRuntime.presentDesktopActionCursor({
                        x: winCenterX,
                        y: winCenterY,
                        bubbleText: `Computer-Use · 正在激活窗口「${targetWin.title.slice(0, 18)}」`,
                        isClick: false,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    const focused = typeof libnut.focusWindow === 'function' ? libnut.focusWindow(targetWin.handle) : false;
                    await sleepMs(settleMs);
                    actionDesc = `已请求前置激活窗口 "${targetWin.title}" (handle=${targetWin.handle}, focused=${focused}, rect=${targetWin.rect.x},${targetWin.rect.y} ${targetWin.rect.width}x${targetWin.rect.height})`;
                    break;
                }
                case 'mouse_move': {
                    if (!targetPt) {
                        throw new Error('mouse_move 需要提供目标坐标 (x, y) 或 coordinate: [x, y]');
                    }
                    agentCtx.virtualCursor = { x: targetPt.x, y: targetPt.y };
                    lastVirtualCursor = { x: targetPt.x, y: targetPt.y };
                    lastActionMarker = { x: targetPt.x, y: targetPt.y, label: 'move' };
                    await adRuntime.presentDesktopActionCursor({
                        x: targetPt.x,
                        y: targetPt.y,
                        bubbleText: `Agent-Desktop · 移动至 (${targetPt.x}, ${targetPt.y})`,
                        isClick: false,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    if (!useWinBg) {
                        libnut.moveMouse(targetPt.x, targetPt.y);
                        recordAgentCursorPosition(libnut);
                    }
                    await sleepMs(Math.min(120, settleMs));
                    actionDesc = `已将琉璃小鼠标移动至 (${targetPt.x}, ${targetPt.y})`;
                    break;
                }
                case 'left_click':
                case 'double_click':
                case 'triple_click':
                case 'right_click':
                case 'middle_click': {
                    const clickPos = targetPt ?? (useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos());
                    agentCtx.virtualCursor = { x: clickPos.x, y: clickPos.y };
                    lastVirtualCursor = { x: clickPos.x, y: clickPos.y };
                    const clickLabelMap = {
                        left_click: '左键点击',
                        double_click: '左键双击',
                        triple_click: '三连击选中',
                        right_click: '右键菜单',
                        middle_click: '中键点击',
                    };
                    const matchedRef = useWinBg
                        ? adRuntime.findBestRefAtPoint(clickPos.x, clickPos.y, 'default', {
                            windowId: curTargetHwnd ? `w-${curTargetHwnd}` : undefined,
                            app: curTargetApp,
                        })
                        : undefined;
                    const effectiveCursorAgentId = runtimeAgentId ||
                        (curTargetHwnd
                            ? `win-w-${curTargetHwnd}`
                            : matchedRef?.windowId
                                ? `win-${matchedRef.windowId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
                                : undefined);
                    await adRuntime.presentDesktopActionCursor({
                        x: clickPos.x,
                        y: clickPos.y,
                        bubbleText: `Agent-Desktop · 正在${clickLabelMap[args.action] ?? '点击'} (${clickPos.x}, ${clickPos.y})`,
                        isClick: true,
                        agentId: effectiveCursorAgentId,
                    }).catch(() => { });
                    if (useWinBg) {
                        const bgRes = await adRuntime.executeWindowsBackgroundPointAction({
                            action: args.action === 'middle_click' ? 'left_click' : args.action,
                            x: clickPos.x,
                            y: clickPos.y,
                            app: curTargetApp || matchedRef?.app,
                            windowHandle: curTargetHwnd,
                            elementName: matchedRef?.name,
                            elementRole: matchedRef?.role,
                            automationId: matchedRef?.automationId,
                        });
                        actionDesc = `已通过 Agent-Desktop 后台遮挡透传引擎在 (${clickPos.x}, ${clickPos.y}) 执行 ${args.action} [${bgRes.method}: ${bgRes.detail}]（未抢占系统物理鼠标与前台焦点）`;
                        lastActionMarker = { x: clickPos.x, y: clickPos.y, label: args.action };
                        await sleepMs(settleMs);
                        break;
                    }
                    if (targetPt) {
                        libnut.moveMouse(targetPt.x, targetPt.y);
                        await sleepMs(35);
                    }
                    if (args.action === 'left_click') {
                        libnut.mouseClick('left', false);
                    }
                    else if (args.action === 'double_click') {
                        libnut.mouseClick('left', true);
                    }
                    else if (args.action === 'triple_click') {
                        libnut.mouseClick('left', false);
                        await sleepMs(45);
                        libnut.mouseClick('left', true);
                    }
                    else if (args.action === 'right_click') {
                        libnut.mouseClick('right', false);
                    }
                    else {
                        libnut.mouseClick('middle', false);
                    }
                    recordAgentCursorPosition(libnut);
                    lastActionMarker = { x: clickPos.x, y: clickPos.y, label: args.action };
                    await sleepMs(settleMs);
                    actionDesc = `已在 (${clickPos.x}, ${clickPos.y}) 执行 ${args.action}`;
                    break;
                }
                case 'mouse_down':
                case 'mouse_up': {
                    const curPos = targetPt ?? (useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos());
                    agentCtx.virtualCursor = { x: curPos.x, y: curPos.y };
                    lastVirtualCursor = { x: curPos.x, y: curPos.y };
                    const state = args.action === 'mouse_down' ? 'down' : 'up';
                    await adRuntime.presentDesktopActionCursor({
                        x: curPos.x,
                        y: curPos.y,
                        bubbleText: `Agent-Desktop · ${state === 'down' ? '按下鼠标左键' : '释放鼠标左键'} (${curPos.x}, ${curPos.y})`,
                        isClick: state === 'down',
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    if (useWinBg) {
                        if (state === 'down') {
                            await adRuntime.executeWindowsBackgroundPointAction({
                                action: 'left_click',
                                x: curPos.x,
                                y: curPos.y,
                                app: curTargetApp,
                                windowHandle: curTargetHwnd,
                            });
                        }
                        lastActionMarker = { x: curPos.x, y: curPos.y, label: args.action };
                        await sleepMs(Math.min(150, settleMs));
                        actionDesc = `已在后台 (${curPos.x}, ${curPos.y}) 执行 ${args.action}`;
                        break;
                    }
                    if (targetPt) {
                        libnut.moveMouse(targetPt.x, targetPt.y);
                        await sleepMs(30);
                    }
                    libnut.mouseToggle(state, 'left');
                    const pos = recordAgentCursorPosition(libnut);
                    lastActionMarker = { x: pos.x, y: pos.y, label: args.action };
                    await sleepMs(Math.min(150, settleMs));
                    actionDesc = `已在 (${pos.x}, ${pos.y}) 执行 ${args.action}`;
                    break;
                }
                case 'drag': {
                    const curPos = useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos();
                    const startPt = resolveLogicalCoordinate(args.fromX, args.fromY, undefined, screenSize, coordSpace) ??
                        targetPt ??
                        curPos;
                    const endPt = resolveLogicalCoordinate(args.toX, args.toY, args.endCoordinate, screenSize, coordSpace);
                    if (!endPt) {
                        throw new Error('drag 动作需要提供终点坐标 (toX, toY) 或 endCoordinate: [toX, toY]');
                    }
                    await adRuntime.presentDesktopActionCursor({
                        x: startPt.x,
                        y: startPt.y,
                        bubbleText: `Agent-Desktop · 正在拖拽 (${startPt.x},${startPt.y}) → (${endPt.x},${endPt.y})`,
                        isClick: true,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    libnut.moveMouse(startPt.x, startPt.y);
                    await sleepMs(40);
                    libnut.mouseToggle('down', 'left');
                    await sleepMs(40);
                    const steps = 10;
                    for (let i = 1; i <= steps; i++) {
                        const ix = Math.round(startPt.x + ((endPt.x - startPt.x) * i) / steps);
                        const iy = Math.round(startPt.y + ((endPt.y - startPt.y) * i) / steps);
                        libnut.dragMouse(ix, iy);
                        await sleepMs(14);
                    }
                    libnut.mouseToggle('up', 'left');
                    await adRuntime.presentDesktopActionCursor({
                        x: endPt.x,
                        y: endPt.y,
                        bubbleText: `Agent-Desktop · 已完成拖拽至 (${endPt.x}, ${endPt.y})`,
                        isClick: false,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    agentCtx.virtualCursor = { x: endPt.x, y: endPt.y };
                    lastVirtualCursor = { x: endPt.x, y: endPt.y };
                    recordAgentCursorPosition(libnut);
                    lastActionMarker = { x: endPt.x, y: endPt.y, label: 'drag' };
                    await sleepMs(settleMs);
                    actionDesc = `已从 (${startPt.x}, ${startPt.y}) 拖拽至 (${endPt.x}, ${endPt.y})`;
                    break;
                }
                case 'scroll': {
                    const dir = args.scrollDirection ?? 'down';
                    const amount = Math.max(1, Math.min(50, Math.round(args.scrollAmount ?? 5)));
                    const scrollPos = targetPt ?? (useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos());
                    agentCtx.virtualCursor = { x: scrollPos.x, y: scrollPos.y };
                    lastVirtualCursor = { x: scrollPos.x, y: scrollPos.y };
                    await adRuntime.presentDesktopActionCursor({
                        x: scrollPos.x,
                        y: scrollPos.y,
                        bubbleText: `Agent-Desktop · 正在向 ${dir} 滚动 (${amount} 格)`,
                        isClick: false,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    if (useWinBg) {
                        const bgScroll = await adRuntime.executeWindowsBackgroundPointAction({
                            action: 'scroll',
                            x: scrollPos.x,
                            y: scrollPos.y,
                            direction: dir,
                            amount,
                            app: curTargetApp,
                            windowHandle: curTargetHwnd,
                        });
                        lastActionMarker = { x: scrollPos.x, y: scrollPos.y, label: `scroll_${dir}` };
                        await sleepMs(settleMs);
                        actionDesc = `已在后台 (${scrollPos.x}, ${scrollPos.y}) 向 ${dir} 滚动 ${amount} 刻度 [${bgScroll.detail}]`;
                        break;
                    }
                    if (targetPt) {
                        libnut.moveMouse(targetPt.x, targetPt.y);
                        await sleepMs(30);
                    }
                    let sx = 0;
                    let sy = 0;
                    if (dir === 'down')
                        sy = -amount;
                    else if (dir === 'up')
                        sy = amount;
                    else if (dir === 'right')
                        sx = amount;
                    else if (dir === 'left')
                        sx = -amount;
                    libnut.scrollMouse(sx, sy);
                    const pos = recordAgentCursorPosition(libnut);
                    lastActionMarker = { x: pos.x, y: pos.y, label: `scroll_${dir}` };
                    await sleepMs(settleMs);
                    actionDesc = `已在 (${pos.x}, ${pos.y}) 向 ${dir} 滚动 ${amount} 刻度`;
                    break;
                }
                case 'type': {
                    if (typeof args.text !== 'string') {
                        throw new Error('type 动作需要提供 text 字符串参数');
                    }
                    const typePos = targetPt ?? (useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos());
                    agentCtx.virtualCursor = { x: typePos.x, y: typePos.y };
                    lastVirtualCursor = { x: typePos.x, y: typePos.y };
                    const shortPreview = args.text.length > 16 ? `${args.text.slice(0, 16)}…` : args.text;
                    await adRuntime.presentDesktopActionCursor({
                        x: typePos.x,
                        y: typePos.y,
                        bubbleText: `Agent-Desktop · 正在输入 "${shortPreview}"`,
                        isClick: true,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    if (useWinBg) {
                        const bgType = await adRuntime.executeWindowsBackgroundPointAction({
                            action: 'type',
                            x: typePos.x,
                            y: typePos.y,
                            text: args.text,
                            clearFirst: args.clearFirst,
                            pressEnter: args.pressEnter,
                            app: curTargetApp,
                            windowHandle: curTargetHwnd,
                        });
                        lastActionMarker = { x: typePos.x, y: typePos.y, label: 'type' };
                        await sleepMs(settleMs);
                        const preview = args.text.length > 40 ? `${args.text.slice(0, 40)}...` : args.text;
                        actionDesc = `已在后台向 (${typePos.x}, ${typePos.y}) 无感透传输入文本 ${JSON.stringify(preview)} [${bgType.method}: ${bgType.detail}]（未抢占系统物理鼠标与前台焦点）`;
                        break;
                    }
                    if (targetPt) {
                        libnut.moveMouse(targetPt.x, targetPt.y);
                        await sleepMs(35);
                        libnut.mouseClick('left', false);
                        await sleepMs(60);
                    }
                    const res = await typeTextSmart(libnut, args.text, {
                        clearFirst: args.clearFirst,
                        pressEnter: args.pressEnter,
                    });
                    const pos = recordAgentCursorPosition(libnut);
                    lastActionMarker = { x: pos.x, y: pos.y, label: 'type' };
                    await sleepMs(settleMs);
                    const preview = args.text.length > 40 ? `${args.text.slice(0, 40)}...` : args.text;
                    actionDesc = `已输入文本 ${JSON.stringify(preview)} (方式: ${res.method}${args.pressEnter ? ', 已按回车' : ''})`;
                    break;
                }
                case 'key':
                case 'hotkey': {
                    const combo = normalizeKeyCombo(args.key, args.keys);
                    const keyPos = targetPt ?? (useWinBg && curVirtualPos ? curVirtualPos : libnut.getMousePos());
                    await adRuntime.presentDesktopActionCursor({
                        x: keyPos.x,
                        y: keyPos.y,
                        bubbleText: `Agent-Desktop · 正在按键 [${combo.rawLabel}]`,
                        isClick: true,
                        agentId: runtimeAgentId,
                    }).catch(() => { });
                    if (useWinBg) {
                        const bgKey = await adRuntime.executeWindowsBackgroundPointAction({
                            action: args.action,
                            key: combo.rawLabel,
                            x: keyPos.x,
                            y: keyPos.y,
                            app: curTargetApp,
                            windowHandle: curTargetHwnd,
                        });
                        await sleepMs(settleMs);
                        actionDesc = `已在后台透传触发按键: ${combo.rawLabel} [${bgKey.detail}]`;
                        break;
                    }
                    if (combo.modifiers.length > 0) {
                        libnut.keyTap(combo.mainKey, combo.modifiers);
                    }
                    else {
                        libnut.keyTap(combo.mainKey);
                    }
                    recordAgentCursorPosition(libnut);
                    await sleepMs(settleMs);
                    actionDesc = `已触发按键: ${combo.rawLabel}`;
                    break;
                }
                case 'wait': {
                    const waitMs = Math.max(50, Math.min(15_000, Math.round(args.durationMs ?? 1000)));
                    await sleepMs(waitMs);
                    actionDesc = `已等待 ${waitMs}ms`;
                    break;
                }
                default: {
                    throw new Error(`未知的 computer action: ${String(args.action)}`);
                }
            }
            const finalCursor = useWinBg && (agentCtx.virtualCursor ?? lastVirtualCursor)
                ? (agentCtx.virtualCursor ?? lastVirtualCursor)
                : libnut.getMousePos();
            let activeWindowTitle;
            try {
                if (typeof libnut.getActiveWindow === 'function' && typeof libnut.getWindowTitle === 'function') {
                    const actHandle = libnut.getActiveWindow();
                    const t = libnut.getWindowTitle(actHandle)?.trim();
                    if (t)
                        activeWindowTitle = t;
                }
            }
            catch { }
            let shotInfo;
            if (shouldAutoScreenshot) {
                shotInfo = await captureAndAttachDesktopScreenshot(ctx, libnut, screenSize, {
                    drawGrid: args.grid ?? true,
                    marker: lastActionMarker ?? { x: finalCursor.x, y: finalCursor.y },
                });
            }
            const summaryLines = [
                `🖥️ [Computer Use] ${actionDesc}`,
                `- 逻辑屏幕分辨率: ${screenSize.width}x${screenSize.height} | 当前虚拟/鼠标坐标: (${finalCursor.x}, ${finalCursor.y})${activeWindowTitle ? ` | 当前焦点窗口: "${activeWindowTitle}"` : ''}`,
            ];
            if (shotInfo) {
                summaryLines.push(`- 多模态截图: ${shotInfo.screenshotSize.width}x${shotInfo.screenshotSize.height} (坐标标尺与鼠标像素 1:1 对应${lastActionMarker ? `，红圈准星标示最近落点 (${lastActionMarker.x}, ${lastActionMarker.y})` : ''}，本地路径: ${shotInfo.screenshotPath})`);
            }
            return sanitizeLosslessJson({
                ok: true,
                action: args.action,
                summary: summaryLines.join('\n'),
                driver: 'libnut-native-cpp',
                screenSize,
                ...(shotInfo ? { screenshotSize: shotInfo.screenshotSize } : {}),
                scaleFactor: shotInfo?.scaleFactor ?? { x: 1, y: 1 },
                cursorPosition: finalCursor,
                ...(targetPt ? { targetCoordinate: targetPt } : {}),
                ...(activeWindowTitle ? { activeWindow: activeWindowTitle } : {}),
                ...(matchedWindows ? { windows: matchedWindows } : {}),
                ...(shotInfo ? { screenshotPath: shotInfo.screenshotPath } : {}),
                ...(shotInfo?.image ? { image: shotInfo.image } : {}),
            });
        },
    });
}
