/**
 * GhostPaw — Background Non-Focus-Stealing Computer-Use & Multi-Agent Neon Hollow Cursor Engine
 *
 * Core Capabilities:
 * 1. Background Window Launch & Activation (`launch_background`, `SW_SHOWNOACTIVATE`, Focus Shield):
 *    Launches or restores desktop apps without stealing foreground focus or interrupting the human user.
 * 2. Occluded Window Passthrough (`GhostPawWin32BgV4` / X11 / macOS CGEvent):
 *    Delivers clicks, double-clicks, right-clicks, text input, keyboard shortcuts, scrolling, and DWM `PrintWindow`
 *    screenshots directly to occluded or background windows without moving the physical OS mouse cursor.
 * 3. Multi-Sub-Agent Parallel Execution & Neon Hollow GhostPaw Cursor Overlay:
 *    Automatically isolates window targets and renders independent Neon Hollow GhostPaw cursors + live action bubbles
 *    per sub-agent / target window, auto-hiding after 10 seconds of inactivity.
 *
 * @module ghost-paw/agent-desktop
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAR_CURSOR_DATA_URI, GHOSTPAW_CURSOR_HOTSPOT } from '../cursor-asset.js';
import { extractTarGzBuffer } from '../tar-utils.js';
/**
 * 彻底剥离返回对象中的 `undefined` 字段，防止 Cordis 抛出 `value is not lossless JSON`
 */
export function sanitizeLosslessJson(value) {
    return JSON.parse(JSON.stringify(value));
}
/** 圆角三角形 3D 琉璃渐变小鼠标 (34×34) 的左上角点击尖端热点 */
export const STAR_CURSOR_HOTSPOT = GHOSTPAW_CURSOR_HOTSPOT;
/** 集成的 vercel-labs/agent-desktop 官方稳定版本号 */
export const AGENT_DESKTOP_VERSION = '1.2.0';
/** 操作结束后若超过该毫秒数未发出下一条指令，自动隐藏并销毁桌面迷你小鼠标（10 秒） */
export const CURSOR_IDLE_AUTO_HIDE_MS = 10000;
/** 本地 X11 32-bit ARGB 透明小鼠标与聊天气泡守护进程基础 UDP 端口 */
const X11_OVERLAY_UDP_PORT = 48391;
/**
 * `vercel-labs/agent-desktop v1.2.0` 全平台官方预编译包矩阵与 SHA-256 校验表
 */
export const AGENT_DESKTOP_RELEASE_MATRIX = {
    'darwin-arm64': {
        key: 'darwin-arm64',
        rustTarget: 'aarch64-apple-darwin',
        tarballName: `agent-desktop-v${AGENT_DESKTOP_VERSION}-aarch64-apple-darwin.tar.gz`,
        sha256: '219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82',
        mainBinary: 'agent-desktop',
        entries: ['agent-desktop', 'agent-desktop-macos-helper'],
    },
    'darwin-x64': {
        key: 'darwin-x64',
        rustTarget: 'x86_64-apple-darwin',
        tarballName: `agent-desktop-v${AGENT_DESKTOP_VERSION}-x86_64-apple-darwin.tar.gz`,
        sha256: 'd9dc50226f28d7fc86a2f5b0945f0c206dff6c31e418907749f493b6f9e773e6',
        mainBinary: 'agent-desktop',
        entries: ['agent-desktop', 'agent-desktop-macos-helper'],
    },
    'win32-x64': {
        key: 'win32-x64',
        rustTarget: 'x86_64-pc-windows-msvc',
        tarballName: `agent-desktop-v${AGENT_DESKTOP_VERSION}-x86_64-pc-windows-msvc.tar.gz`,
        sha256: 'a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8',
        mainBinary: 'agent-desktop.exe',
        entries: ['agent-desktop.exe'],
    },
    'win32-arm64': {
        key: 'win32-arm64',
        rustTarget: 'aarch64-pc-windows-msvc',
        tarballName: `agent-desktop-v${AGENT_DESKTOP_VERSION}-aarch64-pc-windows-msvc.tar.gz`,
        sha256: 'd6d8643310c2c13eace2261444d9e4c0d16ca09581f38500983104903604caa6',
        mainBinary: 'agent-desktop.exe',
        entries: ['agent-desktop.exe'],
    },
    'linux-x64': {
        key: 'linux-x64',
        rustTarget: 'x86_64-unknown-linux-gnu',
        tarballName: `agent-desktop-v${AGENT_DESKTOP_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
        sha256: '591ae7f4a38479dc045df97e27447c0c8b530441730ab6b990e27c813162af44',
        mainBinary: 'agent-desktop',
        entries: ['agent-desktop', 'agent-desktop-linux-clipboard-owner'],
    },
    'linux-arm64': {
        key: 'linux-arm64',
        rustTarget: 'aarch64-unknown-linux-gnu',
        tarballName: `agent-desktop-v${AGENT_DESKTOP_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
        sha256: '68e8ebbb4f80e44485d2f1cf972943a38ee43108e2e0ce56bdfa641fd1599f68',
        mainBinary: 'agent-desktop',
        entries: ['agent-desktop', 'agent-desktop-linux-clipboard-owner'],
    },
};
/**
 * 解析当前操作系统与 CPU 架构对应的 `agent-desktop` 目标描述
 */
export function resolveAgentDesktopTarget(platform = process.platform, arch = process.arch) {
    return AGENT_DESKTOP_RELEASE_MATRIX[`${platform}-${arch}`];
}
const hardenedWinDirs = new Set();
let fallbackWinStateSubdir;
function repairWindowsPrivateDirAclAndOwner(dirPath) {
    if (process.platform !== 'win32')
        return;
    const username = process.env.USERNAME?.trim();
    try {
        if (username) {
            spawnSync('icacls.exe', [dirPath, '/setowner', username, '/T', '/C', '/Q'], {
                timeout: 3500,
                windowsHide: true,
            });
        }
        spawnSync('icacls.exe', [dirPath, '/inheritance:d', '/Q'], { timeout: 2500, windowsHide: true });
        if (username) {
            spawnSync('icacls.exe', [dirPath, '/grant:r', `${username}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F', '/T', '/C', '/Q'], { timeout: 3500, windowsHide: true });
        }
        spawnSync('icacls.exe', [dirPath, '/remove:g', 'Users', 'Authenticated Users', 'Everyone', 'CodexSandboxUsers', '/T', '/C', '/Q'], { timeout: 3500, windowsHide: true });
    }
    catch { }
}
function ensurePrivateDir(dirPath) {
    mkdirSync(dirPath, { recursive: true });
    if (process.platform !== 'win32') {
        try {
            chmodSync(dirPath, 0o700);
        }
        catch { }
    }
    else if (!hardenedWinDirs.has(dirPath)) {
        hardenedWinDirs.add(dirPath);
        // 自动修复 Owner 为当前用户名并移除可能从 %USERPROFILE% 继承的非受信组（如 CodexSandboxUsers），
        // 防止因管理员/SSH 终端与普通桌面进程混用导致 agent-desktop.exe 报 "foreign principal" 或 "untrusted principal"
        repairWindowsPrivateDirAclAndOwner(dirPath);
    }
    return dirPath;
}
/** 获取插件专属的 `agent-desktop` 根目录 (`~/.ghostpaw`) */
export function getAgentDesktopRootDir() {
    const root = process.env.GHOSTPAW_HOME?.trim() || join(homedir(), '.ghostpaw');
    return ensurePrivateDir(root);
}
/** 获取 `agent-desktop` 状态目录 (`~/.ghostpaw/state`) */
export function getAgentDesktopStateDir() {
    return ensurePrivateDir(join(getAgentDesktopRootDir(), fallbackWinStateSubdir || 'state'));
}
/**
 * 确保插件标志性的 Gemini 圆角三角形 3D 琉璃渐变小鼠标透明 PNG (56×56, hotspot `6,2`) 已落盘
 */
export function ensureStarCursorAsset() {
    const assetsDir = ensurePrivateDir(join(getAgentDesktopRootDir(), 'assets'));
    const cursorPngPath = join(assetsDir, 'ghostpaw-neon-hollow-cursor.png');
    const legacyPngPath = join(assetsDir, 'ghostpaw-cursor.png');
    const base64Payload = STAR_CURSOR_DATA_URI.replace(/^data:image\/png;base64,/, '');
    const pngBuf = Buffer.from(base64Payload, 'base64');
    try {
        if (!existsSync(cursorPngPath) || statSync(cursorPngPath).size !== pngBuf.byteLength) {
            writeFileSync(cursorPngPath, pngBuf, { mode: 0o600 });
        }
        if (!existsSync(legacyPngPath) || statSync(legacyPngPath).size !== pngBuf.byteLength) {
            writeFileSync(legacyPngPath, pngBuf, { mode: 0o600 });
        }
        if (process.platform !== 'win32') {
            chmodSync(cursorPngPath, 0o600);
            chmodSync(legacyPngPath, 0o600);
        }
    }
    catch {
        writeFileSync(cursorPngPath, pngBuf, { mode: 0o600 });
    }
    return cursorPngPath;
}
/**
 * Linux X11 原生 32-bit ARGB 透明鼠标穿透覆盖层守护脚本：
 * - 解决 `agent-desktop` 原生 Linux X11 stub 不支持自定义 PNG 图标与气泡标签、只会画丑陋蓝色多边形的问题；
 * - 使用 `libX11` 32-bit `TrueColor` Visual + `libXfixes` 空 `ShapeInput`（100% 鼠标点击穿透、不抢焦点）；
 * - 渲染 Gemini 3D 琉璃圆角三角光标 + 实时动作聊天气泡 + 点击水波纹 + 60fps 贝塞尔平滑移动；
 * - 严格空闲超时自毁：当 `idle_sec`（默认 10 秒）内未收到新指令时，自动 Unmap 并销毁 X11 窗口后退出进程，绝不残留！
 */
const X11_CURSOR_DAEMON_SCRIPT = `#!/usr/bin/env python3
import ctypes
import ctypes.util
import json
import os
import socket
import sys
import time
import numpy as np
from PIL import Image, ImageDraw, ImageFont

UDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 48391
CURSOR_PNG = sys.argv[2] if len(sys.argv) > 2 else ""
INIT_JSON = sys.argv[3] if len(sys.argv) > 3 else "{}"

x11_path = ctypes.util.find_library("X11")
xfixes_path = ctypes.util.find_library("Xfixes")
if not x11_path or not xfixes_path:
    sys.exit(0)

x11 = ctypes.cdll.LoadLibrary(x11_path)
xfixes = ctypes.cdll.LoadLibrary(xfixes_path)

class XVisualInfo(ctypes.Structure):
    _fields_ = [
        ("visual", ctypes.c_void_p),
        ("visualid", ctypes.c_ulong),
        ("screen", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("c_class", ctypes.c_int),
        ("red_mask", ctypes.c_ulong),
        ("green_mask", ctypes.c_ulong),
        ("blue_mask", ctypes.c_ulong),
        ("colormap_size", ctypes.c_int),
        ("bits_per_rgb", ctypes.c_int),
    ]

class XSetWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("background_pixmap", ctypes.c_ulong),
        ("background_pixel", ctypes.c_ulong),
        ("border_pixmap", ctypes.c_ulong),
        ("border_pixel", ctypes.c_ulong),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("cursor", ctypes.c_ulong),
    ]

x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
x11.XDefaultScreen.restype = ctypes.c_int
x11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XRootWindow.restype = ctypes.c_ulong
x11.XMatchVisualInfo.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.POINTER(XVisualInfo)]
x11.XMatchVisualInfo.restype = ctypes.c_int
x11.XCreateColormap.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_int]
x11.XCreateColormap.restype = ctypes.c_ulong
x11.XCreateWindow.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
    ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_int,
    ctypes.c_uint, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XSetWindowAttributes)
]
x11.XCreateWindow.restype = ctypes.c_ulong
x11.XCreateGC.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
x11.XCreateGC.restype = ctypes.c_void_p
x11.XFreeGC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
x11.XCreateImage.argtypes = [
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_int,
    ctypes.c_int, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint,
    ctypes.c_int, ctypes.c_int
]
x11.XCreateImage.restype = ctypes.c_void_p
x11.XPutImage.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_uint, ctypes.c_uint
]
x11.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XUnmapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XMoveWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int]
x11.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XStoreName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

xfixes.XFixesCreateRegion.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
xfixes.XFixesCreateRegion.restype = ctypes.c_ulong
xfixes.XFixesSetWindowShapeRegion.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xfixes.XFixesDestroyRegion.argtypes = [ctypes.c_void_p, ctypes.c_ulong]

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("127.0.0.1", UDP_PORT))
except Exception:
    sys.exit(0)
sock.setblocking(False)

disp_name = os.environ.get("DISPLAY", ":0").encode("utf-8")
dpy = x11.XOpenDisplay(disp_name)
if not dpy:
    sys.exit(0)

scr = x11.XDefaultScreen(dpy)
root = x11.XRootWindow(dpy, scr)
vinfo = XVisualInfo()
if not x11.XMatchVisualInfo(dpy, scr, 32, 4, ctypes.byref(vinfo)):
    x11.XCloseDisplay(dpy)
    sys.exit(0)

cmap = x11.XCreateColormap(dpy, root, vinfo.visual, 0)
attrs = XSetWindowAttributes()
attrs.background_pixel = 0
attrs.border_pixel = 0
attrs.override_redirect = 1
attrs.colormap = cmap

W, H = 440, 96
TIP_OFFSET_X = 24
TIP_OFFSET_Y = 24
HOTSPOT_X = 4
HOTSPOT_Y = 1

win = x11.XCreateWindow(dpy, root, -600, -600, W, H, 0, 32, 1, vinfo.visual, 0x220A, ctypes.byref(attrs))
x11.XStoreName(dpy, win, b"ghostpaw-cursor-overlay")
region = xfixes.XFixesCreateRegion(dpy, None, 0)
xfixes.XFixesSetWindowShapeRegion(dpy, win, 2, 0, 0, region)
xfixes.XFixesDestroyRegion(dpy, region)
gc = x11.XCreateGC(dpy, win, 0, None)

cursor_sprite = Image.open(CURSOR_PNG).convert("RGBA").resize((32, 32), Image.Resampling.LANCZOS)
font_paths = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
font = ImageFont.load_default()
for fp in font_paths:
    if os.path.exists(fp):
        try:
            font = ImageFont.truetype(fp, 13)
            break
        except Exception:
            pass

def render_frame(bubble_text, ripple_progress=None):
    frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(frame)
    if ripple_progress is not None and 0.0 <= ripple_progress <= 1.0:
        rad = int(6 + 20 * ripple_progress)
        alpha_r = int(210 * (1.0 - ripple_progress))
        draw.ellipse(
            [TIP_OFFSET_X - rad, TIP_OFFSET_Y - rad, TIP_OFFSET_X + rad, TIP_OFFSET_Y + rad],
            fill=(56, 189, 248, int(alpha_r * 0.35)),
            outline=(56, 189, 248, alpha_r),
            width=2,
        )
    cx = TIP_OFFSET_X - HOTSPOT_X
    cy = TIP_OFFSET_Y - HOTSPOT_Y
    frame.paste(cursor_sprite, (cx, cy), cursor_sprite)

    if bubble_text:
        clean_text = bubble_text.replace("💬", "").replace("✨", "").strip()
        try:
            bbox = draw.textbbox((0, 0), clean_text, font=font)
            tw = bbox[2] - bbox[0]
        except Exception:
            tw = len(clean_text) * 13
        bx = cx + 31
        by = cy + 14
        bw = min(W - bx - 6, max(120, tw + 38))
        bh = 32
        # Chat bubble tail triangle pointing toward cursor
        draw.polygon([(bx - 6, by + 12), (bx + 2, by + 7), (bx + 2, by + 19)], fill=(15, 23, 42, 238))
        draw.rounded_rectangle(
            [bx, by, bx + bw, by + bh],
            radius=16,
            fill=(15, 23, 42, 238),
            outline=(56, 189, 248, 255),
            width=2,
        )
        # Glowing cyan status dot inside chat bubble
        draw.ellipse([bx + 11, by + 11, bx + 21, by + 21], fill=(56, 189, 248, 255))
        draw.text((bx + 27, by + 6), clean_text, fill=(248, 250, 252, 255), font=font)

    arr = np.array(frame, dtype=np.float32)
    a = arr[:, :, 3:4] / 255.0
    bgra = np.zeros_like(arr, dtype=np.uint8)
    bgra[:, :, 0] = np.clip(arr[:, :, 2:3] * a, 0, 255)[:, :, 0].astype(np.uint8)
    bgra[:, :, 1] = np.clip(arr[:, :, 1:2] * a, 0, 255)[:, :, 0].astype(np.uint8)
    bgra[:, :, 2] = np.clip(arr[:, :, 0:1] * a, 0, 255)[:, :, 0].astype(np.uint8)
    bgra[:, :, 3] = arr[:, :, 3].astype(np.uint8)
    return bgra.tobytes()

cur_x, cur_y = 760.0, 420.0
start_x, start_y = 760.0, 420.0
target_x, target_y = 760.0, 420.0
move_start_t = time.time()
move_dur = 0.22
click_start_t = None
current_text = ""
last_cmd_t = time.time()
idle_timeout = 10.0
mapped = False
last_rendered_text = None
cached_buf = None
c_buf = None

def apply_command(cmd):
    global start_x, start_y, target_x, target_y, cur_x, cur_y, move_start_t, click_start_t, current_text, last_cmd_t, idle_timeout, mapped, last_rendered_text
    action = cmd.get("action", "present")
    if action == "hide":
        if mapped:
            x11.XUnmapWindow(dpy, win)
            x11.XFlush(dpy)
        return False
    now = time.time()
    last_cmd_t = now
    idle_timeout = float(cmd.get("idleSec", 10.0))
    nx = float(cmd.get("x", cur_x))
    ny = float(cmd.get("y", cur_y))
    if not mapped:
        cur_x, cur_y = nx, ny
        start_x, start_y = nx, ny
        target_x, target_y = nx, ny
    else:
        start_x, start_y = cur_x, cur_y
        target_x, target_y = nx, ny
    move_start_t = now
    if cmd.get("click"):
        click_start_t = now
    new_text = str(cmd.get("text", "") or "")
    if new_text != current_text:
        current_text = new_text
        last_rendered_text = None
    return True

try:
    init_cmd = json.loads(INIT_JSON)
    if init_cmd:
        if not apply_command(init_cmd):
            sys.exit(0)
except Exception:
    pass

while True:
    now = time.time()
    while True:
        try:
            data, _ = sock.recvfrom(8192)
            cmd = json.loads(data.decode("utf-8"))
            if not apply_command(cmd):
                x11.XFreeGC(dpy, gc)
                x11.XDestroyWindow(dpy, win)
                x11.XFlush(dpy)
                x11.XCloseDisplay(dpy)
                sock.close()
                sys.exit(0)
        except BlockingIOError:
            break
        except Exception:
            break

    if now - last_cmd_t >= idle_timeout:
        if mapped:
            x11.XUnmapWindow(dpy, win)
            x11.XFlush(dpy)
        break

    t = min(1.0, max(0.0, (now - move_start_t) / move_dur))
    ease = 1.0 - pow(1.0 - t, 3)
    cur_x = start_x + (target_x - start_x) * ease
    cur_y = start_y + (target_y - start_y) * ease

    ripple_p = None
    if click_start_t is not None:
        rp = (now - click_start_t) / 0.38
        if rp <= 1.0:
            ripple_p = rp
        else:
            click_start_t = None

    if ripple_p is not None or last_rendered_text != current_text or cached_buf is None:
        cached_buf = render_frame(current_text, ripple_p)
        c_buf = ctypes.create_string_buffer(cached_buf)
        last_rendered_text = current_text
        ximg = x11.XCreateImage(dpy, vinfo.visual, 32, 2, 0, c_buf, W, H, 32, W * 4)
        x11.XPutImage(dpy, win, gc, ximg, 0, 0, 0, 0, W, H)

    win_x = int(round(cur_x)) - TIP_OFFSET_X
    win_y = int(round(cur_y)) - TIP_OFFSET_Y
    x11.XMoveWindow(dpy, win, win_x, win_y)
    if not mapped:
        x11.XMapRaised(dpy, win)
        mapped = True
    x11.XFlush(dpy)
    time.sleep(0.016)

x11.XFreeGC(dpy, gc)
x11.XDestroyWindow(dpy, win)
x11.XFlush(dpy)
x11.XCloseDisplay(dpy)
sock.close()
`;
function ensureX11CursorDaemonScript() {
    const scriptPath = join(getAgentDesktopRootDir(), 'x11-cursor-daemon.py');
    try {
        if (!existsSync(scriptPath) || readFileSync(scriptPath, 'utf8') !== X11_CURSOR_DAEMON_SCRIPT) {
            writeFileSync(scriptPath, X11_CURSOR_DAEMON_SCRIPT, { mode: 0o700 });
        }
    }
    catch {
        writeFileSync(scriptPath, X11_CURSOR_DAEMON_SCRIPT, { mode: 0o700 });
    }
    return scriptPath;
}
function computeX11OverlayUdpPort(agentId) {
    const clean = agentId?.trim();
    if (!clean)
        return X11_OVERLAY_UDP_PORT;
    let h = 0;
    for (let i = 0; i < clean.length; i++) {
        h = (h * 31 + clean.charCodeAt(i)) >>> 0;
    }
    return X11_OVERLAY_UDP_PORT + 1 + (h % 400);
}
function sendUdpToX11Daemon(payload, port = X11_OVERLAY_UDP_PORT) {
    return new Promise(resolvePromise => {
        try {
            const client = createSocket('udp4');
            const buf = Buffer.from(JSON.stringify(payload), 'utf8');
            client.send(buf, port, '127.0.0.1', () => {
                try {
                    client.close();
                }
                catch { }
                resolvePromise();
            });
        }
        catch {
            resolvePromise();
        }
    });
}
const inProcessKeepAliveTimers = new Map();
const inProcessAutoHideTimers = new Map();
const lastCursorPosByAgent = new Map();
let lastCursorPos = { x: 480, y: 360 };
/**
 * 计算与 `agent-desktop` Rust 内核 (`pipe_name.rs` / `endpoint.rs`) 100% 字节一致的 FNV-1a 64 位哈希
 */
export function fnv1a64Hex(parts) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (const part of parts) {
        const buf = Buffer.from(part, 'utf8');
        for (let i = 0; i < buf.length; i++) {
            hash ^= BigInt(buf[i]);
            hash = (hash * prime) & mask;
        }
    }
    return hash.toString(16).padStart(16, '0');
}
/**
 * 计算 Windows Named Pipe 或 macOS Unix Socket 控制端点路径
 */
export function computeCursorOverlayEndpoint(stateDir, sessionId, agentId) {
    if (process.platform === 'win32') {
        const sessionHash = fnv1a64Hex([stateDir, sessionId, 'w1']);
        if (agentId) {
            const agentHash = fnv1a64Hex([stateDir, agentId, 'agent']);
            return `\\\\.\\pipe\\agent-desktop-cursor-${sessionHash}-${agentHash}`;
        }
        return `\\\\.\\pipe\\agent-desktop-cursor-${sessionHash}`;
    }
    const sessionHash = fnv1a64Hex([stateDir, sessionId, 'v2']);
    const sockName = agentId
        ? `.cursor-overlay-${sessionHash}-${fnv1a64Hex([stateDir, agentId, 'agent'])}.sock`
        : `.cursor-overlay-${sessionHash}.sock`;
    const candidate = join(stateDir, sockName);
    if (Buffer.byteLength(candidate, 'utf8') < 100) {
        return candidate;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    return join('/tmp', `agent-desktop-${uid}`, sockName);
}
function buildCursorOverlayStylePayload(starPngPath) {
    return {
        rim: '#111318',
        accent: '#38BDF8',
        size: 1.0,
        ripple: true,
        highlight: true,
        images: {
            arrow: {
                path: starPngPath,
                hotspot: { x: STAR_CURSOR_HOTSPOT.x, y: STAR_CURSOR_HOTSPOT.y },
            },
            pointer: {
                path: starPngPath,
                hotspot: { x: STAR_CURSOR_HOTSPOT.x, y: STAR_CURSOR_HOTSPOT.y },
            },
        },
    };
}
function clampOverlayLabelWords(rawLabel, maxWords = 10) {
    const cleaned = rawLabel.replace(/\s+/g, ' ').trim();
    if (!cleaned)
        return 'Agent-Desktop';
    const words = cleaned.split(' ');
    if (words.length <= maxWords)
        return cleaned;
    return `${words.slice(0, maxWords).join(' ')}…`;
}
/**
 * 直接更新 `<stateDir>/sessions/<sessionId>/session.json` 及多智能体 `<stateDir>/sessions/<sessionId>/cursor-overlays/<agentId>.json` 中的 `cursor_overlay` 配置：
 * - 绝不调用 `agent-desktop cursor-overlay enable`（避免触发 `CursorOverlayControl::Enable` 导致小鼠标停在屏幕正中央 `(960, 520)`）；
 * - 当后续 `agent-desktop click/set-value/select` 执行时，Rust 内核会自动读取该配置并将 34×34 琉璃小鼠标与气泡直接投送到目标控件 `@ref` 坐标！
 */
export function syncSessionCursorOverlayManifest(sessionId, options) {
    try {
        const stateDir = getAgentDesktopStateDir();
        const sessionDir = join(stateDir, 'sessions', sessionId);
        const manifestPath = join(sessionDir, 'session.json');
        const starPngPath = ensureStarCursorAsset();
        const cleanLabel = clampOverlayLabelWords(options.label || 'Agent-Desktop', 10);
        const overlayObj = {
            enabled: true,
            label: cleanLabel,
            max_words: 12,
            ...(options.multiAgent || options.agentId ? { multi_agent: true } : {}),
            style: buildCursorOverlayStylePayload(starPngPath),
        };
        // 关键：从 session.json 中移除全局 cursor_overlay 字段，避免 agent-desktop.exe CLI (snapshot/find/get)
        // 读取 session.json 后覆盖各智能体/各窗口独立 Named Pipe 渲染器的聊天气泡文案！
        if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            if ('cursor_overlay' in manifest) {
                delete manifest.cursor_overlay;
                writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
            }
        }
        const agentFileKey = options.agentId && /^[a-zA-Z0-9_-]{1,64}$/.test(options.agentId) ? options.agentId : 'default';
        const agentOverlaysDir = join(sessionDir, 'cursor-overlays');
        mkdirSync(agentOverlaysDir, { recursive: true });
        const agentManifestPath = join(agentOverlaysDir, `${agentFileKey}.json`);
        if (options.enabled) {
            writeFileSync(agentManifestPath, `${JSON.stringify(overlayObj, null, 2)}\n`, 'utf8');
        }
    }
    catch { }
}
function writeControlToPipeOnce(endpoint, payloadBuf, expectAck, timeoutMs = 650) {
    return new Promise(resolvePromise => {
        let settled = false;
        const sock = createConnection(endpoint);
        const done = (status) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                sock.destroy();
            }
            catch { }
            resolvePromise(status);
        };
        const timer = setTimeout(() => done(expectAck ? 'error' : 'delivered'), timeoutMs);
        sock.on('error', (err) => {
            if (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED') {
                done('no_renderer');
            }
            else {
                done('error');
            }
        });
        sock.on('connect', () => {
            sock.write(payloadBuf, err => {
                if (err) {
                    done('error');
                    return;
                }
                if (!expectAck) {
                    done('delivered');
                }
            });
        });
        if (expectAck) {
            sock.on('data', chunk => {
                if (chunk.length > 0 && chunk[0] === 1) {
                    done('delivered');
                }
                else {
                    done('error');
                }
            });
            sock.on('end', () => {
                done('delivered');
            });
        }
    });
}
/**
 * 向 Windows Named Pipe 或 macOS Unix Socket 直接发送 `CursorOverlayControl` 指令（如 `Present` / `Hide` / `Disable`）
 */
export async function sendNativeCursorOverlayControl(sessionId, control, options = {}) {
    const stateDir = getAgentDesktopStateDir();
    const endpoint = computeCursorOverlayEndpoint(stateDir, sessionId, options.agentId);
    const payloadBuf = Buffer.from(JSON.stringify(control), 'utf8');
    const expectAck = options.expectAck ?? (control.action !== 'present' || control.instruction?.phase !== 'effect');
    const firstTry = await writeControlToPipeOnce(endpoint, payloadBuf, expectAck, 650);
    if (firstTry === 'delivered') {
        return true;
    }
    if (firstTry !== 'no_renderer' || !options.allowSpawn) {
        return false;
    }
    // 按需拉起 `agent-desktop` 原生无边框透明分层渲染器子进程
    try {
        const binPath = await ensureAgentDesktopBinary();
        if (process.platform === 'win32') {
            const childArgs = ['--cursor-overlay-child', sessionId, 'w1'];
            if (options.agentId)
                childArgs.push(options.agentId);
            const child = spawn(binPath, childArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: {
                    ...process.env,
                    AGENT_DESKTOP_HOME: stateDir,
                    AGENT_DESKTOP_CURSOR_OVERLAY_CHILD: 'w1',
                },
            });
            child.unref();
        }
        else if (process.platform === 'darwin') {
            const helperPath = join(binPath, '..', 'agent-desktop-macos-helper');
            const spawnBin = existsSync(helperPath) ? helperPath : binPath;
            const child = spawn(spawnBin, ['--cursor-overlay-child'], {
                detached: true,
                stdio: ['pipe', 'ignore', 'ignore'],
                env: {
                    ...process.env,
                    AGENT_DESKTOP_HOME: stateDir,
                },
            });
            try {
                child.stdin?.write(payloadBuf);
                child.stdin?.end();
            }
            catch { }
            child.unref();
        }
        for (let attempt = 0; attempt < 14; attempt++) {
            await new Promise(r => setTimeout(r, 28));
            const retry = await writeControlToPipeOnce(endpoint, payloadBuf, expectAck, 500);
            if (retry === 'delivered') {
                return true;
            }
        }
    }
    catch { }
    return false;
}
/**
 * 在执行 `agent_desktop` 或 `computer` 操作时按需唤醒圆角三角形 3D 琉璃小鼠标与实时动作聊天气泡，
 * 直接将小鼠标移动到目标 `(x, y)` 坐标（绝不停留在屏幕正中央！），
 * 并在 `idleTimeoutMs`（默认 10 秒）无新指令后自动隐藏覆盖层窗口！
 */
export async function presentDesktopActionCursor(options) {
    const agentKey = options.agentId?.trim() || 'default';
    const safeAgentKey = agentKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const prevPos = lastCursorPosByAgent.get(agentKey) ?? lastCursorPos;
    const hasExplicitCoord = typeof options.x === 'number' &&
        Number.isFinite(options.x) &&
        typeof options.y === 'number' &&
        Number.isFinite(options.y);
    const targetX = hasExplicitCoord ? Math.round(options.x) : prevPos.x;
    const targetY = hasExplicitCoord ? Math.round(options.y) : prevPos.y;
    if (hasExplicitCoord) {
        lastCursorPos = { x: targetX, y: targetY };
        lastCursorPosByAgent.set(agentKey, { x: targetX, y: targetY });
    }
    const idleMs = options.idleTimeoutMs ?? CURSOR_IDLE_AUTO_HIDE_MS;
    const idleSec = Math.max(1.2, +(idleMs / 1000).toFixed(2));
    const starPngPath = ensureStarCursorAsset();
    const cleanLabel = clampOverlayLabelWords(options.bubbleText, 10);
    // 记录当前智能体的最新动作时间戳（供跨进程看门狗判断空闲状态，多智能体互不覆盖）
    const tsFile = join(getAgentDesktopRootDir(), `last-action-ts-${safeAgentKey}.txt`);
    const nowMs = Date.now();
    try {
        writeFileSync(tsFile, String(nowMs), 'utf8');
    }
    catch { }
    if (process.platform === 'linux') {
        const scriptPath = ensureX11CursorDaemonScript();
        const udpPort = computeX11OverlayUdpPort(options.agentId);
        const payload = {
            action: 'present',
            x: targetX,
            y: targetY,
            text: cleanLabel,
            click: Boolean(options.isClick),
            idleSec,
        };
        await sendUdpToX11Daemon(payload, udpPort);
        try {
            const child = spawn('python3', [scriptPath, String(udpPort), starPngPath, JSON.stringify(payload)], {
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    DISPLAY: process.env.DISPLAY || ':0',
                },
            });
            child.unref();
        }
        catch { }
        return;
    }
    // Windows / macOS:
    // 1. 同步更新 session.json 及 cursor-overlays/<agentId>.json 中的 cursor_overlay 配置
    // 2. 若已知目标坐标 (x, y)，直接通过 Named Pipe / Unix Socket 发送 CursorOverlayControl::Present 移动到 (x, y)！
    let sid = options.sessionId || activeSessions.get('default')?.sessionId;
    if (!sid) {
        try {
            const state = await ensureAgentDesktopSession({
                sessionKey: 'default',
                agentId: options.agentId,
            });
            sid = state.sessionId;
        }
        catch { }
    }
    if (!sid)
        return;
    syncSessionCursorOverlayManifest(sid, {
        enabled: true,
        label: cleanLabel,
        multiAgent: Boolean(options.agentId),
        agentId: options.agentId,
    });
    const stylePayload = buildCursorOverlayStylePayload(starPngPath);
    const targetRect = options.targetRect &&
        options.targetRect.width > 0 &&
        options.targetRect.height > 0
        ? {
            x: options.targetRect.x,
            y: options.targetRect.y,
            width: options.targetRect.width,
            height: options.targetRect.height,
        }
        : undefined;
    const keepAliveControl = {
        action: 'present',
        session_id: sid,
        ...(options.agentId ? { agent_id: options.agentId } : {}),
        instruction: {
            destination: { x: targetX, y: targetY },
            label: cleanLabel,
            click: false,
            ...(targetRect ? { target: targetRect } : {}),
            phase: 'travel',
            pointer: false,
        },
        style: stylePayload,
    };
    if (hasExplicitCoord) {
        const travelControl = {
            action: 'present',
            session_id: sid,
            ...(options.agentId ? { agent_id: options.agentId } : {}),
            instruction: {
                destination: { x: targetX, y: targetY },
                label: cleanLabel,
                click: Boolean(options.isClick),
                ...(targetRect ? { target: targetRect } : {}),
                phase: 'travel',
                pointer: Boolean(options.isClick),
            },
            style: stylePayload,
        };
        await sendNativeCursorOverlayControl(sid, travelControl, {
            agentId: options.agentId,
            expectAck: true,
            allowSpawn: true,
        });
        if (options.isClick) {
            const effectControl = {
                action: 'present',
                session_id: sid,
                ...(options.agentId ? { agent_id: options.agentId } : {}),
                instruction: {
                    destination: { x: targetX, y: targetY },
                    label: cleanLabel,
                    click: true,
                    ...(targetRect ? { target: targetRect } : {}),
                    phase: 'effect',
                },
                style: stylePayload,
            };
            await sendNativeCursorOverlayControl(sid, effectControl, {
                agentId: options.agentId,
                expectAck: false,
                allowSpawn: false,
            });
        }
    }
    const prevKeepAlive = inProcessKeepAliveTimers.get(agentKey);
    if (prevKeepAlive) {
        clearTimeout(prevKeepAlive);
        inProcessKeepAliveTimers.delete(agentKey);
    }
    const prevAutoHide = inProcessAutoHideTimers.get(agentKey);
    if (prevAutoHide) {
        clearTimeout(prevAutoHide);
        inProcessAutoHideTimers.delete(agentKey);
    }
    // agent-desktop 原生渲染器内置 6s 无指令自动淡出；因此在 4.8s 处发送一次静默续期，使光标稳定保持显示满 10s 后准时消失
    if (idleMs > 5200 && hasExplicitCoord) {
        const kaTimer = setTimeout(() => {
            void sendNativeCursorOverlayControl(sid, keepAliveControl, {
                agentId: options.agentId,
                expectAck: false,
                allowSpawn: false,
            }).catch(() => { });
        }, 4800);
        if (typeof kaTimer.unref === 'function') {
            kaTimer.unref();
        }
        inProcessKeepAliveTimers.set(agentKey, kaTimer);
    }
    const hideTimer = setTimeout(() => {
        void hideDesktopActionCursor(sid, options.agentId);
    }, idleMs);
    if (typeof hideTimer.unref === 'function') {
        hideTimer.unref();
    }
    inProcessAutoHideTimers.set(agentKey, hideTimer);
    // 额外启动脱离当前命令生命周期的守护看门狗，确保即使单次工具调用后进程休眠也能在 4.8s 续期并在 10s 后准时隐藏小鼠标
    try {
        const stateDir = getAgentDesktopStateDir();
        const endpoint = computeCursorOverlayEndpoint(stateDir, sid, options.agentId);
        const keepAlivePayload = JSON.stringify(keepAliveControl);
        const hidePayload = JSON.stringify({
            action: 'hide',
            session_id: sid,
            ...(options.agentId ? { agent_id: options.agentId } : {}),
        });
        const disablePayload = JSON.stringify({
            action: 'disable',
            session_id: sid,
            ...(options.agentId ? { agent_id: options.agentId } : {}),
        });
        const watchdogCode = `
      const fs = require('fs');
      const net = require('net');
      function sendPipe(msg) {
        try {
          const s = net.createConnection(${JSON.stringify(endpoint)});
          s.on('error', () => {});
          s.on('connect', () => { s.write(msg, () => { setTimeout(() => s.destroy(), 120); }); });
        } catch {}
      }
      if (${idleMs > 5200 && hasExplicitCoord ? 'true' : 'false'}) {
        setTimeout(() => {
          try {
            const last = Number(fs.readFileSync(${JSON.stringify(tsFile)}, 'utf8').trim() || '0');
            if (Date.now() - last >= 4500 && Date.now() - last < ${idleMs - 300}) {
              sendPipe(${JSON.stringify(keepAlivePayload)});
            }
          } catch {}
        }, 4800);
      }
      setTimeout(() => {
        try {
          const last = Number(fs.readFileSync(${JSON.stringify(tsFile)}, 'utf8').trim() || '0');
          if (Date.now() - last >= ${idleMs - 150}) {
            sendPipe(${JSON.stringify(hidePayload)});
            setTimeout(() => {
              try {
                const last2 = Number(fs.readFileSync(${JSON.stringify(tsFile)}, 'utf8').trim() || '0');
                if (Date.now() - last2 >= ${idleMs + 2500}) {
                  sendPipe(${JSON.stringify(disablePayload)});
                }
              } catch {}
            }, 2800);
          }
        } catch {}
      }, ${idleMs + 100});
    `;
        const wd = spawn(process.execPath, ['-e', watchdogCode], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        wd.unref();
    }
    catch { }
}
/**
 * 立即隐藏并关闭桌面迷你小鼠标覆盖层
 */
export async function hideDesktopActionCursor(sessionId, agentId) {
    const agentKey = agentId?.trim() || 'default';
    const kaTimer = inProcessKeepAliveTimers.get(agentKey);
    if (kaTimer) {
        clearTimeout(kaTimer);
        inProcessKeepAliveTimers.delete(agentKey);
    }
    const hideTimer = inProcessAutoHideTimers.get(agentKey);
    if (hideTimer) {
        clearTimeout(hideTimer);
        inProcessAutoHideTimers.delete(agentKey);
    }
    if (process.platform === 'linux') {
        await sendUdpToX11Daemon({ action: 'hide' }, computeX11OverlayUdpPort(agentId));
        return;
    }
    const sid = sessionId || activeSessions.get('default')?.sessionId;
    if (sid) {
        syncSessionCursorOverlayManifest(sid, { enabled: false, agentId });
        await sendNativeCursorOverlayControl(sid, { action: 'hide', session_id: sid, ...(agentId ? { agent_id: agentId } : {}) }, { agentId, expectAck: false, allowSpawn: false }).catch(() => { });
        await sendNativeCursorOverlayControl(sid, { action: 'disable', session_id: sid, ...(agentId ? { agent_id: agentId } : {}) }, { agentId, expectAck: false, allowSpawn: false }).catch(() => { });
    }
}
let cachedBinaryPath;
let binaryDownloadPromise;
/**
 * 确保本机已安装并校验 `agent-desktop v1.2.0` 原生二进制（优先走 GitHub Release镜像，GitHub Release 兜底）
 */
export async function ensureAgentDesktopBinary() {
    const envOverride = process.env.AGENT_DESKTOP_BINARY?.trim();
    if (envOverride && existsSync(envOverride)) {
        return envOverride;
    }
    if (cachedBinaryPath && existsSync(cachedBinaryPath)) {
        return cachedBinaryPath;
    }
    const target = resolveAgentDesktopTarget();
    if (!target) {
        throw new Error(`当前平台 (${process.platform}/${process.arch}) 暂不支持 agent-desktop 预编译二进制`);
    }
    const binDir = join(getAgentDesktopRootDir(), 'bin', `v${AGENT_DESKTOP_VERSION}-${target.key}`);
    const mainBinPath = join(binDir, target.mainBinary);
    const markerPath = join(binDir, 'verified.json');
    try {
        if (existsSync(mainBinPath) && existsSync(markerPath)) {
            const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
            const allEntriesExist = target.entries.every(entry => existsSync(join(binDir, entry)));
            if (marker.sha256 === target.sha256 && marker.version === AGENT_DESKTOP_VERSION && allEntriesExist) {
                cachedBinaryPath = mainBinPath;
                return mainBinPath;
            }
        }
    }
    catch { }
    if (binaryDownloadPromise) {
        return binaryDownloadPromise;
    }
    binaryDownloadPromise = (async () => {
        try {
            mkdirSync(binDir, { recursive: true });
            let tgzBuffer;
            // 1. Optional custom mirror via GHOSTPAW_RELEASE_MIRROR_URL
            const mirrorBase = process.env.GHOSTPAW_RELEASE_MIRROR_URL?.trim();
            if (mirrorBase) {
                try {
                    const mirrorUrl = `${mirrorBase.replace(/\/+$/, '')}/${target.tarballName}`;
                    const mirrorRes = await fetch(mirrorUrl);
                    if (mirrorRes.ok) {
                        const arr = await mirrorRes.arrayBuffer();
                        const buf = Buffer.from(arr);
                        const hash = createHash('sha256').update(buf).digest('hex');
                        if (hash === target.sha256) {
                            tgzBuffer = buf;
                        }
                    }
                }
                catch { }
            }
            // 2. 若知识中枢未命中，自动回退至 GitHub 官方 Release
            if (!tgzBuffer) {
                const ghUrl = `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/${target.tarballName}`;
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 45000);
                try {
                    const ghRes = await fetch(ghUrl, { signal: ctrl.signal });
                    if (!ghRes.ok) {
                        throw new Error(`HTTP ${ghRes.status} from ${ghUrl}`);
                    }
                    const arr = await ghRes.arrayBuffer();
                    const buf = Buffer.from(arr);
                    const hash = createHash('sha256').update(buf).digest('hex');
                    if (hash !== target.sha256) {
                        throw new Error(`SHA-256 校验失败: 期望 ${target.sha256}，实际 ${hash}`);
                    }
                    tgzBuffer = buf;
                }
                finally {
                    clearTimeout(timer);
                }
            }
            // 3. 纯 Node 内存解压并赋予可执行权限
            const extracted = extractTarGzBuffer(tgzBuffer);
            for (const entryName of target.entries) {
                const entryObj = extracted.get(entryName);
                if (!entryObj) {
                    throw new Error(`发行包中缺少核心组件: ${entryName}`);
                }
                const destPath = join(binDir, entryName);
                writeFileSync(destPath, entryObj.data);
                if (process.platform !== 'win32') {
                    try {
                        chmodSync(destPath, 0o755);
                    }
                    catch { }
                }
            }
            writeFileSync(markerPath, `${JSON.stringify({ version: AGENT_DESKTOP_VERSION, sha256: target.sha256, installedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
            cachedBinaryPath = mainBinPath;
            return mainBinPath;
        }
        finally {
            binaryDownloadPromise = undefined;
        }
    })();
    return binaryDownloadPromise;
}
/**
 * 调用 `agent-desktop` CLI 并解析其标准 JSON Envelope 输出
 */
export async function runAgentDesktopCli(args, options = {}) {
    const binPath = await ensureAgentDesktopBinary();
    const stateDir = getAgentDesktopStateDir();
    const timeoutMs = options.timeoutMs ?? 35000;
    const res = await new Promise((resolvePromise, rejectPromise) => {
        const env = {
            ...process.env,
            AGENT_DESKTOP_HOME: stateDir,
        };
        if (options.sessionId) {
            env.AGENT_DESKTOP_SESSION = options.sessionId;
        }
        if (options.agentId) {
            env.AGENT_DESKTOP_AGENT_ID = options.agentId;
        }
        const child = spawn(binPath, [...args], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try {
                    child.kill('SIGKILL');
                }
                catch { }
                rejectPromise(new Error(`agent-desktop 执行超时 (${timeoutMs}ms): ${args.join(' ')}`));
            }
        }, timeoutMs);
        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
        child.on('error', err => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(err);
        });
        child.on('close', exitCode => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
            const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
            let envelope;
            if (stdout.startsWith('{')) {
                try {
                    envelope = JSON.parse(stdout);
                }
                catch { }
            }
            resolvePromise({
                exitCode,
                stdout,
                stderr,
                envelope,
            });
        });
        if (options.stdinText !== undefined) {
            child.stdin.write(options.stdinText, 'utf8');
        }
        child.stdin.end();
    });
    const retryAttempt = options._aclRetryAttempt ?? 0;
    if (process.platform === 'win32' &&
        retryAttempt < 2 &&
        res.envelope?.ok === false &&
        /foreign principal|untrusted principal/i.test(`${res.envelope?.error?.message ?? ''} ${res.stderr} ${res.stdout}`)) {
        if (retryAttempt === 0) {
            repairWindowsPrivateDirAclAndOwner(getAgentDesktopRootDir());
            repairWindowsPrivateDirAclAndOwner(stateDir);
        }
        else {
            const safeUser = (process.env.USERNAME?.trim() || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');
            fallbackWinStateSubdir = `state-${safeUser}-uac`;
            hardenedWinDirs.clear();
        }
        return runAgentDesktopCli(args, { ...options, _aclRetryAttempt: retryAttempt + 1 });
    }
    return res;
}
const activeSessions = new Map();
const activeSessionInFlight = new Map();
/**
 * 从 `<stateDir>/sessions/<sessionId>/snapshots/<snapshotId>/refmap.json` 加载原生快照元数据：
 * - 包含每个 `@ref` 的精确 `bounds`、`source_window_id`、`source_app` 以及 UIA `native_id.value` (`automationId`)；
 * - 即使 `@ref` 来自 `find`（默认 CLI JSON 不含 `bounds`）或跨轮次调用，也能毫秒级还原完整坐标与 AutomationId！
 */
export function loadSnapshotRefMapFromDisk(sessionId, snapshotId, refMetaMap, snapshotOwnerMap) {
    if (!sessionId || !snapshotId)
        return;
    const cleanSnapId = snapshotId.replace(/^@/, '').trim();
    if (!cleanSnapId)
        return;
    try {
        const refmapPath = join(getAgentDesktopStateDir(), 'sessions', sessionId, 'snapshots', cleanSnapId, 'refmap.json');
        if (!existsSync(refmapPath))
            return;
        const raw = JSON.parse(readFileSync(refmapPath, 'utf8'));
        const entriesMap = raw.inner && typeof raw.inner === 'object' ? raw.inner : raw.entries;
        if (!entriesMap || typeof entriesMap !== 'object')
            return;
        let inferredWinId = raw.window_id;
        let inferredApp = raw.app;
        for (const [key, entry] of Object.entries(entriesMap)) {
            if (!entry || typeof entry !== 'object')
                continue;
            if (!inferredWinId && entry.source_window_id)
                inferredWinId = entry.source_window_id;
            if (!inferredApp && entry.source_app)
                inferredApp = entry.source_app;
            const fullRef = qualifyAgentDesktopRef(entry.ref_id || key, cleanSnapId);
            const bareRef = fullRef.replace(/^@[a-z0-9_-]+:/i, '').replace(/^@/, '');
            const prev = refMetaMap.get(fullRef);
            const b = entry.bounds;
            const hasBounds = b &&
                typeof b.x === 'number' &&
                typeof b.y === 'number' &&
                typeof b.width === 'number' &&
                typeof b.height === 'number';
            const normalizedBounds = hasBounds
                ? {
                    x: Math.round(b.x),
                    y: Math.round(b.y),
                    width: Math.round(b.width),
                    height: Math.round(b.height),
                }
                : prev?.bounds;
            const centerX = normalizedBounds ? Math.round(normalizedBounds.x + normalizedBounds.width / 2) : prev?.centerX;
            const centerY = normalizedBounds ? Math.round(normalizedBounds.y + normalizedBounds.height / 2) : prev?.centerY;
            const automationId = typeof entry.native_id?.value === 'string' && entry.native_id.value.trim()
                ? entry.native_id.value.trim()
                : prev?.automationId;
            const meta = {
                ref: fullRef,
                role: entry.role || prev?.role || 'element',
                name: entry.name || entry.value || prev?.name || bareRef,
                automationId,
                windowId: entry.source_window_id || inferredWinId || prev?.windowId,
                app: entry.source_app || inferredApp || prev?.app,
                centerX,
                centerY,
                bounds: normalizedBounds,
            };
            refMetaMap.set(fullRef, meta);
            refMetaMap.set(bareRef, meta);
            refMetaMap.set(`@${bareRef}`, meta);
            if (meta.windowId) {
                refMetaMap.set(`${meta.windowId}:${bareRef}`, meta);
                refMetaMap.set(`${meta.windowId}:@${bareRef}`, meta);
            }
        }
        if (snapshotOwnerMap && (inferredWinId || inferredApp)) {
            const prevOwner = snapshotOwnerMap.get(cleanSnapId);
            snapshotOwnerMap.set(cleanSnapId, {
                windowId: inferredWinId || prevOwner?.windowId,
                app: inferredApp || prevOwner?.app,
            });
        }
    }
    catch { }
}
/**
 * 在当前缓存的无障碍快照中查找包含坐标 `(x, y)`（或中心点距离最近）的最佳 `@ref`
 * 支持按目标 `windowId` / `app` 过滤，确保多智能体并发或窗口重叠时绝不误命中上层遮挡窗口的控件！
 */
export function findBestRefAtPoint(x, y, sessionKey = 'default', filter) {
    const state = activeSessions.get(sessionKey);
    if (!state || state.refMetaMap.size === 0)
        return undefined;
    let bestContaining;
    let bestNearest;
    for (const meta of state.refMetaMap.values()) {
        if (filter?.windowId && meta.windowId && meta.windowId !== filter.windowId) {
            continue;
        }
        if (!filter?.windowId &&
            filter?.app &&
            meta.app &&
            !matchWindowsAppCandidate(filter.app, { id: meta.windowId, app: meta.app, title: meta.app })) {
            continue;
        }
        if (meta.bounds && meta.bounds.width > 0 && meta.bounds.height > 0) {
            const { x: bx, y: by, width: bw, height: bh } = meta.bounds;
            const inside = x >= bx - 4 && x <= bx + bw + 4 && y >= by - 4 && y <= by + bh + 4;
            const cx = meta.centerX ?? bx + bw / 2;
            const cy = meta.centerY ?? by + bh / 2;
            const dist = Math.hypot(x - cx, y - cy);
            const area = bw * bh;
            if (inside) {
                if (!bestContaining ||
                    area < bestContaining.area * 0.85 ||
                    (Math.abs(area - bestContaining.area) <= bestContaining.area * 0.15 && dist < bestContaining.dist)) {
                    bestContaining = { meta, area, dist };
                }
            }
            else if (dist <= 28) {
                if (!bestNearest || dist < bestNearest.dist) {
                    bestNearest = { meta, dist };
                }
            }
        }
        else if (typeof meta.centerX === 'number' && typeof meta.centerY === 'number') {
            const dist = Math.hypot(x - meta.centerX, y - meta.centerY);
            if (dist <= 26 && (!bestNearest || dist < bestNearest.dist)) {
                bestNearest = { meta, dist };
            }
        }
    }
    return bestContaining?.meta ?? bestNearest?.meta;
}
const WINDOWS_APP_ALIAS_GROUPS = [
    ['calc', 'calculator', 'calculatorapp', '计算器'],
    ['notepad', '记事本'],
    ['mspaint', 'paint', '画图'],
    ['explorer', '文件资源管理器', '资源管理器'],
    ['cmd', 'command prompt', '命令提示符'],
    ['powershell', 'pwsh', 'windows powershell'],
    ['wps', 'wps office', 'et', 'wpp', 'ksolaunch', '文字', '表格', '演示'],
    ['weixin', 'wechat', '微信'],
    ['wxwork', 'wecom', '企业微信'],
    ['dingtalk', '钉钉'],
    ['feishu', 'lark', '飞书'],
    ['chrome', 'google chrome'],
    ['msedge', 'edge', 'microsoft edge', 'browser', '浏览器'],
    ['code', 'vscode', 'visual studio code'],
];
export function normalizeAppQueryTokens(rawApp) {
    const base = String(rawApp ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, '')
        .trim();
    if (!base)
        return [];
    const tokens = new Set([base]);
    for (const group of WINDOWS_APP_ALIAS_GROUPS) {
        if (group.some(alias => base === alias || base.includes(alias) || alias.includes(base))) {
            for (const alias of group) {
                tokens.add(alias);
            }
        }
    }
    return Array.from(tokens);
}
export function matchWindowsAppCandidate(query, candidate) {
    const tokens = normalizeAppQueryTokens(query);
    if (tokens.length === 0)
        return false;
    const appLower = String(candidate.app ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.exe$/i, '');
    const titleLower = String(candidate.title ?? '').trim().toLowerCase();
    if (!tokens.some(t => t.includes('deepseek')) &&
        (titleLower.includes('deepseek harness') || appLower.includes('deepseek'))) {
        return false;
    }
    return tokens.some(tok => (appLower && (appLower === tok || appLower.includes(tok) || tok.includes(appLower))) ||
        (titleLower && titleLower.includes(tok)));
}
export function parseWindowHandleFromId(windowId) {
    if (!windowId)
        return undefined;
    const m = /^w[-_](\d+)$/i.exec(windowId.trim());
    if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return undefined;
}
const WIN32_BG_SCRIPT_VERSION = 'v4.5';
/**
 * Windows 100% 后台遮挡穿透引擎 (`GhostPawWin32BgV4`)：
 * - **彻底零焦点争抢、零 Z 序变动**：
 *   1) 对 Windows 11 UWP 计算器 (`CalculatorApp.exe` / `Windows.UI.Core.CoreWindow`)，直接将按钮点击映射为向 `CoreWindow` 子句柄投递 `PostMessageW(coreHwnd, WM_KEYDOWN, vk, 1)`，彻底绕过 UWP XAML `InvokePattern.Invoke()` 内部强制激活窗口的底层缺陷，实现 0ms 零焦点闪烁后台计算；
 *   2) 对其他 UIA 模式调用（`Invoke()` / `Select()` / `Toggle()` / `Expand()` / `SetValue()`），在调用前后锁定 `GetForegroundWindow()` 与 `GW_HWNDPREV` Z 序，微秒级原位恢复窗口层级与用户前台焦点；
 *   3) 对 `launch_background` 新启动的 UWP/WinUI 窗口，高频轮询并在窗口句柄出现瞬间将其置于原前台窗口下层 (`SetWindowPos(..., SWP_NOACTIVATE)`) 且锁死原前台焦点；
 *   4) 对 Windows 11 记事本 (`RichEditD2DPT`) 等编辑控件，优先使用 `EM_SETSEL` + `EM_REPLACESEL` 无焦点后台写入。
 */
let win32BgScriptEnsuredVersion = '';
function prepareWindowsBgInvocation(options) {
    const normalizedOptions = {
        ...options,
        hasExplicitCoord: options.hasExplicitCoord ??
            (typeof options.x === 'number' &&
                Number.isFinite(options.x) &&
                typeof options.y === 'number' &&
                Number.isFinite(options.y)),
    };
    const payloadB64 = Buffer.from(JSON.stringify(normalizedOptions), 'utf8').toString('base64');
    const rootDir = getAgentDesktopRootDir();
    const scriptPath = join(rootDir, `win32-bg-${WIN32_BG_SCRIPT_VERSION}.ps1`);
    const dllPath = join(rootDir, `GhostPawWin32Bg_${WIN32_BG_SCRIPT_VERSION.replace(/[^a-zA-Z0-9]/g, '_')}.dll`);
    const psScript = `\uFEFF# ${WIN32_BG_SCRIPT_VERSION}
param(
  [string]$PayloadB64 = "",
  [string]$DllCachePath = ""
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$reqJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadB64))
$req = $reqJson | ConvertFrom-Json

$csCode = @"
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class GhostPawWin32BgV4 {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hwndParent, POINT pt, uint uFlags);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr ShellExecuteW(IntPtr hwnd, string lpOperation, string lpFile, string lpParameters, string lpDirectory, int nShowCmd);

    public static bool IsCloaked(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;
        int cloaked = 0;
        DwmGetWindowAttribute(hWnd, 14, out cloaked, 4);
        return cloaked != 0;
    }

    public static void ForceForeground(IntPtr wantFg) {
        if (wantFg == IntPtr.Zero || !IsWindow(wantFg)) return;
        if (GetForegroundWindow() == wantFg) return;
        uint fgPid = 0;
        uint fgTid = GetWindowThreadProcessId(wantFg, out fgPid);
        uint curTid = GetCurrentThreadId();
        if (fgTid != 0 && fgTid != curTid) {
            AttachThreadInput(curTid, fgTid, true);
            BringWindowToTop(wantFg);
            SetForegroundWindow(wantFg);
            AttachThreadInput(curTid, fgTid, false);
        }
        if (GetForegroundWindow() != wantFg) {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            SetForegroundWindow(wantFg);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
        }
    }

    public static string GetTitle(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(hWnd, sb, 512);
        return sb.ToString();
    }

    public static string GetClass(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hWnd, sb, 256);
        return sb.ToString();
    }

    public static string GetProcName(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return "";
        try {
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return "";
            string pName = Process.GetProcessById((int)pid).ProcessName ?? "";
            if (string.Equals(pName, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {
                IntPtr coreChild = FindCoreWindowChild(hWnd);
                if (coreChild != IntPtr.Zero) {
                    uint cpid = 0;
                    GetWindowThreadProcessId(coreChild, out cpid);
                    if (cpid != 0 && cpid != pid) {
                        return Process.GetProcessById((int)cpid).ProcessName ?? pName;
                    }
                }
            }
            return pName;
        } catch {
            return "";
        }
    }

    public static IntPtr FindCoreWindowChild(IntPtr root) {
        if (root == IntPtr.Zero) return IntPtr.Zero;
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(root, (child, lParam) => {
            string cls = GetClass(child);
            if (cls.IndexOf("Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase) >= 0) {
                found = child;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static IntPtr GetTopNormalWindow(IntPtr excludeHwnd) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            if (h == excludeHwnd || !IsWindowVisible(h) || IsIconic(h)) return true;
            int cloaked = 0;
            DwmGetWindowAttribute(h, 14, out cloaked, 4);
            if (cloaked != 0) return true;
            string cls = GetClass(h);
            if (string.Equals(cls, "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(cls, "SecondaryTrayWnd", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(cls, "Progman", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(cls, "WorkerW", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(cls, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)) {
                return true;
            }
            string t = GetTitle(h);
            if (string.IsNullOrWhiteSpace(t) || IsOverlayTitle(t)) return true;
            int exStyle = GetWindowLongW(h, -20);
            if ((exStyle & 0x00000008) != 0 || (exStyle & 0x00000080) != 0) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static void RestoreForegroundAndZOrder(IntPtr targetRoot, IntPtr prevFg, IntPtr prevAbove) {
        RestoreForegroundAndZOrder(targetRoot, prevFg, prevAbove, GetTopNormalWindow(targetRoot));
    }

    public static void RestoreForegroundAndZOrder(IntPtr targetRoot, IntPtr prevFg, IntPtr prevAbove, IntPtr topNormalBefore) {
        if (targetRoot == IntPtr.Zero) return;
        IntPtr curFg = GetForegroundWindow();
        IntPtr curAbove = GetWindow(targetRoot, 3); // GW_HWNDPREV = 3
        bool fgUnchanged = (prevFg == IntPtr.Zero || prevFg == targetRoot || curFg == prevFg);
        bool zOrderUnchanged = (prevAbove == IntPtr.Zero || prevAbove == targetRoot || curAbove == prevAbove);
        if (fgUnchanged && zOrderUnchanged && curFg != targetRoot) {
            return;
        }
        IntPtr validTopNormal = (topNormalBefore != IntPtr.Zero && topNormalBefore != targetRoot && IsWindow(topNormalBefore))
            ? topNormalBefore
            : GetTopNormalWindow(targetRoot);
        IntPtr validPrevFg = (prevFg != IntPtr.Zero && prevFg != targetRoot && IsWindow(prevFg) &&
                              !string.Equals(GetClass(prevFg), "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase))
            ? prevFg
            : validTopNormal;
        IntPtr insertAfter = (prevAbove != IntPtr.Zero && prevAbove != targetRoot && IsWindow(prevAbove) &&
                              !string.Equals(GetClass(prevAbove), "Shell_TrayWnd", StringComparison.OrdinalIgnoreCase))
            ? prevAbove
            : (validTopNormal != IntPtr.Zero ? validTopNormal : validPrevFg);
        if (insertAfter != IntPtr.Zero && insertAfter != targetRoot) {
            SetWindowPos(targetRoot, insertAfter, 0, 0, 0, 0, 0x0013); // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
        }
        if (validTopNormal != IntPtr.Zero && validTopNormal != targetRoot) {
            SetWindowPos(validTopNormal, IntPtr.Zero, 0, 0, 0, 0, 0x0013); // HWND_TOP = 0
        }
        IntPtr wantFg = validPrevFg != IntPtr.Zero ? validPrevFg : validTopNormal;
        if (wantFg != IntPtr.Zero && wantFg != targetRoot && GetForegroundWindow() != wantFg) {
            uint fgPid = 0;
            uint fgTid = GetWindowThreadProcessId(wantFg, out fgPid);
            uint curTid = GetCurrentThreadId();
            if (fgTid != 0 && fgTid != curTid) {
                AttachThreadInput(curTid, fgTid, true);
                BringWindowToTop(wantFg);
                SetForegroundWindow(wantFg);
                AttachThreadInput(curTid, fgTid, false);
            }
            if (GetForegroundWindow() != wantFg) {
                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                SetForegroundWindow(wantFg);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);
            }
            if (insertAfter != IntPtr.Zero && insertAfter != targetRoot) {
                SetWindowPos(targetRoot, insertAfter, 0, 0, 0, 0, 0x0013);
            }
            if (validTopNormal != IntPtr.Zero && validTopNormal != targetRoot) {
                SetWindowPos(validTopNormal, IntPtr.Zero, 0, 0, 0, 0, 0x0013);
            }
        }
    }

    public static int[] TryGetCalcKeySequence(string autoId, string elName) {
        string id = (autoId ?? "").Trim();
        if (!string.IsNullOrEmpty(id)) {
            switch (id) {
                case "num0Button": return new int[] { 0x30 };
                case "num1Button": return new int[] { 0x31 };
                case "num2Button": return new int[] { 0x32 };
                case "num3Button": return new int[] { 0x33 };
                case "num4Button": return new int[] { 0x34 };
                case "num5Button": return new int[] { 0x35 };
                case "num6Button": return new int[] { 0x36 };
                case "num7Button": return new int[] { 0x37 };
                case "num8Button": return new int[] { 0x38 };
                case "num9Button": return new int[] { 0x39 };
                case "aButton": return new int[] { 0x41 };
                case "bButton": return new int[] { 0x42 };
                case "cButton": return new int[] { 0x43 };
                case "dButton": return new int[] { 0x44 };
                case "eButton": return new int[] { 0x45 };
                case "fButton": return new int[] { 0x46 };
                case "hexButton": return new int[] { 0x74 };
                case "decButton": return new int[] { 0x75 };
                case "octButton": return new int[] { 0x76 };
                case "binButton": return new int[] { 0x77 };
                case "plusButton": return new int[] { 0x6B };
                case "minusButton": return new int[] { 0x6D };
                case "multiplyButton": return new int[] { 0x6A };
                case "divideButton": return new int[] { 0x6F };
                case "equalButton": return new int[] { 0xBB };
                case "decimalSeparatorButton": return new int[] { 0x6E };
                case "backSpaceButton": return new int[] { 0x08 };
                case "negateButton": return new int[] { 0x78 };
                case "clearButton":
                case "clearEntryButton":
                    return new int[] { 0xBB, 0x30, 0x6A, 0x30, 0xBB };
            }
        }
        string n = (elName ?? "").Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(n)) return null;
        switch (n) {
            case "0": case "\\u96f6": return new int[] { 0x30 };
            case "1": case "\\u4e00": return new int[] { 0x31 };
            case "2": case "\\u4e8c": return new int[] { 0x32 };
            case "3": case "\\u4e09": return new int[] { 0x33 };
            case "4": case "\\u56db": return new int[] { 0x34 };
            case "5": case "\\u4e94": return new int[] { 0x35 };
            case "6": case "\\u516d": return new int[] { 0x36 };
            case "7": case "\\u4e03": return new int[] { 0x37 };
            case "8": case "\\u516b": return new int[] { 0x38 };
            case "9": case "\\u4e5d": return new int[] { 0x39 };
            case "a": return new int[] { 0x41 };
            case "b": return new int[] { 0x42 };
            case "c": return new int[] { 0x43 };
            case "d": return new int[] { 0x44 };
            case "e": return new int[] { 0x45 };
            case "f": return new int[] { 0x46 };
            case "+": case "\\u52a0": case "plus": return new int[] { 0x6B };
            case "-": case "\\u51cf": case "minus": return new int[] { 0x6D };
            case "*": case "\\u00d7": case "\\u4e58\\u4ee5": case "\\u4e58": case "multiply by": return new int[] { 0x6A };
            case "/": case "\\u00f7": case "\\u9664\\u4ee5": case "\\u9664": case "divide by": return new int[] { 0x6F };
            case "=": case "\\u7b49\\u4e8e": case "equals": case "enter": case "return": return new int[] { 0xBB };
            case ".": case "\\u5c0f\\u6570\\u5206\\u9694\\u7b26": case "decimal separator": return new int[] { 0x6E };
            case "backspace": case "\\u9000\\u683c": return new int[] { 0x08 };
            case "\\u6b63\\u8d1f\\u53f7": case "positive negative": return new int[] { 0x78 };
            case "clear": case "clear entry": case "ce": case "escape": case "esc":
            case "\\u6e05\\u9664": case "\\u6e05\\u9664\\u6761\\u76ee":
                return new int[] { 0xBB, 0x30, 0x6A, 0x30, 0xBB };
        }
        return null;
    }

    public static bool SendCalcKeysToCoreWindow(IntPtr coreHwnd, int[] vks) {
        if (coreHwnd == IntPtr.Zero || vks == null || vks.Length == 0) return false;
        for (int i = 0; i < vks.Length; i++) {
            PostMessageW(coreHwnd, 0x0100, new IntPtr(vks[i]), new IntPtr(1));
            if (vks.Length > 1 && i + 1 < vks.Length) {
                Thread.Sleep(14);
            }
        }
        return true;
    }

    public static bool IsOverlayTitle(string t) {
        if (string.IsNullOrWhiteSpace(t)) return false;
        return t.IndexOf("cursor-overlay", StringComparison.OrdinalIgnoreCase) >= 0 ||
               t.IndexOf("agent-desktop", StringComparison.OrdinalIgnoreCase) >= 0 ||
               t.IndexOf("ghostpaw-cursor", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    public static string[] ExpandAppAliases(string appHint) {
        if (string.IsNullOrWhiteSpace(appHint)) return new string[0];
        string h = appHint.Trim().ToLowerInvariant();
        if (h.EndsWith(".exe")) h = h.Substring(0, h.Length - 4).Trim();
        if (h == "calc" || h == "calculator" || h == "calculatorapp" || h.Contains("\\u8ba1\\u7b97\\u5668")) {
            return new string[] { h, "calc", "calculator", "calculatorapp", "\\u8ba1\\u7b97\\u5668" };
        }
        if (h == "notepad" || h.Contains("\\u8bb0\\u4e8b\\u672c")) {
            return new string[] { h, "notepad", "\\u8bb0\\u4e8b\\u672c" };
        }
        if (h == "mspaint" || h == "paint" || h.Contains("\\u753b\\u56fe")) {
            return new string[] { h, "mspaint", "paint", "\\u753b\\u56fe" };
        }
        if (h == "explorer" || h.Contains("\\u8d44\\u6e90\\u7ba1\\u7406\\u5668")) {
            return new string[] { h, "explorer", "\\u6587\\u4ef6\\u8d44\\u6e90\\u7ba1\\u7406\\u5668", "\\u8d44\\u6e90\\u7ba1\\u7406\\u5668" };
        }
        if (h == "wps" || h == "et" || h == "wpp" || h.Contains("wps")) {
            return new string[] { h, "wps", "et", "wpp", "\\u6587\\u5b57", "\\u8868\\u683c", "\\u6f14\\u793a" };
        }
        if (h == "weixin" || h == "wechat" || h.Contains("\\u5fae\\u4fe1")) {
            return new string[] { h, "weixin", "wechat", "\\u5fae\\u4fe1" };
        }
        if (h == "msedge" || h == "edge" || h == "microsoft edge" || h == "browser" || h.Contains("\\u6d4f\\u89c8\\u5668")) {
            return new string[] { "msedge", "microsoft edge", "edge" };
        }
        if (h == "chrome" || h == "google chrome") {
            return new string[] { "chrome", "google chrome" };
        }
        return new string[] { h };
    }

    public static bool MatchesAppHint(IntPtr hWnd, string title, string[] aliases) {
        if (aliases == null || aliases.Length == 0) return false;
        string proc = GetProcName(hWnd);
        bool wantsDeepseek = false;
        foreach (string a in aliases) {
            if (!string.IsNullOrEmpty(a) && a.IndexOf("deepseek", StringComparison.OrdinalIgnoreCase) >= 0) {
                wantsDeepseek = true;
                break;
            }
        }
        if (!wantsDeepseek && !string.IsNullOrEmpty(title) && title.IndexOf("DeepSeek Harness", StringComparison.OrdinalIgnoreCase) >= 0) {
            return false;
        }
        foreach (string a in aliases) {
            if (string.IsNullOrWhiteSpace(a)) continue;
            if (!string.IsNullOrEmpty(title) && title.IndexOf(a, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (!string.IsNullOrEmpty(proc) && proc.IndexOf(a, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }

    public static IntPtr FindRootWindow(int x, int y, bool hasCoord, string appHint, long explicitHwnd) {
        IntPtr prevFg = GetForegroundWindow();
        if (explicitHwnd > 0) {
            IntPtr h = new IntPtr(explicitHwnd);
            if (IsWindow(h)) {
                if (IsIconic(h)) {
                    ShowWindowAsync(h, 4); // SW_SHOWNOACTIVATE = 4
                    RestoreForegroundAndZOrder(h, prevFg, prevFg);
                }
                return h;
            }
        }
        string[] aliases = ExpandAppAliases(appHint);
        IntPtr matchedByAppWithPoint = IntPtr.Zero;
        IntPtr matchedByApp = IntPtr.Zero;
        IntPtr matchedByPoint = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd) || IsCloaked(hWnd)) return true;
            string title = GetTitle(hWnd);
            if (string.IsNullOrWhiteSpace(title) || IsOverlayTitle(title) || title == "Program Manager") return true;
            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w < 60 && h < 40 && !IsIconic(hWnd)) return true;
            bool hasPoint = hasCoord && (x >= r.Left && x <= r.Right && y >= r.Top && y <= r.Bottom);
            if (aliases.Length > 0 && MatchesAppHint(hWnd, title, aliases)) {
                if (hasPoint) {
                    matchedByAppWithPoint = hWnd;
                    return false;
                }
                if (matchedByApp == IntPtr.Zero) {
                    matchedByApp = hWnd;
                }
            }
            if (matchedByPoint == IntPtr.Zero && hasPoint) {
                matchedByPoint = hWnd;
            }
            return true;
        }, IntPtr.Zero);

        IntPtr root = matchedByAppWithPoint != IntPtr.Zero
            ? matchedByAppWithPoint
            : (matchedByApp != IntPtr.Zero ? matchedByApp : matchedByPoint);
        if (root == IntPtr.Zero && aliases.Length == 0 && hasCoord) {
            POINT pt = new POINT { X = x, Y = y };
            IntPtr wp = WindowFromPoint(pt);
            if (wp != IntPtr.Zero) {
                IntPtr anc = GetAncestor(wp, 2);
                root = anc != IntPtr.Zero ? anc : wp;
            }
        }
        if (root != IntPtr.Zero && IsIconic(root)) {
            ShowWindowAsync(root, 4); // SW_SHOWNOACTIVATE = 4
            RestoreForegroundAndZOrder(root, prevFg, prevFg);
        }
        return root;
    }

    public static bool IsEditClass(string cls) {
        if (string.IsNullOrEmpty(cls)) return false;
        return cls.IndexOf("RichEdit", StringComparison.OrdinalIgnoreCase) >= 0 ||
               string.Equals(cls, "Edit", StringComparison.OrdinalIgnoreCase) ||
               cls.IndexOf("Scintilla", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    public static IntPtr ResolveDeepestChild(IntPtr root, int screenX, int screenY, bool hasCoord) {
        if (root == IntPtr.Zero) return IntPtr.Zero;
        IntPtr bestChild = IntPtr.Zero;
        long bestScore = long.MinValue;

        EnumChildWindows(root, (child, lParam) => {
            if (!IsWindowVisible(child)) return true;
            RECT r;
            if (!GetWindowRect(child, out r)) return true;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w <= 0 || h <= 0) return true;
            string cls = GetClass(child);
            bool containsPt = hasCoord && (screenX >= r.Left - 2 && screenX <= r.Right + 2 && screenY >= r.Top - 2 && screenY <= r.Bottom + 2);
            bool isBridge = cls.IndexOf("DesktopChildSiteBridge", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            cls.IndexOf("InputSiteWindowClass", StringComparison.OrdinalIgnoreCase) >= 0;
            bool isEdit = IsEditClass(cls);
            bool isInteractiveLeaf = isEdit ||
                                     cls.IndexOf("CoreWindow", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                     cls.IndexOf("RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                     cls.IndexOf("DirectUIHWND", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                     string.Equals(cls, "Button", StringComparison.OrdinalIgnoreCase);

            if (containsPt) {
                long area = (long)w * (long)h;
                long score = 1000000L - Math.Min(900000L, area / 4);
                if (isEdit) score += 700000L;
                else if (isInteractiveLeaf) score += 450000L;
                if (isBridge) score -= 650000L;
                if (score >= bestScore) {
                    bestScore = score;
                    bestChild = child;
                }
            } else if (!hasCoord && isEdit) {
                long score = 500000L;
                if (score >= bestScore) {
                    bestScore = score;
                    bestChild = child;
                }
            } else if (isEdit && bestChild == IntPtr.Zero) {
                bestScore = 100000L;
                bestChild = child;
            }
            return true;
        }, IntPtr.Zero);

        if (bestChild != IntPtr.Zero) return bestChild;

        if (hasCoord) {
            IntPtr cur = root;
            for (int depth = 0; depth < 16; depth++) {
                POINT cpt = new POINT { X = screenX, Y = screenY };
                ScreenToClient(cur, ref cpt);
                IntPtr child = ChildWindowFromPointEx(cur, cpt, 0x0003);
                if (child == IntPtr.Zero || child == cur) break;
                cur = child;
            }
            return cur;
        }
        return root;
    }

    public static bool ReplaceEditText(IntPtr editHwnd, string text, bool clearAll) {
        if (editHwnd == IntPtr.Zero || !IsWindow(editHwnd)) return false;
        IntPtr res;
        if (clearAll) {
            SendMessageTimeoutW(editHwnd, 0x00B1, IntPtr.Zero, new IntPtr(-1), 0x0002, 1500, out res);
        } else {
            SendMessageTimeoutW(editHwnd, 0x00B1, new IntPtr(-1), new IntPtr(-1), 0x0002, 1500, out res);
        }
        IntPtr ptr = Marshal.StringToHGlobalUni(text ?? "");
        try {
            IntPtr ok = SendMessageTimeoutW(editHwnd, 0x00C2, new IntPtr(1), ptr, 0x0002, 2000, out res);
            return ok != IntPtr.Zero;
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
    }

    public static IntPtr PackLParam(int cx, int cy) {
        int packed = ((cy & 0xFFFF) << 16) | (cx & 0xFFFF);
        return new IntPtr(packed);
    }
}
"@

if (-not ('GhostPawWin32BgV4' -as [type])) {
  $loadedFromDll = $false
  if (-not [string]::IsNullOrWhiteSpace($DllCachePath) -and (Test-Path -LiteralPath $DllCachePath)) {
    try {
      [void][System.Reflection.Assembly]::LoadFrom($DllCachePath)
      if ('GhostPawWin32BgV4' -as [type]) { $loadedFromDll = $true }
    } catch {}
  }
  if (-not $loadedFromDll) {
    if (-not [string]::IsNullOrWhiteSpace($DllCachePath)) {
      $tmpDll = "$DllCachePath.$PID.tmp.dll"
      try {
        Add-Type -TypeDefinition $csCode -OutputAssembly $tmpDll -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $DllCachePath)) {
          Move-Item -LiteralPath $tmpDll -Destination $DllCachePath -Force -ErrorAction SilentlyContinue
        }
        $loadTarget = if (Test-Path -LiteralPath $DllCachePath) { $DllCachePath } else { $tmpDll }
        [void][System.Reflection.Assembly]::LoadFrom($loadTarget)
      } catch {
        if (Test-Path -LiteralPath $DllCachePath) {
          try { [void][System.Reflection.Assembly]::LoadFrom($DllCachePath) } catch { Add-Type -TypeDefinition $csCode }
        } else {
          Add-Type -TypeDefinition $csCode
        }
      } finally {
        if (Test-Path -LiteralPath $tmpDll) {
          Remove-Item -LiteralPath $tmpDll -Force -ErrorAction SilentlyContinue
        }
      }
    } else {
      Add-Type -TypeDefinition $csCode
    }
  }
}

$hasCoord = ($req.hasExplicitCoord -eq $true)
$x = if ($null -ne $req.x) { [int]$req.x } else { 500 }
$y = if ($null -ne $req.y) { [int]$req.y } else { 400 }
$appHint = if ($null -ne $req.app) { [string]$req.app } else { "" }
$explicitHwnd = if ($null -ne $req.windowHandle) { [long]$req.windowHandle } else { 0 }
$reqName = if ($null -ne $req.elementName) { ([string]$req.elementName).Trim() } else { "" }
$reqRole = if ($null -ne $req.elementRole) { ([string]$req.elementRole).Trim().ToLower() } else { "" }
$reqAutoId = if ($null -ne $req.automationId) { ([string]$req.automationId).Trim() } else { "" }

if ($req.action -eq 'launch_background') {
  $prevFg = [GhostPawWin32BgV4]::GetForegroundWindow()
  $topNormalBefore = [GhostPawWin32BgV4]::GetTopNormalWindow([IntPtr]::Zero)
  $shieldHwnd = if ($prevFg -ne [IntPtr]::Zero -and [GhostPawWin32BgV4]::IsWindowVisible($prevFg) -and -not [GhostPawWin32BgV4]::IsIconic($prevFg) -and [GhostPawWin32BgV4]::GetClass($prevFg) -ne 'Shell_TrayWnd') {
    $prevFg
  } else {
    $topNormalBefore
  }
  $shieldWasTopmost = ($shieldHwnd -ne [IntPtr]::Zero) -and (([GhostPawWin32BgV4]::GetWindowLongW($shieldHwnd, -20) -band 0x00000008) -ne 0)

  $existingHwnd = [GhostPawWin32BgV4]::FindRootWindow($x, $y, $hasCoord, $appHint, $explicitHwnd)
  if ($existingHwnd -ne [IntPtr]::Zero) {
    if ([GhostPawWin32BgV4]::IsIconic($existingHwnd)) {
      if ($shieldHwnd -ne [IntPtr]::Zero -and -not $shieldWasTopmost) {
        [void][GhostPawWin32BgV4]::SetWindowPos($shieldHwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
      }
      [void][GhostPawWin32BgV4]::ShowWindowAsync($existingHwnd, 4)
      Start-Sleep -Milliseconds 90
      if ($shieldHwnd -ne [IntPtr]::Zero) {
        if (-not $shieldWasTopmost) {
          [void][GhostPawWin32BgV4]::SetWindowPos($shieldHwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
        }
        [void][GhostPawWin32BgV4]::SetWindowPos($existingHwnd, $shieldHwnd, 0, 0, 0, 0, 0x0013)
        [void][GhostPawWin32BgV4]::SetWindowPos($shieldHwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013)
        [GhostPawWin32BgV4]::ForceForeground($shieldHwnd)
      }
    }
    Write-Output (ConvertTo-Json -Compress @{
      ok = $true
      method = 'win32-attach-existing-background'
      windowTitle = [GhostPawWin32BgV4]::GetTitle($existingHwnd)
      hwnd = $existingHwnd.ToInt64()
    })
    exit 0
  }

  # 1. 在启动新进程前，先将用户当前前台窗口临时提升至 HWND_TOPMOST (-1) 护盾层：
  #    这样无论新打开的软件（Edge / Chrome / 计算器 / 记事本）自身启动代码如何调用 ShowWindow(SW_SHOWNORMAL) 或 SetForegroundWindow，
  #    在 DWM 合成器中都 100% 物理处于用户前台窗口的下层，连 1 毫秒的前台闪烁都不会发生！
  if ($shieldHwnd -ne [IntPtr]::Zero -and -not $shieldWasTopmost) {
    [void][GhostPawWin32BgV4]::SetWindowPos($shieldHwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0013)
  }

  $cleanHint = $appHint.Trim().ToLowerInvariant()
  $exeToStart = if ($cleanHint -in @('edge', 'msedge', 'microsoft edge', 'browser', '浏览器')) {
    'msedge.exe'
  } elseif ($cleanHint -in @('chrome', 'google chrome')) {
    'chrome.exe'
  } else {
    $appHint.Trim()
  }

  # 2. 通过 ShellExecuteW(..., SW_SHOWNOACTIVATE=4) 直接以非激活正常尺寸在下层拉起目标软件
  $seRes = [GhostPawWin32BgV4]::ShellExecuteW([IntPtr]::Zero, "open", $exeToStart, $null, $null, 4)
  if ($seRes.ToInt64() -le 32) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exeToStart
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized
    [void][System.Diagnostics.Process]::Start($psi)
  }

  $launchedHwnd = [IntPtr]::Zero
  for ($tick = 0; $tick -lt 260; $tick++) {
    Start-Sleep -Milliseconds 16
    if ($shieldHwnd -ne [IntPtr]::Zero) {
      [GhostPawWin32BgV4]::ForceForeground($shieldHwnd)
    }
    $launchedHwnd = [GhostPawWin32BgV4]::FindRootWindow($x, $y, $false, $appHint, 0)
    if ($launchedHwnd -ne [IntPtr]::Zero -and $launchedHwnd -ne $shieldHwnd) {
      if ([GhostPawWin32BgV4]::IsIconic($launchedHwnd)) {
        [void][GhostPawWin32BgV4]::ShowWindowAsync($launchedHwnd, 4)
      }
      $isUwpFrame = ([GhostPawWin32BgV4]::GetClass($launchedHwnd) -eq 'ApplicationFrameWindow')
      $readyTicks = 0
      # 3. 持续在 HWND_TOPMOST 护盾下等待新窗口解除 Cloak 并完成 CoreWindow/渲染层挂载，再稳定守护 650ms
      for ($guard = 0; $guard -lt 110; $guard++) {
        Start-Sleep -Milliseconds 18
        if ([GhostPawWin32BgV4]::IsIconic($launchedHwnd)) {
          [void][GhostPawWin32BgV4]::ShowWindowAsync($launchedHwnd, 4)
        }
        if ($shieldHwnd -ne [IntPtr]::Zero) {
          [GhostPawWin32BgV4]::ForceForeground($shieldHwnd)
        }
        $uncloaked = (-not [GhostPawWin32BgV4]::IsCloaked($launchedHwnd))
        $coreReady = (-not $isUwpFrame) -or ([GhostPawWin32BgV4]::FindCoreWindowChild($launchedHwnd) -ne [IntPtr]::Zero)
        if ($uncloaked -and $coreReady -and -not [GhostPawWin32BgV4]::IsIconic($launchedHwnd)) {
          $readyTicks++
          if ($readyTicks -ge 36) { break }
        }
      }
      break
    }
  }

  # 4. 新窗口已在下层完全稳定就绪，将用户前台窗口从 HWND_TOPMOST (-1) 平滑还原为普通顶层 (#1)，并将新窗口固定在其正下方 (#2)
  if ($shieldHwnd -ne [IntPtr]::Zero) {
    if (-not $shieldWasTopmost) {
      [void][GhostPawWin32BgV4]::SetWindowPos($shieldHwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0013)
    }
    if ($launchedHwnd -ne [IntPtr]::Zero -and $launchedHwnd -ne $shieldHwnd) {
      [void][GhostPawWin32BgV4]::SetWindowPos($launchedHwnd, $shieldHwnd, 0, 0, 0, 0, 0x0013)
    }
    [void][GhostPawWin32BgV4]::SetWindowPos($shieldHwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013)
    [GhostPawWin32BgV4]::ForceForeground($shieldHwnd)
  }

  Write-Output (ConvertTo-Json -Compress @{
    ok = ($launchedHwnd -ne [IntPtr]::Zero)
    method = 'win32-launch-background-noactivate'
    windowTitle = [GhostPawWin32BgV4]::GetTitle($launchedHwnd)
    hwnd = $launchedHwnd.ToInt64()
  })
  exit 0
}

$prevFgBeforeAction = [GhostPawWin32BgV4]::GetForegroundWindow()
$rootHwnd = [GhostPawWin32BgV4]::FindRootWindow($x, $y, $hasCoord, $appHint, $explicitHwnd)
$topNormalBeforeAction = [GhostPawWin32BgV4]::GetTopNormalWindow($rootHwnd)
$prevAboveBeforeAction = if ($rootHwnd -ne [IntPtr]::Zero) { [GhostPawWin32BgV4]::GetWindow($rootHwnd, 3) } else { [IntPtr]::Zero }
$winTitle = [GhostPawWin32BgV4]::GetTitle($rootHwnd)
$coreHwnd = [GhostPawWin32BgV4]::FindCoreWindowChild($rootHwnd)
$targetHwnd = [GhostPawWin32BgV4]::ResolveDeepestChild($rootHwnd, $x, $y, $hasCoord)
if ($targetHwnd -eq [IntPtr]::Zero) { $targetHwnd = $rootHwnd }
$targetClass = [GhostPawWin32BgV4]::GetClass($targetHwnd)
$isEditHwnd = [GhostPawWin32BgV4]::IsEditClass($targetClass)

if ($req.action -eq 'restore_no_activate' -or $req.action -eq 'focus_no_activate') {
  if ($rootHwnd -ne [IntPtr]::Zero -and [GhostPawWin32BgV4]::IsIconic($rootHwnd)) {
    [void][GhostPawWin32BgV4]::ShowWindowAsync($rootHwnd, 4)
    [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
  }
  Write-Output (ConvertTo-Json -Compress @{
    ok = ($rootHwnd -ne [IntPtr]::Zero)
    method = 'win32-passive-ready-no-zorder-change'
    windowTitle = $winTitle
    hwnd = $rootHwnd.ToInt64()
  })
  exit 0
}

if ($req.action -eq 'move_window_background') {
  if ($rootHwnd -ne [IntPtr]::Zero) {
    # 0x0015 = SWP_NOSIZE (0x0001) | SWP_NOZORDER (0x0004) | SWP_NOACTIVATE (0x0010)
    [void][GhostPawWin32BgV4]::SetWindowPos($rootHwnd, [IntPtr]::Zero, $x, $y, 0, 0, 0x0015)
  }
  Write-Output (ConvertTo-Json -Compress @{
    ok = ($rootHwnd -ne [IntPtr]::Zero)
    method = 'win32-move-window-noactivate'
    windowTitle = $winTitle
    hwnd = $rootHwnd.ToInt64()
  })
  exit 0
}

if ($req.action -eq 'resize_window_background') {
  $w = if ($null -ne $req.width) { [int]$req.width } else { 800 }
  $h = if ($null -ne $req.height) { [int]$req.height } else { 600 }
  if ($rootHwnd -ne [IntPtr]::Zero) {
    # 0x0016 = SWP_NOMOVE (0x0002) | SWP_NOZORDER (0x0004) | SWP_NOACTIVATE (0x0010)
    [void][GhostPawWin32BgV4]::SetWindowPos($rootHwnd, [IntPtr]::Zero, 0, 0, $w, $h, 0x0016)
  }
  Write-Output (ConvertTo-Json -Compress @{
    ok = ($rootHwnd -ne [IntPtr]::Zero)
    method = 'win32-resize-window-noactivate'
    windowTitle = $winTitle
    hwnd = $rootHwnd.ToInt64()
  })
  exit 0
}

$cpt = New-Object GhostPawWin32BgV4+POINT
$cpt.X = $x
$cpt.Y = $y
[void][GhostPawWin32BgV4]::ScreenToClient($targetHwnd, [ref]$cpt)
$lParam = [GhostPawWin32BgV4]::PackLParam($cpt.X, $cpt.Y)

$uiaDone = $false
$uiaMethod = ""
$elName = $reqName
$elRole = $reqRole
$elAutoId = $reqAutoId

# 快速通道 1：对 Windows 11 UWP 计算器 (存在 CoreWindow 子句柄) 且已知按钮 AutomationId 或明确按钮名时，直接向 CoreWindow 投递零激活按键消息
if (-not $uiaDone -and $coreHwnd -ne [IntPtr]::Zero -and $req.action -in @('click', 'left_click', 'clear')) {
  $fastCalcKeys = if ($req.action -eq 'clear') {
    [int[]]@(0xBB, 0x30, 0x6A, 0x30, 0xBB)
  } else {
    [GhostPawWin32BgV4]::TryGetCalcKeySequence($reqAutoId, $reqName)
  }
  if ($null -ne $fastCalcKeys -and $fastCalcKeys.Length -gt 0) {
    if ([GhostPawWin32BgV4]::SendCalcKeysToCoreWindow($coreHwnd, $fastCalcKeys)) {
      $uiaDone = $true
      $uiaMethod = "win32-uwp-corewindow-key-passthrough"
    }
  }
}

# 快速通道 2：对 Edit / RichEditD2DPT（如 Windows 11 记事本）优先使用后台无焦点 EM_SETSEL + EM_REPLACESEL 透传写入
if (-not $uiaDone -and $isEditHwnd -and ($req.action -eq 'type' -or $req.action -eq 'set_value' -or $req.action -eq 'clear')) {
  $clearAll = ($req.action -eq 'set_value' -or $req.action -eq 'clear' -or $req.clearFirst -eq $true)
  $txtToWrite = if ($req.action -eq 'clear') { "" } else { [string]$req.text }
  if ($req.pressEnter -eq $true -and $req.action -ne 'clear') {
    $txtToWrite = $txtToWrite + "\`r\`n"
  }
  if ([GhostPawWin32BgV4]::ReplaceEditText($targetHwnd, $txtToWrite, $clearAll)) {
    $uiaDone = $true
    $uiaMethod = if ($clearAll) { "win32-richedit-em-replacesel-set" } else { "win32-richedit-em-replacesel-append" }
    $elRole = $targetClass
  }
}

# 第一层：作用域严格锁定在目标窗口句柄 $rootHwnd 内部的 UIA 穿透引擎（绝不调用 FromPoint，并在调用前后通过 RestoreForegroundAndZOrder 锁死原前台焦点与 Z 序）
if (-not $uiaDone -and $rootHwnd -ne [IntPtr]::Zero -and $req.action -in @('click', 'left_click', 'toggle', 'check', 'uncheck', 'set_value', 'type', 'clear')) {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase -ErrorAction SilentlyContinue
    $searchRoots = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $rEl = [System.Windows.Automation.AutomationElement]::FromHandle($rootHwnd)
    if ($null -ne $rEl) { $searchRoots.Add($rEl) }
    if ($coreHwnd -ne [IntPtr]::Zero -and $coreHwnd -ne $rootHwnd) {
      $cEl = [System.Windows.Automation.AutomationElement]::FromHandle($coreHwnd)
      if ($null -ne $cEl) { $searchRoots.Add($cEl) }
    }

    $bestEl = $null
    $bestElScore = [double]::NegativeInfinity

    foreach ($sRoot in $searchRoots) {
      $descendants = $sRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Automation]::ControlViewCondition)
      if ($null -eq $descendants) { continue }
      for ($idx = 0; $idx -lt $descendants.Count; $idx++) {
        $cand = $descendants[$idx]
        try {
          $rect = $cand.Current.BoundingRectangle
          if ($rect.IsEmpty -or [double]::IsInfinity($rect.Width) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
          $cName = [string]$cand.Current.Name
          $cAutoId = [string]$cand.Current.AutomationId
          $cType = ([string]$cand.Current.ControlType.ProgrammaticName) -replace '^ControlType\\.', ''
          $cTypeLower = $cType.ToLowerInvariant()

          $ptInside = $hasCoord -and ($x -ge ($rect.Left - 6) -and $x -le ($rect.Right + 6) -and $y -ge ($rect.Top - 6) -and $y -le ($rect.Bottom + 6))
          $autoIdExact = (-not [string]::IsNullOrWhiteSpace($reqAutoId) -and [string]::Equals($cAutoId, $reqAutoId, [System.StringComparison]::OrdinalIgnoreCase))
          $nameExact = (-not [string]::IsNullOrWhiteSpace($reqName) -and [string]::Equals($cName, $reqName, [System.StringComparison]::OrdinalIgnoreCase))
          $nameSub = (-not [string]::IsNullOrWhiteSpace($reqName) -and -not [string]::IsNullOrWhiteSpace($cName) -and $cName.IndexOf($reqName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
          if (-not $ptInside -and -not $autoIdExact -and -not $nameExact -and -not $nameSub) { continue }

          $hasPat = $false
          $tmpPat = $null
          if ($req.action -in @('click', 'left_click', 'toggle', 'check', 'uncheck')) {
            if ($cand.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$tmpPat) -or
                $cand.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tmpPat) -or
                $cand.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$tmpPat) -or
                $cand.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$tmpPat)) {
              $hasPat = $true
            }
          } elseif ($req.action -in @('set_value', 'type', 'clear')) {
            if ($cand.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$tmpPat)) {
              $hasPat = $true
            }
          }
          if (-not $hasPat) { continue }

          $area = [Math]::Min(250000.0, ($rect.Width * $rect.Height))
          $cx = $rect.Left + ($rect.Width / 2.0)
          $cy = $rect.Top + ($rect.Height / 2.0)
          $dist = if ($hasCoord) { [Math]::Sqrt([Math]::Pow($x - $cx, 2) + [Math]::Pow($y - $cy, 2)) } else { 0.0 }

          $score = 500000.0 - $area - ($dist * 120.0)
          if ($autoIdExact) { $score += 1500000.0 }
          if ($ptInside) { $score += 600000.0 }
          if ($nameExact) { $score += 800000.0 }
          elseif ($nameSub) { $score += 350000.0 }
          if (-not [string]::IsNullOrWhiteSpace($reqRole) -and $cTypeLower.IndexOf($reqRole) -ge 0) {
            $score += 200000.0
          }

          if ($score -gt $bestElScore) {
            $bestElScore = $score
            $bestEl = $cand
          }
        } catch {}
      }
    }

    if ($null -ne $bestEl) {
      $elName = [string]$bestEl.Current.Name
      $elAutoId = [string]$bestEl.Current.AutomationId
      $elRole = [string]$bestEl.Current.ControlType.ProgrammaticName

      # 若通过坐标反查到的控件属于 UWP 计算器按钮，优先走 CoreWindow 零激活按键投递！
      if ($coreHwnd -ne [IntPtr]::Zero -and $req.action -in @('click', 'left_click')) {
        $calcKeys = [GhostPawWin32BgV4]::TryGetCalcKeySequence($elAutoId, $elName)
        if ($null -ne $calcKeys -and $calcKeys.Length -gt 0) {
          if ([GhostPawWin32BgV4]::SendCalcKeysToCoreWindow($coreHwnd, $calcKeys)) {
            $uiaDone = $true
            $uiaMethod = "win32-uwp-corewindow-key-passthrough"
          }
        }
      }

      if (-not $uiaDone) {
        if ($req.action -in @('click', 'left_click', 'toggle', 'check', 'uncheck')) {
          $pat = $null
          if ($req.action -in @('toggle', 'check', 'uncheck') -and $bestEl.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
            $pat.Toggle()
            [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
            $uiaDone = $true
            $uiaMethod = "uia-scoped-toggle-passthrough"
          } elseif ($bestEl.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) {
            $pat.Invoke()
            [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
            $uiaDone = $true
            $uiaMethod = "uia-scoped-invoke-passthrough"
          } elseif ($bestEl.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) {
            $pat.Toggle()
            [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
            $uiaDone = $true
            $uiaMethod = "uia-scoped-toggle-passthrough"
          } elseif ($bestEl.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) {
            $pat.Select()
            [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
            $uiaDone = $true
            $uiaMethod = "uia-scoped-select-passthrough"
          } elseif ($bestEl.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
            $pat.Expand()
            [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
            $uiaDone = $true
            $uiaMethod = "uia-scoped-expand-passthrough"
          }
        } elseif ($req.action -in @('set_value', 'type', 'clear')) {
          $valPat = $null
          if ($bestEl.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPat) -and -not $valPat.Current.IsReadOnly) {
            $txt = if ($req.action -eq 'clear') { "" } else { [string]$req.text }
            if ($req.clearFirst -eq $false -and $req.action -eq 'type' -and -not [string]::IsNullOrEmpty($valPat.Current.Value)) {
              $txt = $valPat.Current.Value + $txt
            }
            $valPat.SetValue($txt)
            [GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)
            $uiaDone = $true
            $uiaMethod = "uia-scoped-value-passthrough"
          }
        }
      }
    }
  } catch {}
}

# 第二层：深层子句柄 PostMessageW 坐标/按键消息透传（绝不发送 WM_ACTIVATE / SetForegroundWindow / SetWindowPos）
if (-not $uiaDone) {
  switch ($req.action) {
    { $_ -in @('click', 'left_click', 'toggle', 'check', 'uncheck') } {
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0200, [IntPtr]::Zero, $lParam)
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0201, [IntPtr]1, $lParam)
      Start-Sleep -Milliseconds 14
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0202, [IntPtr]::Zero, $lParam)
      $uiaMethod = "win32-hwnd-passthrough-lclick"
    }
    'double_click' {
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0200, [IntPtr]::Zero, $lParam)
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0201, [IntPtr]1, $lParam)
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0202, [IntPtr]::Zero, $lParam)
      Start-Sleep -Milliseconds 20
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0203, [IntPtr]1, $lParam)
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0202, [IntPtr]::Zero, $lParam)
      $uiaMethod = "win32-hwnd-passthrough-dblclick"
    }
    'triple_click' {
      for ($i = 0; $i -lt 3; $i++) {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0201, [IntPtr]1, $lParam)
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0202, [IntPtr]::Zero, $lParam)
        Start-Sleep -Milliseconds 16
      }
      $uiaMethod = "win32-hwnd-passthrough-tripleclick"
    }
    'right_click' {
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0200, [IntPtr]::Zero, $lParam)
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0204, [IntPtr]2, $lParam)
      Start-Sleep -Milliseconds 14
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0205, [IntPtr]::Zero, $lParam)
      $uiaMethod = "win32-hwnd-passthrough-rclick"
    }
    { $_ -in @('type', 'set_value', 'clear') } {
      if ($hasCoord) {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0201, [IntPtr]1, $lParam)
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0202, [IntPtr]::Zero, $lParam)
        Start-Sleep -Milliseconds 16
      }
      if ($req.clearFirst -eq $true -or $req.action -eq 'set_value' -or $req.action -eq 'clear') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x00B1, [IntPtr]::Zero, [IntPtr](-1))
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0303, [IntPtr]::Zero, [IntPtr]::Zero)
      }
      $txt = if ($req.action -eq 'clear') { "" } else { [string]$req.text }
      foreach ($ch in $txt.ToCharArray()) {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0102, [IntPtr][int][char]$ch, [IntPtr]::Zero)
      }
      if ($req.pressEnter -eq $true -and $req.action -ne 'clear') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0100, [IntPtr]0x0D, [IntPtr]::Zero)
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0101, [IntPtr]0x0D, [IntPtr]::Zero)
      }
      $uiaMethod = "win32-hwnd-passthrough-wmchar"
    }
    'scroll' {
      $amt = if ($null -ne $req.amount) { [int]$req.amount } else { 3 }
      $dir = if ($null -ne $req.direction) { [string]$req.direction } else { "down" }
      $delta = if ($dir -eq 'up' -or $dir -eq 'left') { 120 * $amt } else { -120 * $amt }
      $wParam = [IntPtr](($delta -shl 16) -band 0xFFFF0000)
      $screenLParam = [GhostPawWin32BgV4]::PackLParam($x, $y)
      [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x020A, $wParam, $screenLParam)
      $uiaMethod = "win32-hwnd-passthrough-wheel"
    }
    { $_ -in @('key', 'hotkey') } {
      $rawCombo = ([string]$req.key).Trim().ToLower()
      if ($coreHwnd -ne [IntPtr]::Zero) {
        $calcKeySeq = [GhostPawWin32BgV4]::TryGetCalcKeySequence("", $rawCombo)
        if ($null -ne $calcKeySeq -and $calcKeySeq.Length -gt 0) {
          [void][GhostPawWin32BgV4]::SendCalcKeysToCoreWindow($coreHwnd, $calcKeySeq)
          $uiaMethod = "win32-uwp-corewindow-key-passthrough"
          break
        }
      }
      if ($rawCombo -eq 'ctrl+a' -or $rawCombo -eq 'cmd+a') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x00B1, [IntPtr]::Zero, [IntPtr](-1))
        $uiaMethod = "win32-hwnd-passthrough-em-setsel-all"
      } elseif ($rawCombo -eq 'ctrl+c' -or $rawCombo -eq 'cmd+c') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0301, [IntPtr]::Zero, [IntPtr]::Zero)
        $uiaMethod = "win32-hwnd-passthrough-wm-copy"
      } elseif ($rawCombo -eq 'ctrl+v' -or $rawCombo -eq 'cmd+v') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0302, [IntPtr]::Zero, [IntPtr]::Zero)
        $uiaMethod = "win32-hwnd-passthrough-wm-paste"
      } elseif ($rawCombo -eq 'ctrl+x' -or $rawCombo -eq 'cmd+x') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0300, [IntPtr]::Zero, [IntPtr]::Zero)
        $uiaMethod = "win32-hwnd-passthrough-wm-cut"
      } elseif ($rawCombo -eq 'ctrl+z' -or $rawCombo -eq 'cmd+z') {
        [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0304, [IntPtr]::Zero, [IntPtr]::Zero)
        $uiaMethod = "win32-hwnd-passthrough-wm-undo"
      } elseif ($isEditHwnd -and ($rawCombo -eq 'enter' -or $rawCombo -eq 'return')) {
        [void][GhostPawWin32BgV4]::ReplaceEditText($targetHwnd, "\`r\`n", $false)
        $uiaMethod = "win32-richedit-em-replacesel-newline"
      } else {
        $k = $rawCombo -replace '^.*\\+', ''
        $vk = switch ($k) {
          'enter' { 0x0D }
          'return' { 0x0D }
          'escape' { 0x1B }
          'esc' { 0x1B }
          'tab' { 0x09 }
          'backspace' { 0x08 }
          'delete' { 0x2E }
          'space' { 0x20 }
          'up' { 0x26 }
          'down' { 0x28 }
          'left' { 0x25 }
          'right' { 0x27 }
          default {
            if ($k.Length -eq 1) { [int][char]$k.ToUpper() } else { 0 }
          }
        }
        if ($vk -gt 0) {
          $keyTarget = if ($coreHwnd -ne [IntPtr]::Zero) { $coreHwnd } else { $targetHwnd }
          [void][GhostPawWin32BgV4]::PostMessageW($keyTarget, 0x0100, [IntPtr]$vk, [IntPtr]1)
          if ($coreHwnd -eq [IntPtr]::Zero) {
            [void][GhostPawWin32BgV4]::PostMessageW($keyTarget, 0x0101, [IntPtr]$vk, [IntPtr]::Zero)
          }
        }
        $uiaMethod = "win32-hwnd-passthrough-key"
      }
    }
  }
} elseif (($req.action -eq 'set_value' -or $req.action -eq 'type') -and $req.pressEnter -eq $true -and -not $isEditHwnd) {
  [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0100, [IntPtr]0x0D, [IntPtr]::Zero)
  [void][GhostPawWin32BgV4]::PostMessageW($targetHwnd, 0x0101, [IntPtr]0x0D, [IntPtr]::Zero)
}

[GhostPawWin32BgV4]::RestoreForegroundAndZOrder($rootHwnd, $prevFgBeforeAction, $prevAboveBeforeAction)

Write-Output (ConvertTo-Json -Compress @{
  ok = ($targetHwnd -ne [IntPtr]::Zero -or $uiaDone)
  method = $uiaMethod
  windowTitle = $winTitle
  elementName = $elName
  elementRole = $elRole
  automationId = $elAutoId
  hwnd = $targetHwnd.ToInt64()
  clientX = $cpt.X
  clientY = $cpt.Y
})
`;
    if (win32BgScriptEnsuredVersion !== WIN32_BG_SCRIPT_VERSION || !existsSync(scriptPath)) {
        if (!existsSync(scriptPath) || readFileSync(scriptPath, 'utf8') !== psScript) {
            writeFileSync(scriptPath, psScript, 'utf8');
        }
        win32BgScriptEnsuredVersion = WIN32_BG_SCRIPT_VERSION;
    }
    return { scriptPath, dllPath, payloadB64 };
}
function parseWindowsBgOutput(stdoutRaw, stderrRaw, exitStatus) {
    const stdout = (stdoutRaw || '').trim();
    const lastLine = stdout.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{'));
    if (lastLine) {
        const parsed = JSON.parse(lastLine);
        const detail = parsed.detail ||
            [parsed.method, parsed.elementName || parsed.automationId, parsed.windowTitle, parsed.error]
                .filter(Boolean)
                .join(' · ') ||
            parsed.method;
        return {
            ...parsed,
            detail,
        };
    }
    const errText = (stderrRaw || '').trim() || stdout || `exit=${exitStatus}`;
    return {
        ok: false,
        method: 'powershell-parse-failed',
        detail: errText,
        error: errText,
    };
}
export function executeWindowsBackgroundPointAction(options) {
    if (process.platform !== 'win32') {
        return { ok: false, method: 'unsupported-os', detail: 'only supported on win32', error: 'only supported on win32' };
    }
    try {
        const { scriptPath, dllPath, payloadB64 } = prepareWindowsBgInvocation(options);
        const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, payloadB64, dllPath], {
            encoding: 'utf8',
            timeout: 12000,
            windowsHide: true,
        });
        return parseWindowsBgOutput(res.stdout || '', res.stderr || '', res.status);
    }
    catch (err) {
        const errText = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            method: 'powershell-exception',
            detail: errText,
            error: errText,
        };
    }
}
export async function executeWindowsBackgroundPointActionAsync(options) {
    if (process.platform !== 'win32') {
        return { ok: false, method: 'unsupported-os', detail: 'only supported on win32', error: 'only supported on win32' };
    }
    try {
        const { scriptPath, dllPath, payloadB64 } = prepareWindowsBgInvocation(options);
        return await new Promise(resolve => {
            const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, payloadB64, dllPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            const outChunks = [];
            const errChunks = [];
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try {
                        child.kill('SIGKILL');
                    }
                    catch { }
                    resolve({
                        ok: false,
                        method: 'powershell-timeout',
                        detail: 'background powershell timed out after 15000ms',
                        error: 'timeout',
                    });
                }
            }, 15000);
            child.stdout?.on('data', (chunk) => outChunks.push(chunk));
            child.stderr?.on('data', (chunk) => errChunks.push(chunk));
            child.on('error', err => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                const errText = err instanceof Error ? err.message : String(err);
                resolve({
                    ok: false,
                    method: 'powershell-spawn-error',
                    detail: errText,
                    error: errText,
                });
            });
            child.on('close', code => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                try {
                    const stdout = Buffer.concat(outChunks).toString('utf8');
                    const stderr = Buffer.concat(errChunks).toString('utf8');
                    resolve(parseWindowsBgOutput(stdout, stderr, code));
                }
                catch (err) {
                    const errText = err instanceof Error ? err.message : String(err);
                    resolve({
                        ok: false,
                        method: 'powershell-exception',
                        detail: errText,
                        error: errText,
                    });
                }
            });
        });
    }
    catch (err) {
        const errText = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            method: 'powershell-exception',
            detail: errText,
            error: errText,
        };
    }
}
/**
 * 将简写引用（如 `e5` 或 `@e5`）自动补全为带最新 `snapshot_id` 的完整引用（`@<snapshot_id>:e5`）
 */
export function qualifyAgentDesktopRef(rawRef, lastSnapshotId) {
    const trimmed = String(rawRef ?? '').trim();
    if (!trimmed)
        return '';
    if (/^@[a-z0-9_-]+:e\d+$/i.test(trimmed)) {
        return trimmed;
    }
    if (/^[a-z0-9_-]+:e\d+$/i.test(trimmed)) {
        return `@${trimmed}`;
    }
    const bareMatch = /^@?(e\d+)$/i.exec(trimmed);
    if (bareMatch && lastSnapshotId) {
        return `@${lastSnapshotId}:${bareMatch[1].toLowerCase()}`;
    }
    return trimmed;
}
/**
 * 确保当前智能体会话已初始化 `agent-desktop` 命名空间（注意：绝不在会话创建时常驻开启小鼠标，仅在实际动作发生时按需唤醒！）
 */
export async function ensureAgentDesktopSession(options = {}) {
    const key = options.sessionKey || 'default';
    const desiredLabel = options.cursorLabel?.trim() || 'Agent-Desktop';
    const wantMulti = Boolean(options.multiAgent || options.agentId);
    const existing = activeSessions.get(key);
    if (existing) {
        return existing;
    }
    const inFlight = activeSessionInFlight.get(key);
    if (inFlight) {
        return inFlight;
    }
    let initPromise = null;
    initPromise = (async () => {
        try {
            const recheck = activeSessions.get(key);
            if (recheck)
                return recheck;
            // 检查磁盘缓存的会话是否仍然存活
            const sessionFile = join(getAgentDesktopRootDir(), `session-${key}.json`);
            if (existsSync(sessionFile)) {
                try {
                    const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
                    if (saved.sessionId) {
                        const listRes = await runAgentDesktopCli(['session', 'list'], { timeoutMs: 10000 });
                        const sessions = listRes.envelope?.data?.sessions ?? [];
                        const stillActive = sessions.some(s => s.session_id === saved.sessionId && !s.ended_at);
                        if (stillActive) {
                            // 确保禁用 agent-desktop 在 Linux 下内置的丑陋多边形常驻光标
                            if (process.platform === 'linux') {
                                await runAgentDesktopCli(['--session', saved.sessionId, 'cursor-overlay', 'disable'], {
                                    sessionId: saved.sessionId,
                                    timeoutMs: 5000,
                                }).catch(() => { });
                            }
                            const restoredMap = new Map();
                            const restoredByWin = new Map();
                            if (Array.isArray(saved.refMetaEntries)) {
                                for (const entry of saved.refMetaEntries) {
                                    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1]) {
                                        restoredMap.set(entry[0], entry[1]);
                                        const snap = /^@([a-z0-9_-]+):e\d+$/i.exec(entry[1].ref || '')?.[1];
                                        if (snap && entry[1].windowId) {
                                            restoredByWin.set(entry[1].windowId, snap);
                                        }
                                    }
                                }
                            }
                            const state = {
                                sessionId: saved.sessionId,
                                cursorEnabled: false,
                                cursorLabel: saved.cursorLabel || desiredLabel,
                                multiAgent: Boolean(saved.multiAgent),
                                lastSnapshotId: saved.lastSnapshotId,
                                lastApp: saved.lastApp,
                                lastWindowId: saved.lastWindowId,
                                refMetaMap: restoredMap,
                                snapshotOwnerMap: new Map(),
                                lastSnapshotByWindow: restoredByWin,
                                agentStates: new Map(),
                            };
                            activeSessions.set(key, state);
                            return state;
                        }
                    }
                }
                catch { }
            }
            // 创建全新的 agent-desktop 会话（不加 --cursor，防止未执行操作时常驻显示小鼠标！）
            const startArgs = ['session', 'start', '--name', `ghostpaw-${key}`];
            const startRes = await runAgentDesktopCli(startArgs, { timeoutMs: 15000 });
            const sessionId = String(startRes.envelope?.data?.session_id ?? '').trim();
            if (!sessionId) {
                throw new Error(`无法启动 agent-desktop 会话: ${startRes.stderr || startRes.stdout}`);
            }
            const state = {
                sessionId,
                cursorEnabled: false,
                cursorLabel: desiredLabel,
                multiAgent: wantMulti,
                refMetaMap: new Map(),
                snapshotOwnerMap: new Map(),
                lastSnapshotByWindow: new Map(),
                agentStates: new Map(),
            };
            activeSessions.set(key, state);
            persistSessionState(key, state);
            return state;
        }
        finally {
            if (activeSessionInFlight.get(key) === initPromise) {
                activeSessionInFlight.delete(key);
            }
        }
    })();
    activeSessionInFlight.set(key, initPromise);
    return initPromise;
}
function persistSessionState(key, state) {
    try {
        const sessionFile = join(getAgentDesktopRootDir(), `session-${key}.json`);
        const { refMetaMap, snapshotOwnerMap: _so, lastSnapshotByWindow: _lsbw, agentStates: _as, ...serializable } = state;
        const payload = {
            ...serializable,
            refMetaEntries: Array.from(refMetaMap.entries()).slice(-400),
        };
        writeFileSync(sessionFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    catch { }
}
/**
 * 将插件专属的圆角三角形 3D 琉璃小鼠标 (`ghostpaw-neon-hollow-cursor.png`, 34×34, hotspot `4,1`) 与当前动作气泡同步到会话配置
 * 注意：绝不直接调用 `agent-desktop cursor-overlay enable`（那会发送 `CursorOverlayControl::Enable` 将光标停在屏幕正中央 `(960, 520)`）！
 */
export async function configureStarCursorOverlay(sessionId, options = {}) {
    const starPngPath = ensureStarCursorAsset();
    const label = clampOverlayLabelWords(options.label?.trim() || 'Agent-Desktop 正在执行操作', 10);
    if (process.platform === 'linux') {
        await presentDesktopActionCursor({
            x: options.x,
            y: options.y,
            bubbleText: label,
            sessionId,
            agentId: options.agentId,
        });
    }
    else {
        syncSessionCursorOverlayManifest(sessionId, {
            enabled: true,
            label,
            multiAgent: Boolean(options.multiAgent || options.agentId),
        });
        if (typeof options.x === 'number' && typeof options.y === 'number') {
            await presentDesktopActionCursor({
                x: options.x,
                y: options.y,
                bubbleText: label,
                sessionId,
                agentId: options.agentId,
            });
        }
    }
    return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, session_id: sessionId, label }),
        stderr: '',
        envelope: {
            ok: true,
            command: 'cursor-overlay',
            data: {
                session_id: sessionId,
                cursor_overlay: {
                    enabled: true,
                    label,
                    auto_hide_ms: CURSOR_IDLE_AUTO_HIDE_MS,
                    style: buildCursorOverlayStylePayload(starPngPath),
                },
            },
        },
    };
}
/**
 * 构建动作执行前的通用全局选项（`--session`、`--agent-id`、`--headed`、`--wait-for`）
 */
function buildGlobalCliOptions(sessionId, args, forceHeaded = false) {
    const flags = ['--session', sessionId];
    if (args.agentId && /^[a-zA-Z0-9_-]{1,64}$/.test(args.agentId)) {
        flags.push('--agent-id', args.agentId);
    }
    if (args.headed === true || forceHeaded) {
        flags.push('--headed');
    }
    if (args.waitFor?.trim()) {
        flags.push('--wait-for', args.waitFor.trim());
    }
    if (args.waitForGone?.trim()) {
        flags.push('--wait-for-gone', args.waitForGone.trim());
    }
    if (typeof args.timeoutMs === 'number' && args.timeoutMs > 0 && (args.waitFor || args.waitForGone)) {
        flags.push('--wait-timeout', String(Math.round(args.timeoutMs)));
    }
    return flags;
}
/**
 * 将 `agent-desktop` CLI 返回的 `envelope.data` 规范化为普通 JSON Object（防止 `list-windows` / `list-displays` 返回顶层 Array 导致工具 Schema 校验报错 `value.data must be an object`）
 */
export function normalizeEnvelopeData(action, rawData) {
    if (Array.isArray(rawData)) {
        if (action === 'list_windows') {
            return { windows: rawData, items: rawData, count: rawData.length };
        }
        if (action === 'list_displays') {
            return { displays: rawData, items: rawData, count: rawData.length };
        }
        if (action === 'list_apps') {
            return { apps: rawData, items: rawData, count: rawData.length };
        }
        if (action === 'list_surfaces') {
            return { surfaces: rawData, items: rawData, count: rawData.length };
        }
        return { items: rawData, count: rawData.length };
    }
    if (!rawData || typeof rawData !== 'object') {
        return rawData === undefined || rawData === null ? {} : { value: rawData };
    }
    return rawData;
}
let windowsListCache = null;
let windowsListInFlight = null;
const WINDOWS_LIST_CACHE_TTL_MS = 8000;
function invalidateWindowsWindowListCache() {
    windowsListCache = null;
}
async function fetchWindowsWindowListCached(sessionId, agentId, forceRefresh = false) {
    if (!forceRefresh && windowsListCache && Date.now() - windowsListCache.ts < WINDOWS_LIST_CACHE_TTL_MS) {
        return windowsListCache.list;
    }
    if (!forceRefresh && windowsListInFlight) {
        return windowsListInFlight;
    }
    let task = null;
    task = (async () => {
        try {
            const listRes = await runAgentDesktopCli(['--session', sessionId, 'list-windows'], {
                sessionId,
                agentId,
                timeoutMs: 6000,
            });
            const raw = listRes.envelope?.data;
            const list = Array.isArray(raw)
                ? raw
                : Array.isArray(raw?.windows)
                    ? raw.windows
                    : [];
            if (list.length > 0) {
                windowsListCache = { ts: Date.now(), list };
            }
            return list;
        }
        finally {
            if (windowsListInFlight === task) {
                windowsListInFlight = null;
            }
        }
    })();
    windowsListInFlight = task;
    return task;
}
async function resolveWindowsWindowByApp(sessionId, appQuery, agentId) {
    if (process.platform !== 'win32' || !appQuery?.trim())
        return undefined;
    try {
        let list = await fetchWindowsWindowListCached(sessionId, agentId, false);
        for (let pass = 0; pass < 2; pass++) {
            for (const item of list) {
                const id = typeof item.id === 'string' ? item.id : undefined;
                const app = (typeof item.app === 'string' && item.app.trim()) ||
                    (typeof item.app_name === 'string' && item.app_name.trim()) ||
                    undefined;
                const title = typeof item.title === 'string' ? item.title : undefined;
                if (id && matchWindowsAppCandidate(appQuery, { id, app, title })) {
                    return {
                        id,
                        app,
                        title,
                        hwnd: parseWindowHandleFromId(id),
                        bounds: item.bounds,
                    };
                }
            }
            if (pass === 0) {
                list = await fetchWindowsWindowListCached(sessionId, agentId, true);
            }
        }
    }
    catch { }
    return undefined;
}
/**
 * 统计无障碍树中的节点数量与前若干个可交互节点摘要，并缓存每个 `ref`（同时索引简写 `e5` 与完整 `@<snapshot_id>:e5`）的屏幕坐标、名称及所属窗口 (`windowId` / `app`) 供小鼠标与后台透传引擎使用
 */
function summarizeAndCacheSnapshotTree(data, refMetaMap, snapshotId, owner, sessionId, snapshotOwnerMap) {
    let totalNodes = 0;
    const interactivePreview = [];
    const loadedDiskSnapIds = new Set();
    const effectiveSnapId = (typeof data?.snapshot_id === 'string' && data.snapshot_id.trim()) || snapshotId || undefined;
    if (sessionId && effectiveSnapId) {
        loadedDiskSnapIds.add(effectiveSnapId);
        loadSnapshotRefMapFromDisk(sessionId, effectiveSnapId, refMetaMap, snapshotOwnerMap);
    }
    const dataWinId = owner?.windowId ||
        (typeof data?.window_id === 'string' ? data.window_id : undefined) ||
        (typeof data?.window?.id === 'string'
            ? String((data?.window).id)
            : undefined);
    const dataApp = owner?.app ||
        (typeof data?.app === 'string' ? data.app : undefined) ||
        (typeof data?.window?.app === 'string'
            ? String((data?.window).app)
            : undefined);
    const visit = (node) => {
        if (!node || typeof node !== 'object')
            return;
        totalNodes += 1;
        const rec = node;
        const ref = typeof rec.ref_id === 'string' ? rec.ref_id : typeof rec.ref === 'string' ? rec.ref : undefined;
        const role = typeof rec.role === 'string' ? rec.role : 'element';
        const name = typeof rec.name === 'string' ? rec.name : typeof rec.title === 'string' ? rec.title : '';
        const val = typeof rec.value === 'string' ? rec.value : '';
        const rawBounds = rec.bounds;
        if (ref) {
            const nodeSnapId = /^@([a-z0-9_-]+):e\d+$/i.exec(ref)?.[1] || effectiveSnapId;
            if (sessionId && nodeSnapId && !loadedDiskSnapIds.has(nodeSnapId)) {
                loadedDiskSnapIds.add(nodeSnapId);
                loadSnapshotRefMapFromDisk(sessionId, nodeSnapId, refMetaMap, snapshotOwnerMap);
            }
            const bareRef = ref.replace(/^@[a-z0-9_-]+:/i, '').replace(/^@/, '');
            const fullRef = qualifyAgentDesktopRef(bareRef, nodeSnapId);
            const prevMeta = (fullRef ? refMetaMap.get(fullRef) : undefined) ?? refMetaMap.get(ref);
            let centerX = prevMeta?.centerX;
            let centerY = prevMeta?.centerY;
            let normalizedBounds = prevMeta?.bounds;
            if (rawBounds &&
                typeof rawBounds.x === 'number' &&
                typeof rawBounds.y === 'number' &&
                typeof rawBounds.width === 'number' &&
                typeof rawBounds.height === 'number') {
                centerX = Math.round(rawBounds.x + rawBounds.width / 2);
                centerY = Math.round(rawBounds.y + rawBounds.height / 2);
                normalizedBounds = {
                    x: Math.round(rawBounds.x),
                    y: Math.round(rawBounds.y),
                    width: Math.round(rawBounds.width),
                    height: Math.round(rawBounds.height),
                };
            }
            const metaObj = {
                ref: fullRef || ref,
                role: role !== 'element' ? role : prevMeta?.role || role,
                name: name || val || prevMeta?.name || bareRef,
                automationId: prevMeta?.automationId,
                windowId: dataWinId || prevMeta?.windowId,
                app: dataApp || prevMeta?.app,
                centerX,
                centerY,
                bounds: normalizedBounds,
            };
            if (!rec.ref && fullRef) {
                rec.ref = fullRef;
            }
            if (!rec.bounds && normalizedBounds) {
                rec.bounds = normalizedBounds;
            }
            if (!rec.window_id && metaObj.windowId) {
                rec.window_id = metaObj.windowId;
            }
            if (!rec.app && metaObj.app) {
                rec.app = metaObj.app;
            }
            refMetaMap.set(ref, metaObj);
            refMetaMap.set(bareRef, metaObj);
            refMetaMap.set(`@${bareRef}`, metaObj);
            if (fullRef) {
                refMetaMap.set(fullRef, metaObj);
            }
            if (metaObj.windowId) {
                refMetaMap.set(`${metaObj.windowId}:${bareRef}`, metaObj);
                refMetaMap.set(`${metaObj.windowId}:@${bareRef}`, metaObj);
            }
            if (interactivePreview.length < 180) {
                const labelPart = name ? ` "${name.slice(0, 50)}"` : '';
                const valPart = val ? ` [val="${val.slice(0, 30)}"]` : '';
                const posPart = centerX !== undefined && centerY !== undefined && normalizedBounds
                    ? ` @(${centerX},${centerY}) [${normalizedBounds.x},${normalizedBounds.y} ${normalizedBounds.width}x${normalizedBounds.height}]`
                    : '';
                interactivePreview.push(`${fullRef || ref} (${role})${labelPart}${valPart}${posPart}`);
            }
        }
        if (Array.isArray(rec.children)) {
            for (const child of rec.children) {
                visit(child);
            }
        }
    };
    if (data?.tree) {
        visit(data.tree);
    }
    else if (Array.isArray(data?.matches)) {
        for (const m of data.matches) {
            visit(m);
        }
    }
    else if (data?.match && typeof data.match === 'object') {
        visit(data.match);
        if (!Array.isArray(data.matches)) {
            data.matches = [data.match];
        }
    }
    else if (Array.isArray(data?.elements)) {
        for (const el of data.elements) {
            visit(el);
        }
    }
    return { totalNodes, interactivePreview };
}
/**
 * 根据当前执行的 `agent_desktop` 动作生成显示在迷你小鼠标旁的实时聊天气泡文案
 * 注意：纯读取/枚举/观察类动作返回 undefined，不唤醒桌面鼠标，仅在实际执行交互操作时显示！
 */
export function buildActionChatBubbleText(args, qualifiedRef, refMeta) {
    if (args.cursorLabel?.trim()) {
        return args.cursorLabel.trim();
    }
    const action = args.action;
    // 纯元数据查询与只读观察动作不弹出小鼠标，避免鼠标停留在屏幕中央干扰用户
    if (action === 'status' ||
        action === 'permissions' ||
        action === 'list_apps' ||
        action === 'list_windows' ||
        action === 'list_displays' ||
        action === 'list_surfaces' ||
        action === 'snapshot' ||
        action === 'find' ||
        action === 'get' ||
        action === 'is' ||
        action === 'screenshot' ||
        action === 'clipboard_get' ||
        action === 'cursor_disable') {
        return undefined;
    }
    const coordLabel = typeof args.x === 'number' && typeof args.y === 'number' ? `@(${Math.round(args.x)},${Math.round(args.y)})` : '';
    const targetName = refMeta?.name
        ? `「${refMeta.name.slice(0, 14)}」`
        : qualifiedRef
            ? `(${qualifiedRef})`
            : coordLabel;
    const appLabel = args.app ? `「${args.app.slice(0, 12)}」` : '桌面窗口';
    switch (action) {
        case 'click':
            return `Agent-Desktop · 正在点击${targetName}`;
        case 'double_click':
            return `Agent-Desktop · 正在双击${targetName}`;
        case 'triple_click':
            return `Agent-Desktop · 正在三连击${targetName}`;
        case 'right_click':
            return `Agent-Desktop · 正在右键点击${targetName}`;
        case 'set_value':
        case 'type': {
            const txt = String(args.text ?? args.value ?? '').trim();
            const preview = txt.length > 12 ? `${txt.slice(0, 12)}...` : txt;
            return `Agent-Desktop · 正在输入 "${preview}"`;
        }
        case 'clear':
            return `Agent-Desktop · 正在清空${targetName}`;
        case 'focus':
            return `Agent-Desktop · 正在聚焦${targetName}`;
        case 'select':
            return `Agent-Desktop · 正在选择「${String(args.value ?? args.text ?? '').slice(0, 12)}」`;
        case 'toggle':
        case 'check':
        case 'uncheck':
            return `Agent-Desktop · 正在勾选/切换${targetName}`;
        case 'expand':
        case 'collapse':
            return `Agent-Desktop · 正在展开/折叠${targetName}`;
        case 'scroll':
        case 'scroll_to':
            return `Agent-Desktop · 正在滚动${targetName || appLabel}`;
        case 'press':
            return `Agent-Desktop · 正在按键 [${args.key || args.text || ''}]`;
        case 'launch':
            return `Agent-Desktop · 正在启动${appLabel}`;
        case 'close_app':
            return `Agent-Desktop · 正在关闭${appLabel}`;
        case 'focus_window':
        case 'resize_window':
        case 'move_window':
        case 'minimize':
        case 'maximize':
        case 'restore':
            return `Agent-Desktop · 正在调整${appLabel}`;
        case 'wait':
            return undefined;
        case 'clipboard_set':
        case 'clipboard_clear':
            return `Agent-Desktop · 正在写入剪贴板`;
        case 'batch':
            return `Agent-Desktop · 正在批量执行 ${args.batchCommands?.length ?? 0} 步动作`;
        case 'cursor_enable':
            return `Agent-Desktop · 小鼠标已唤醒`;
        default:
            return `Agent-Desktop · 正在执行 ${action}`;
    }
}
/**
 * 执行 `agent_desktop` 工具指令
 */
export async function executeAgentDesktopAction(args, ctx) {
    const action = args.action;
    const rawAgentId = args.agentId?.trim();
    const effectiveAgentId = rawAgentId
        ? rawAgentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || undefined
        : undefined;
    const sessionState = await ensureAgentDesktopSession({
        cursorLabel: args.cursorLabel,
        agentId: effectiveAgentId,
        multiAgent: Boolean(effectiveAgentId),
    });
    if (action === 'launch' || action === 'close_app' || action === 'list_windows') {
        invalidateWindowsWindowListCache();
    }
    let preResolvedWin;
    if (process.platform === 'win32' &&
        args.app?.trim() &&
        !args.windowId?.trim() &&
        action !== 'status' &&
        action !== 'permissions' &&
        action !== 'list_windows' &&
        action !== 'list_displays' &&
        action !== 'list_apps' &&
        action !== 'cursor_enable' &&
        action !== 'cursor_disable' &&
        action !== 'launch') {
        preResolvedWin = await resolveWindowsWindowByApp(sessionState.sessionId, args.app.trim(), effectiveAgentId);
    }
    const explicitSnapPrefix = args.ref ? /^@?([a-z0-9_-]+):e\d+$/i.exec(args.ref.trim())?.[1] : undefined;
    const explicitSnapOwner = explicitSnapPrefix ? sessionState.snapshotOwnerMap.get(explicitSnapPrefix) : undefined;
    const initialWindowId = args.windowId?.trim() || preResolvedWin?.id || explicitSnapOwner?.windowId;
    const initialAppKey = (preResolvedWin?.app || args.app || explicitSnapOwner?.app)?.trim()?.toLowerCase();
    const agentKey = effectiveAgentId
        ? initialWindowId
            ? `${effectiveAgentId}@${initialWindowId}`
            : initialAppKey
                ? `${effectiveAgentId}@${initialAppKey}`
                : effectiveAgentId
        : initialWindowId
            ? `win@${initialWindowId}`
            : initialAppKey
                ? `app@${initialAppKey}`
                : 'default';
    let agentState = sessionState.agentStates.get(agentKey);
    if (!agentState) {
        agentState = {};
        sessionState.agentStates.set(agentKey, agentState);
    }
    if (args.app?.trim()) {
        const resolvedAppName = preResolvedWin?.app || args.app.trim();
        agentState.lastApp = resolvedAppName;
        sessionState.lastApp = resolvedAppName;
        if (preResolvedWin?.id && !args.windowId?.trim()) {
            agentState.lastWindowId = preResolvedWin.id;
            sessionState.lastWindowId = preResolvedWin.id;
        }
    }
    if (args.windowId?.trim()) {
        agentState.lastWindowId = args.windowId.trim();
        sessionState.lastWindowId = args.windowId.trim();
    }
    const candidateWindowId = initialWindowId || agentState.lastWindowId;
    const preferredSnapshotId = (candidateWindowId ? sessionState.lastSnapshotByWindow.get(candidateWindowId) : undefined) ||
        agentState.lastSnapshotId ||
        (!candidateWindowId && !args.app?.trim() ? sessionState.lastSnapshotId : undefined);
    let qualifiedRef = qualifyAgentDesktopRef(args.ref, preferredSnapshotId);
    const bareRefKey = args.ref ? args.ref.trim().replace(/^@[a-z0-9_-]+:/i, '').replace(/^@/, '') : '';
    const lookupRefMetaScoped = (winId) => {
        if (qualifiedRef) {
            const exact = sessionState.refMetaMap.get(qualifiedRef);
            if (exact && (!winId || !exact.windowId || exact.windowId === winId)) {
                return exact;
            }
        }
        if (winId && bareRefKey) {
            const winScoped = sessionState.refMetaMap.get(`${winId}:${bareRefKey}`);
            if (winScoped)
                return winScoped;
        }
        if (bareRefKey) {
            const fallback = sessionState.refMetaMap.get(bareRefKey);
            if (fallback && (!winId || !fallback.windowId || fallback.windowId === winId)) {
                return fallback;
            }
        }
        return undefined;
    };
    let refMeta = lookupRefMetaScoped(candidateWindowId);
    const snapPrefix = /^@([a-z0-9_-]+):e\d+$/i.exec(qualifiedRef)?.[1];
    if (snapPrefix &&
        (!refMeta || refMeta.centerX === undefined || refMeta.centerY === undefined || !refMeta.automationId)) {
        loadSnapshotRefMapFromDisk(sessionState.sessionId, snapPrefix, sessionState.refMetaMap, sessionState.snapshotOwnerMap);
        refMeta = lookupRefMetaScoped(candidateWindowId);
    }
    const snapOwner = snapPrefix ? sessionState.snapshotOwnerMap.get(snapPrefix) : undefined;
    let effectiveApp = preResolvedWin?.app ||
        args.app?.trim() ||
        refMeta?.app ||
        snapOwner?.app ||
        agentState.lastApp ||
        sessionState.lastApp;
    let effectiveWindowId = args.windowId?.trim() ||
        preResolvedWin?.id ||
        refMeta?.windowId ||
        snapOwner?.windowId ||
        (!args.app?.trim() ? agentState.lastWindowId || sessionState.lastWindowId : agentState.lastWindowId);
    const isHeaded = args.headed === true;
    const deliveryMode = isHeaded
        ? 'headed-physical'
        : 'headless-semantic-star-cursor';
    // Windows 下双语应用名/进程名自动解析为精确的 windowId (如 "calc.exe" / "计算器" -> "w-67304" / "CalculatorApp")
    if (process.platform === 'win32' &&
        effectiveApp &&
        !effectiveWindowId &&
        action !== 'status' &&
        action !== 'permissions' &&
        action !== 'list_windows' &&
        action !== 'list_displays' &&
        action !== 'list_apps' &&
        action !== 'cursor_enable' &&
        action !== 'cursor_disable') {
        const resolvedWin = await resolveWindowsWindowByApp(sessionState.sessionId, effectiveApp, effectiveAgentId);
        if (resolvedWin?.id) {
            effectiveWindowId = resolvedWin.id;
            agentState.lastWindowId = resolvedWin.id;
            sessionState.lastWindowId = resolvedWin.id;
            if (resolvedWin.app) {
                effectiveApp = resolvedWin.app;
                agentState.lastApp = resolvedWin.app;
                sessionState.lastApp = resolvedWin.app;
            }
        }
    }
    // 自动按目标窗口隔离琉璃小鼠标管道：即使并发子智能体未显式传 agentId，操作不同窗口（如计算器 w-787950 与记事本 w-328856）时也自动拥有各自独立的琉璃小鼠标与气泡！
    const cursorAgentId = effectiveAgentId ||
        (effectiveWindowId
            ? `win-${effectiveWindowId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`
            : effectiveApp
                ? `app-${effectiveApp.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}`
                : undefined);
    const parsedTargetHwnd = parseWindowHandleFromId(effectiveWindowId);
    // 后台无头批量执行 (batch)：将每一步交由 executeAgentDesktopAction 顺序执行，支持 ref / ref_id / set_value / type / wait，
    // 确保每一步都走 Windows 后台遮挡透传引擎且实时驱动琉璃小鼠标平滑移动！
    if (action === 'batch' && !isHeaded) {
        if (!Array.isArray(args.batchCommands) || args.batchCommands.length === 0) {
            throw new Error('batch 动作必须提供非空的 batchCommands 数组');
        }
        const stepResults = [];
        let lastStepSnapId = agentState.lastSnapshotId || sessionState.lastSnapshotId;
        let anyStarCursor = false;
        let lastBubble;
        for (let idx = 0; idx < args.batchCommands.length; idx++) {
            const entry = args.batchCommands[idx];
            const rawCmd = String(entry?.command ?? '')
                .trim()
                .toLowerCase()
                .replace(/-/g, '_');
            const rawStepArgs = (entry?.args && typeof entry.args === 'object' ? entry.args : {});
            if (rawCmd === 'wait' && !rawStepArgs.ref && !rawStepArgs.ref_id && !rawStepArgs.text && !rawStepArgs.event) {
                const waitMs = Math.min(15000, Math.max(0, Number(rawStepArgs.ms ?? rawStepArgs.durationMs ?? rawStepArgs.timeoutMs ?? 200) || 200));
                await new Promise(r => setTimeout(r, waitMs));
                stepResults.push({ index: idx, command: 'wait', ok: true, waited_ms: waitMs });
                continue;
            }
            const stepRef = (rawStepArgs.ref ?? rawStepArgs.ref_id ?? rawStepArgs.element);
            const stepArgs = {
                ...rawStepArgs,
                action: rawCmd,
                ref: typeof stepRef === 'string' ? stepRef : undefined,
                app: (typeof rawStepArgs.app === 'string' && rawStepArgs.app.trim()) || effectiveApp || args.app,
                windowId: (typeof rawStepArgs.windowId === 'string' && rawStepArgs.windowId.trim()) ||
                    (typeof rawStepArgs.window_id === 'string' && rawStepArgs.window_id.trim()) ||
                    effectiveWindowId ||
                    args.windowId,
                agentId: (typeof rawStepArgs.agentId === 'string' && rawStepArgs.agentId.trim()) ||
                    (typeof rawStepArgs.agent_id === 'string' && rawStepArgs.agent_id.trim()) ||
                    effectiveAgentId,
                cursorLabel: (typeof rawStepArgs.cursorLabel === 'string' && rawStepArgs.cursorLabel.trim()) || args.cursorLabel,
                headed: false,
            };
            const stepRes = await executeAgentDesktopAction(stepArgs, ctx);
            if (stepRes.snapshotId)
                lastStepSnapId = stepRes.snapshotId;
            if (stepRes.starCursorActive)
                anyStarCursor = true;
            if (stepRes.chatBubbleText)
                lastBubble = stepRes.chatBubbleText;
            stepResults.push({
                index: idx,
                command: rawCmd,
                ok: stepRes.ok,
                summary: stepRes.summary,
                data: stepRes.data,
                ...(stepRes.error ? { error: stepRes.error } : {}),
            });
            if (!stepRes.ok) {
                return sanitizeLosslessJson({
                    ok: false,
                    action: 'batch',
                    sessionId: sessionState.sessionId,
                    snapshotId: lastStepSnapId,
                    deliveryMode,
                    starCursorActive: anyStarCursor,
                    chatBubbleText: lastBubble,
                    summary: `❌ [agent_desktop:batch] 在第 ${idx + 1}/${args.batchCommands.length} 步 (${rawCmd}) 失败: ${stepRes.error?.message || stepRes.summary}`,
                    data: {
                        completed_count: idx,
                        total_count: args.batchCommands.length,
                        results: stepResults,
                        entries: stepResults,
                    },
                    error: stepRes.error || { code: 'BATCH_STEP_FAILED', message: stepRes.summary },
                });
            }
            if (idx + 1 < args.batchCommands.length) {
                await new Promise(r => setTimeout(r, 32));
            }
        }
        return sanitizeLosslessJson({
            ok: true,
            action: 'batch',
            sessionId: sessionState.sessionId,
            snapshotId: lastStepSnapId,
            deliveryMode,
            starCursorActive: anyStarCursor,
            chatBubbleText: lastBubble,
            summary: `✅ [agent_desktop:batch] (后台无头透传 + ✨琉璃小鼠标气泡) 已顺序完成全部 ${stepResults.length} 步指令，未抢占前台窗口焦点`,
            data: {
                completed_count: stepResults.length,
                total_count: stepResults.length,
                results: stepResults,
                entries: stepResults,
            },
        });
    }
    const isPointCapableAction = action === 'click' ||
        action === 'double_click' ||
        action === 'triple_click' ||
        action === 'right_click' ||
        action === 'set_value' ||
        action === 'type' ||
        action === 'clear' ||
        action === 'toggle' ||
        action === 'check' ||
        action === 'uncheck' ||
        action === 'scroll' ||
        (action === 'select' && !args.value);
    // 若 @ref 来自 find（find 默认不带 bounds），自动通过 get --property bounds 补全屏幕坐标与矩形，确保琉璃小鼠标与后台透传精准落点
    if (qualifiedRef &&
        (isPointCapableAction || action === 'focus' || action === 'select') &&
        (refMeta?.centerX === undefined || refMeta?.centerY === undefined)) {
        try {
            const boundsRes = await runAgentDesktopCli([
                '--session',
                sessionState.sessionId,
                ...(effectiveAgentId ? ['--agent-id', effectiveAgentId] : []),
                'get',
                '--property',
                'bounds',
                qualifiedRef,
            ], {
                sessionId: sessionState.sessionId,
                agentId: effectiveAgentId,
                timeoutMs: 4000,
            });
            const bRaw = (boundsRes.envelope?.data?.value ??
                boundsRes.envelope?.data?.bounds ??
                boundsRes.envelope?.data);
            if (bRaw &&
                typeof bRaw.x === 'number' &&
                typeof bRaw.y === 'number' &&
                typeof bRaw.width === 'number' &&
                typeof bRaw.height === 'number') {
                const cx = Math.round(bRaw.x + bRaw.width / 2);
                const cy = Math.round(bRaw.y + bRaw.height / 2);
                const normB = {
                    x: Math.round(bRaw.x),
                    y: Math.round(bRaw.y),
                    width: Math.round(bRaw.width),
                    height: Math.round(bRaw.height),
                };
                const updatedMeta = {
                    ref: qualifiedRef,
                    role: refMeta?.role || 'element',
                    name: refMeta?.name || bareRefKey || qualifiedRef,
                    automationId: refMeta?.automationId,
                    windowId: refMeta?.windowId || effectiveWindowId,
                    app: refMeta?.app || effectiveApp,
                    centerX: cx,
                    centerY: cy,
                    bounds: normB,
                };
                refMeta = updatedMeta;
                sessionState.refMetaMap.set(qualifiedRef, updatedMeta);
                if (bareRefKey) {
                    sessionState.refMetaMap.set(bareRefKey, updatedMeta);
                    if (updatedMeta.windowId) {
                        sessionState.refMetaMap.set(`${updatedMeta.windowId}:${bareRefKey}`, updatedMeta);
                        sessionState.refMetaMap.set(`${updatedMeta.windowId}:@${bareRefKey}`, updatedMeta);
                    }
                }
            }
        }
        catch { }
    }
    // 支持通过 (x, y) 坐标自动反查目标窗口缓存的无障碍 @ref（按 effectiveWindowId / effectiveApp 过滤，避免误匹配其他遮挡窗口的控件）
    if (!qualifiedRef && isPointCapableAction && typeof args.x === 'number' && typeof args.y === 'number') {
        let matched = findBestRefAtPoint(args.x, args.y, 'default', {
            windowId: effectiveWindowId,
            app: effectiveApp,
        });
        if (!matched && (effectiveWindowId || effectiveApp)) {
            const autoSnapArgs = [
                '--session',
                sessionState.sessionId,
                ...(effectiveAgentId ? ['--agent-id', effectiveAgentId] : []),
                'snapshot',
                ...(effectiveWindowId ? ['--window-id', effectiveWindowId] : ['--app', effectiveApp]),
                '-i',
                '--compact',
                '--include-bounds',
            ];
            const snapRes = await runAgentDesktopCli(autoSnapArgs, {
                sessionId: sessionState.sessionId,
                agentId: effectiveAgentId,
                timeoutMs: 8000,
            });
            if (snapRes.envelope?.ok && snapRes.envelope.data) {
                const snapData = normalizeEnvelopeData('snapshot', snapRes.envelope.data);
                if (typeof snapData.snapshot_id === 'string' && snapData.snapshot_id.trim()) {
                    const sid = snapData.snapshot_id.trim();
                    agentState.lastSnapshotId = sid;
                    sessionState.lastSnapshotId = sid;
                    if (effectiveWindowId) {
                        sessionState.lastSnapshotByWindow.set(effectiveWindowId, sid);
                    }
                    sessionState.snapshotOwnerMap.set(sid, { windowId: effectiveWindowId, app: effectiveApp });
                    loadSnapshotRefMapFromDisk(sessionState.sessionId, sid, sessionState.refMetaMap, sessionState.snapshotOwnerMap);
                }
                summarizeAndCacheSnapshotTree(snapData, sessionState.refMetaMap, agentState.lastSnapshotId, {
                    windowId: effectiveWindowId,
                    app: effectiveApp,
                }, sessionState.sessionId, sessionState.snapshotOwnerMap);
                persistSessionState('default', sessionState);
                matched = findBestRefAtPoint(args.x, args.y, 'default', {
                    windowId: effectiveWindowId,
                    app: effectiveApp,
                });
            }
        }
        if (matched) {
            qualifiedRef = qualifyAgentDesktopRef(matched.ref, agentState.lastSnapshotId || sessionState.lastSnapshotId);
            refMeta = matched;
            if (!effectiveWindowId && matched.windowId)
                effectiveWindowId = matched.windowId;
            if (!effectiveApp && matched.app)
                effectiveApp = matched.app;
        }
    }
    const finalTargetHwnd = parseWindowHandleFromId(effectiveWindowId) ?? parsedTargetHwnd;
    const chatBubbleText = buildActionChatBubbleText({ ...args, app: effectiveApp || args.app }, qualifiedRef, refMeta);
    // 1. 迷你小鼠标显式开关
    if (action === 'cursor_enable') {
        await presentDesktopActionCursor({
            x: args.x ?? refMeta?.centerX,
            y: args.y ?? refMeta?.centerY,
            targetRect: refMeta?.bounds,
            bubbleText: chatBubbleText || 'Agent-Desktop · 小鼠标已唤醒',
            sessionId: sessionState.sessionId,
            agentId: cursorAgentId,
        });
        return sanitizeLosslessJson({
            ok: true,
            action,
            sessionId: sessionState.sessionId,
            deliveryMode,
            starCursorActive: true,
            chatBubbleText,
            summary: `✨ 已按需唤醒圆角三角形 3D 琉璃小鼠标与聊天气泡（"${chatBubbleText}"，空闲 ${CURSOR_IDLE_AUTO_HIDE_MS / 1000}s 后自动消失）`,
            data: {
                session_id: sessionState.sessionId,
                auto_hide_ms: CURSOR_IDLE_AUTO_HIDE_MS,
                label: chatBubbleText,
            },
        });
    }
    if (action === 'cursor_disable') {
        await hideDesktopActionCursor(sessionState.sessionId, cursorAgentId);
        if (!effectiveAgentId) {
            await hideDesktopActionCursor(sessionState.sessionId, undefined);
            for (const knownAgentKey of Array.from(lastCursorPosByAgent.keys())) {
                if (knownAgentKey !== 'default') {
                    await hideDesktopActionCursor(sessionState.sessionId, knownAgentKey);
                }
            }
        }
        sessionState.cursorEnabled = false;
        persistSessionState('default', sessionState);
        return sanitizeLosslessJson({
            ok: true,
            action,
            sessionId: sessionState.sessionId,
            deliveryMode,
            starCursorActive: false,
            summary: '已立即隐藏并关闭桌面迷你小鼠标覆盖层',
        });
    }
    // 在真正执行桌面交互动作时，仅当存在有效目标坐标时唤醒小鼠标与实时聊天气泡（并在操作后 10 秒无后续指令时自动消失）
    const isClickLike = action === 'click' ||
        action === 'double_click' ||
        action === 'triple_click' ||
        action === 'right_click' ||
        action === 'set_value' ||
        action === 'type' ||
        action === 'clear' ||
        action === 'select' ||
        action === 'toggle' ||
        action === 'check' ||
        action === 'uncheck';
    const hasExplicitXY = typeof args.x === 'number' && typeof args.y === 'number';
    const targetCursorX = args.x ?? refMeta?.centerX;
    const targetCursorY = args.y ?? refMeta?.centerY;
    const effectiveTargetRect = hasExplicitXY &&
        refMeta?.bounds &&
        (Math.abs(args.x - (refMeta.centerX ?? args.x)) > 24 ||
            Math.abs(args.y - (refMeta.centerY ?? args.y)) > 24)
        ? {
            x: Math.round(args.x - 110),
            y: Math.round(args.y - 16),
            width: 220,
            height: 32,
        }
        : refMeta?.bounds;
    if (chatBubbleText && typeof targetCursorX === 'number' && typeof targetCursorY === 'number') {
        await presentDesktopActionCursor({
            x: targetCursorX,
            y: targetCursorY,
            targetRect: effectiveTargetRect,
            bubbleText: chatBubbleText,
            isClick: isClickLike,
            sessionId: sessionState.sessionId,
            agentId: cursorAgentId,
        });
    }
    // Windows 下后台无感调整窗口位置与大小（SWP_NOZORDER | SWP_NOACTIVATE，绝不改变窗口层级或抢占焦点）
    if (process.platform === 'win32' &&
        !isHeaded &&
        (action === 'move_window' || action === 'resize_window')) {
        const bgWinOp = await executeWindowsBackgroundPointActionAsync({
            action: action === 'move_window' ? 'move_window_background' : 'resize_window_background',
            x: args.x,
            y: args.y,
            width: args.width,
            height: args.height,
            hasExplicitCoord: typeof args.x === 'number' && typeof args.y === 'number',
            app: effectiveApp,
            windowHandle: finalTargetHwnd,
        });
        return sanitizeLosslessJson({
            ok: bgWinOp.ok,
            action,
            sessionId: sessionState.sessionId,
            snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
            deliveryMode,
            starCursorActive: false,
            summary: `✅ [agent_desktop:${action}] 已在后台调整目标窗口 (${bgWinOp.windowTitle || effectiveApp || effectiveWindowId || '当前窗口'})，未改变窗口 Z 序且未抢占用户前台窗口焦点 (${bgWinOp.detail})`,
            data: {
                background_mode: true,
                method: bgWinOp.method,
                detail: bgWinOp.detail,
                app: effectiveApp,
                window_id: effectiveWindowId,
                hwnd: bgWinOp.hwnd,
                window_title: bgWinOp.windowTitle,
            },
        });
    }
    // Windows 下后台无感就绪窗口（拦截 focus_window / restore / focus，仅在窗口最小化时通过 SW_SHOWNOACTIVATE 恢复，绝不改变 Z 序或抢占前台焦点）
    if (process.platform === 'win32' &&
        !isHeaded &&
        (action === 'focus_window' || action === 'restore' || action === 'focus')) {
        const bgFocus = await executeWindowsBackgroundPointActionAsync({
            action: action === 'focus' ? 'focus_no_activate' : 'restore_no_activate',
            x: targetCursorX,
            y: targetCursorY,
            hasExplicitCoord: typeof targetCursorX === 'number' && typeof targetCursorY === 'number',
            app: effectiveApp,
            windowHandle: finalTargetHwnd,
        });
        if (bgFocus.hwnd && bgFocus.hwnd > 0 && !effectiveWindowId) {
            effectiveWindowId = `w-${bgFocus.hwnd}`;
            agentState.lastWindowId = effectiveWindowId;
            sessionState.lastWindowId = effectiveWindowId;
        }
        return sanitizeLosslessJson({
            ok: bgFocus.ok,
            action,
            sessionId: sessionState.sessionId,
            snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
            deliveryMode,
            starCursorActive: Boolean(chatBubbleText && typeof targetCursorX === 'number'),
            chatBubbleText,
            summary: `✅ [agent_desktop:${action}] 已在后台锁定目标窗口 (${bgFocus.windowTitle || effectiveApp || effectiveWindowId || '当前目标'})，未改变窗口 Z 序且未抢占用户前台窗口焦点 (${bgFocus.detail})`,
            data: {
                background_mode: true,
                method: bgFocus.method,
                detail: bgFocus.detail,
                app: effectiveApp,
                window_id: effectiveWindowId,
                hwnd: bgFocus.hwnd,
                window_title: bgFocus.windowTitle,
            },
        });
    }
    // Windows 下后台无感启动/附着应用（若目标应用已打开则直接后台附着；若未打开则后台启动，绝不弹窗抢焦点）
    if (process.platform === 'win32' && !isHeaded && action === 'launch') {
        const targetApp = args.app?.trim() || effectiveApp;
        if (!targetApp) {
            throw new Error('launch 动作必须提供 app 参数（应用名称或可执行路径）');
        }
        const bgLaunch = await executeWindowsBackgroundPointActionAsync({
            action: 'launch_background',
            app: targetApp,
            windowHandle: finalTargetHwnd,
        });
        invalidateWindowsWindowListCache();
        const resolvedAfter = await resolveWindowsWindowByApp(sessionState.sessionId, targetApp, effectiveAgentId);
        const finalWinId = resolvedAfter?.id || (bgLaunch.hwnd && bgLaunch.hwnd > 0 ? `w-${bgLaunch.hwnd}` : effectiveWindowId);
        if (finalWinId) {
            agentState.lastWindowId = finalWinId;
            sessionState.lastWindowId = finalWinId;
        }
        if (resolvedAfter?.app) {
            agentState.lastApp = resolvedAfter.app;
            sessionState.lastApp = resolvedAfter.app;
        }
        persistSessionState('default', sessionState);
        return sanitizeLosslessJson({
            ok: bgLaunch.ok || Boolean(resolvedAfter?.id),
            action,
            sessionId: sessionState.sessionId,
            snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
            deliveryMode,
            starCursorActive: false,
            summary: `✅ [agent_desktop:launch] 已在后台就绪应用 "${resolvedAfter?.title || bgLaunch.windowTitle || targetApp}" (windowId=${finalWinId || 'N/A'}, method=${bgLaunch.method})，未抢占用户前台窗口焦点`,
            data: {
                background_mode: true,
                method: bgLaunch.method,
                app: resolvedAfter?.app || targetApp,
                window_id: finalWinId,
                title: resolvedAfter?.title || bgLaunch.windowTitle,
                hwnd: bgLaunch.hwnd ?? resolvedAfter?.hwnd,
            },
        });
    }
    // Windows 后台遮挡穿透优先执行：
    // 无论传入的是 @ref 还是 (x, y)，在 Windows 后台模式 (!isHeaded) 下均优先通过 GhostPawWin32BgV4（UWP CoreWindow 零激活按键 + 句柄作用域 UIA 穿透 + EnumChildWindows 深度子句柄 EM_REPLACESEL/PostMessageW）执行！
    // 这样既彻底绕过 agent-desktop.exe 的全局 interaction.lock 串行锁与 occluded 遮挡报错，又保证 100% 零 SetFocus / 零 SetForegroundWindow / 零 Z 序变动！
    if (process.platform === 'win32' &&
        !isHeaded &&
        isPointCapableAction &&
        !args.waitFor &&
        !args.waitForGone &&
        ((typeof targetCursorX === 'number' && typeof targetCursorY === 'number') ||
            Boolean(finalTargetHwnd || effectiveApp || refMeta?.name || refMeta?.automationId))) {
        const bgActionMap = {
            click: 'left_click',
            double_click: 'double_click',
            triple_click: 'triple_click',
            right_click: 'right_click',
            set_value: 'set_value',
            type: 'type',
            clear: 'clear',
            toggle: 'toggle',
            check: 'check',
            uncheck: 'uncheck',
            scroll: 'scroll',
        };
        const bgRes = await executeWindowsBackgroundPointActionAsync({
            action: bgActionMap[action] || 'left_click',
            x: targetCursorX,
            y: targetCursorY,
            hasExplicitCoord: typeof targetCursorX === 'number' && typeof targetCursorY === 'number',
            text: String(args.text ?? args.value ?? ''),
            clearFirst: action === 'set_value' || action === 'clear',
            direction: args.direction,
            amount: args.amount,
            app: effectiveApp,
            windowHandle: finalTargetHwnd,
            elementName: refMeta?.name || args.name,
            elementRole: refMeta?.role || args.role,
            automationId: refMeta?.automationId,
        });
        if (bgRes.ok) {
            return sanitizeLosslessJson({
                ok: true,
                action,
                sessionId: sessionState.sessionId,
                snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
                deliveryMode,
                starCursorActive: Boolean(chatBubbleText && typeof targetCursorX === 'number'),
                chatBubbleText,
                summary: `✅ [agent_desktop:${action}] (Windows 后台遮挡透传 ${qualifiedRef || `@(${targetCursorX ?? 'N/A'},${targetCursorY ?? 'N/A'})`} + ✨琉璃小鼠标气泡) 执行成功 [${bgRes.method}: ${bgRes.detail}]`,
                data: {
                    ...(qualifiedRef ? { ref: qualifiedRef } : {}),
                    ...(typeof targetCursorX === 'number' ? { x: targetCursorX } : {}),
                    ...(typeof targetCursorY === 'number' ? { y: targetCursorY } : {}),
                    window_id: effectiveWindowId,
                    app: effectiveApp,
                    method: bgRes.method,
                    detail: bgRes.detail,
                    hwnd: bgRes.hwnd,
                    window_title: bgRes.windowTitle,
                    element_name: bgRes.elementName || refMeta?.name,
                    element_role: bgRes.elementRole || refMeta?.role,
                    automation_id: bgRes.automationId || refMeta?.automationId,
                },
            });
        }
    }
    // 2. 窗口/屏幕无感截图（返回多模态图片附件）
    if (action === 'screenshot') {
        const shotPath = join(tmpdir(), `ghostpaw-shot-${Date.now()}.png`);
        const cliArgs = [...buildGlobalCliOptions(sessionState.sessionId, { ...args, agentId: effectiveAgentId }), 'screenshot'];
        if (effectiveWindowId) {
            cliArgs.push('--window-id', effectiveWindowId);
        }
        else if (effectiveApp) {
            cliArgs.push('--app', effectiveApp);
        }
        cliArgs.push(shotPath);
        const res = await runAgentDesktopCli(cliArgs, { sessionId: sessionState.sessionId, agentId: effectiveAgentId });
        if (res.envelope?.ok && existsSync(shotPath)) {
            const pngBytes = readFileSync(shotPath);
            let imageRef;
            try {
                const anyCtx = ctx;
                const attachments = typeof anyCtx?.get === 'function' ? anyCtx.get('attachments') : undefined;
                if (attachments && typeof attachments.saveImage === 'function') {
                    const saved = await attachments.saveImage({
                        data: pngBytes,
                        mediaType: 'image/png',
                        name: 'agent-desktop-window.png',
                    });
                    if (saved && typeof saved.attachmentId === 'string') {
                        imageRef = saved;
                    }
                }
            }
            catch { }
            return sanitizeLosslessJson({
                ok: true,
                action,
                sessionId: sessionState.sessionId,
                snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
                deliveryMode,
                starCursorActive: false,
                summary: `📸 已完成无感窗口截图 (${effectiveApp || effectiveWindowId || '当前屏幕'}) -> ${shotPath}`,
                data: normalizeEnvelopeData(action, res.envelope.data),
                screenshotPath: shotPath,
                ...(imageRef ? { imageAttachment: imageRef } : {}),
            });
        }
        return formatCliFailure(action, sessionState, deliveryMode, res);
    }
    // 3. 构建各子命令的 CLI 参数
    const globalFlags = buildGlobalCliOptions(sessionState.sessionId, { ...args, agentId: effectiveAgentId }, isHeaded);
    let cliArgs = [];
    let stdinText;
    switch (action) {
        case 'status':
            cliArgs = [...globalFlags, 'status'];
            break;
        case 'permissions':
            cliArgs = [...globalFlags, 'permissions'];
            if (args.requestPermission)
                cliArgs.push('--request');
            break;
        case 'list_apps':
            cliArgs = [...globalFlags, 'list-apps'];
            if (args.app?.trim())
                cliArgs.push('--app', args.app.trim());
            break;
        case 'list_windows':
            cliArgs = [...globalFlags, 'list-windows'];
            // Windows 下不向 CLI 传原始 --app（因 "calc.exe"/"记事本" 会被单语过滤丢弃），改由返回后做双语别名匹配
            if (args.app?.trim() && process.platform !== 'win32') {
                cliArgs.push('--app', args.app.trim());
            }
            break;
        case 'list_displays':
            cliArgs = [...globalFlags, 'list-displays'];
            break;
        case 'list_surfaces':
            cliArgs = [...globalFlags, 'list-surfaces'];
            if (effectiveWindowId)
                cliArgs.push('--window-id', effectiveWindowId);
            else if (effectiveApp)
                cliArgs.push('--app', effectiveApp);
            break;
        case 'open_system_surface':
            cliArgs = [...globalFlags, 'open-system-surface', '--surface', args.surface?.trim() || 'start-menu'];
            break;
        case 'snapshot': {
            cliArgs = [...globalFlags, 'snapshot'];
            if (effectiveWindowId) {
                cliArgs.push('--window-id', effectiveWindowId);
            }
            else if (effectiveApp) {
                cliArgs.push('--app', effectiveApp);
            }
            if (args.surface?.trim()) {
                cliArgs.push('--surface', args.surface.trim());
            }
            if (args.rootRef?.trim()) {
                cliArgs.push('--root', qualifyAgentDesktopRef(args.rootRef, agentState.lastSnapshotId || sessionState.lastSnapshotId));
            }
            if (args.interactiveOnly !== false) {
                cliArgs.push('-i');
            }
            if (args.compact !== false) {
                cliArgs.push('--compact');
            }
            if (args.skeleton === true) {
                cliArgs.push('--skeleton');
            }
            if (args.includeBounds !== false) {
                cliArgs.push('--include-bounds');
            }
            if (typeof args.maxDepth === 'number' && args.maxDepth > 0) {
                cliArgs.push('--max-depth', String(Math.round(args.maxDepth)));
            }
            if (typeof args.timeoutMs === 'number' && args.timeoutMs > 0) {
                cliArgs.push('--timeout-ms', String(Math.round(args.timeoutMs)));
            }
            break;
        }
        case 'find': {
            cliArgs = [...globalFlags, 'find'];
            if (effectiveWindowId) {
                cliArgs.push('--window-id', effectiveWindowId);
            }
            else if (effectiveApp) {
                cliArgs.push('--app', effectiveApp);
            }
            if (args.role?.trim())
                cliArgs.push('--role', args.role.trim());
            if (args.name?.trim())
                cliArgs.push('--name', args.name.trim());
            if (args.text?.trim())
                cliArgs.push('--text', args.text.trim());
            if (args.value?.trim())
                cliArgs.push('--value', args.value.trim());
            if (args.exact)
                cliArgs.push('--exact');
            if (args.first)
                cliArgs.push('--first');
            if (args.rootRef?.trim()) {
                cliArgs.push('--root', qualifyAgentDesktopRef(args.rootRef, agentState.lastSnapshotId || sessionState.lastSnapshotId));
            }
            break;
        }
        case 'get':
            if (!qualifiedRef)
                throw new Error('get 动作必须提供 ref 参数（如 "@s1a2b3c4:e1" 或 "e1"）');
            cliArgs = [...globalFlags, 'get', '--property', args.property?.trim() || 'text', qualifiedRef];
            break;
        case 'is':
            if (!qualifiedRef)
                throw new Error('is 动作必须提供 ref 参数（如 "@s1a2b3c4:e1" 或 "e1"）');
            cliArgs = [...globalFlags, 'is', '--property', args.property?.trim() || 'visible', qualifiedRef];
            break;
        case 'click':
        case 'double_click':
        case 'triple_click':
        case 'right_click':
        case 'clear':
        case 'focus':
        case 'toggle':
        case 'check':
        case 'uncheck':
        case 'expand':
        case 'collapse':
        case 'scroll_to': {
            if (!qualifiedRef) {
                throw new Error(`${action} 动作必须提供 ref 参数（来自 snapshot 或 find 的 @<snapshot_id>:e<N>）或目标 (x, y) 坐标`);
            }
            const subCmd = action.replace(/_/g, '-');
            cliArgs = [...globalFlags, subCmd, qualifiedRef];
            break;
        }
        case 'set_value': {
            if (!qualifiedRef)
                throw new Error('set_value 动作必须提供 ref 参数或目标 (x, y) 坐标');
            stdinText = String(args.value ?? args.text ?? '');
            cliArgs = [...globalFlags, 'set-value', qualifiedRef, '--stdin'];
            break;
        }
        case 'type': {
            if (!qualifiedRef)
                throw new Error('type 动作必须提供 ref 参数或目标 (x, y) 坐标');
            stdinText = String(args.text ?? args.value ?? '');
            if (process.platform === 'win32' && !isHeaded) {
                cliArgs = [...globalFlags, 'set-value', qualifiedRef, '--stdin'];
            }
            else {
                cliArgs = [...globalFlags, 'type', qualifiedRef, '--stdin'];
            }
            break;
        }
        case 'select': {
            if (!qualifiedRef)
                throw new Error('select 动作必须提供 ref 参数');
            const optionValue = String(args.value ?? args.text ?? '').trim();
            if (!optionValue)
                throw new Error('select 动作必须提供 value 或 text 参数指定选项');
            cliArgs = [...globalFlags, 'select', qualifiedRef, optionValue];
            break;
        }
        case 'scroll': {
            if (!qualifiedRef)
                throw new Error('scroll 动作必须提供 ref 参数或目标 (x, y) 坐标');
            cliArgs = [
                ...globalFlags,
                'scroll',
                qualifiedRef,
                '--direction',
                args.direction || 'down',
                '--amount',
                String(args.amount ?? 3),
            ];
            break;
        }
        case 'press': {
            const combo = String(args.key ?? args.text ?? '').trim();
            if (!combo)
                throw new Error('press 动作必须提供 key 参数（如 "return", "escape", "ctrl+s", "cmd+c"）');
            if (process.platform === 'win32' && !isHeaded) {
                const bgKey = await executeWindowsBackgroundPointActionAsync({
                    action: combo.includes('+') ? 'hotkey' : 'key',
                    key: combo,
                    x: targetCursorX,
                    y: targetCursorY,
                    hasExplicitCoord: typeof targetCursorX === 'number' && typeof targetCursorY === 'number',
                    app: effectiveApp,
                    windowHandle: finalTargetHwnd,
                });
                return sanitizeLosslessJson({
                    ok: bgKey.ok,
                    action,
                    sessionId: sessionState.sessionId,
                    snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
                    deliveryMode,
                    starCursorActive: Boolean(chatBubbleText && typeof targetCursorX === 'number'),
                    chatBubbleText,
                    summary: `✅ [agent_desktop:press] 已在后台向目标窗口透传投递按键 [${combo}] (${bgKey.detail})`,
                    data: {
                        key: combo,
                        method: bgKey.method,
                        detail: bgKey.detail,
                        hwnd: bgKey.hwnd,
                    },
                });
            }
            cliArgs = [...globalFlags, 'press'];
            if (effectiveWindowId)
                cliArgs.push('--window-id', effectiveWindowId);
            else if (effectiveApp)
                cliArgs.push('--app', effectiveApp);
            if (args.force)
                cliArgs.push('--force');
            cliArgs.push(combo);
            break;
        }
        case 'launch': {
            const targetApp = args.app?.trim();
            if (!targetApp)
                throw new Error('launch 动作必须提供 app 参数（应用名称或可执行路径）');
            cliArgs = [...globalFlags, 'launch', targetApp];
            if (typeof args.timeoutMs === 'number' && args.timeoutMs > 0) {
                cliArgs.push('--timeout', String(Math.round(args.timeoutMs)));
            }
            break;
        }
        case 'close_app': {
            const targetApp = effectiveApp;
            if (!targetApp)
                throw new Error('close_app 动作必须提供 app 参数');
            cliArgs = [...globalFlags, 'close-app', targetApp];
            if (args.force)
                cliArgs.push('--force');
            break;
        }
        case 'focus_window':
        case 'minimize':
        case 'maximize':
        case 'restore': {
            const subCmd = action.replace(/_/g, '-');
            cliArgs = [...globalFlags, subCmd];
            if (effectiveWindowId)
                cliArgs.push('--window-id', effectiveWindowId);
            else if (effectiveApp)
                cliArgs.push('--app', effectiveApp);
            break;
        }
        case 'resize_window': {
            if (typeof args.width !== 'number' || typeof args.height !== 'number') {
                throw new Error('resize_window 动作必须提供 width 与 height 参数');
            }
            cliArgs = [
                ...globalFlags,
                'resize-window',
                '--width',
                String(Math.round(args.width)),
                '--height',
                String(Math.round(args.height)),
            ];
            if (effectiveWindowId)
                cliArgs.push('--window-id', effectiveWindowId);
            else if (effectiveApp)
                cliArgs.push('--app', effectiveApp);
            break;
        }
        case 'move_window': {
            if (typeof args.x !== 'number' || typeof args.y !== 'number') {
                throw new Error('move_window 动作必须提供 x 与 y 参数');
            }
            cliArgs = [
                ...globalFlags,
                'move-window',
                `--x=${Math.round(args.x)}`,
                `--y=${Math.round(args.y)}`,
            ];
            if (effectiveWindowId)
                cliArgs.push('--window-id', effectiveWindowId);
            else if (effectiveApp)
                cliArgs.push('--app', effectiveApp);
            break;
        }
        case 'wait': {
            cliArgs = [...globalFlags, 'wait'];
            if (qualifiedRef) {
                cliArgs.push('--element', qualifiedRef);
                if (args.predicate)
                    cliArgs.push('--predicate', args.predicate);
                if (args.value !== undefined)
                    cliArgs.push('--value', args.value);
            }
            else if (args.text?.trim()) {
                cliArgs.push('--text', args.text.trim());
            }
            else if (args.event?.trim()) {
                cliArgs.push('--event', args.event.trim());
            }
            else {
                cliArgs.push(String(Math.round(args.timeoutMs ?? 1000)));
            }
            if (effectiveApp)
                cliArgs.push('--app', effectiveApp);
            if (effectiveWindowId)
                cliArgs.push('--window-id', effectiveWindowId);
            if (typeof args.timeoutMs === 'number' && args.timeoutMs > 0 && (qualifiedRef || args.text || args.event)) {
                cliArgs.push('--timeout', String(Math.round(args.timeoutMs)));
            }
            break;
        }
        case 'clipboard_get':
            cliArgs = [...globalFlags, 'clipboard-get'];
            break;
        case 'clipboard_set':
            stdinText = String(args.text ?? args.value ?? '');
            cliArgs = [...globalFlags, 'clipboard-set', '--stdin'];
            break;
        case 'clipboard_clear':
            cliArgs = [...globalFlags, 'clipboard-clear'];
            break;
        case 'batch': {
            if (!Array.isArray(args.batchCommands) || args.batchCommands.length === 0) {
                throw new Error('batch 动作必须提供非空的 batchCommands 数组');
            }
            cliArgs = [...globalFlags, 'batch', '--stop-on-error', JSON.stringify(args.batchCommands)];
            break;
        }
        default:
            throw new Error(`未知的 agent_desktop 动作: ${String(action)}`);
    }
    let res = await runAgentDesktopCli(cliArgs, {
        stdinText,
        sessionId: sessionState.sessionId,
        agentId: effectiveAgentId,
        timeoutMs: Math.max(35000, (args.timeoutMs ?? 0) + 10000),
    });
    // Windows 下若目标窗口处于最小化状态导致报错 WINDOW_MINIMIZED，自动通过 SW_SHOWNOACTIVATE 在后台无感恢复并重试，不抢夺用户前台窗口
    if (process.platform === 'win32' &&
        !isHeaded &&
        res.envelope?.ok === false &&
        res.envelope.error?.code === 'WINDOW_MINIMIZED') {
        await executeWindowsBackgroundPointActionAsync({
            action: 'restore_no_activate',
            app: effectiveApp,
            windowHandle: finalTargetHwnd,
        });
        res = await runAgentDesktopCli(cliArgs, {
            stdinText,
            sessionId: sessionState.sessionId,
            agentId: effectiveAgentId,
            timeoutMs: Math.max(35000, (args.timeoutMs ?? 0) + 10000),
        });
    }
    if (action === 'type' &&
        !isHeaded &&
        res.envelope?.ok === false &&
        (res.envelope.error?.code === 'UNSUPPORTED_ACTION' || res.envelope.error?.code === 'POLICY_DENIED') &&
        qualifiedRef) {
        res = await runAgentDesktopCli([...globalFlags, 'set-value', qualifiedRef, '--stdin'], {
            stdinText,
            sessionId: sessionState.sessionId,
            agentId: effectiveAgentId,
        });
    }
    // Windows 下若 CLI 语义动作失败，自动回退到后台句柄透传引擎，绝不抢占物理鼠标
    if (process.platform === 'win32' &&
        !isHeaded &&
        !res.envelope?.ok &&
        isPointCapableAction &&
        ((typeof targetCursorX === 'number' && typeof targetCursorY === 'number') ||
            Boolean(finalTargetHwnd || effectiveApp || refMeta?.name))) {
        const bgActionMap = {
            click: 'left_click',
            double_click: 'double_click',
            triple_click: 'triple_click',
            right_click: 'right_click',
            set_value: 'set_value',
            type: 'type',
            clear: 'clear',
            toggle: 'toggle',
            check: 'check',
            uncheck: 'uncheck',
            scroll: 'scroll',
        };
        const bgFallback = await executeWindowsBackgroundPointActionAsync({
            action: bgActionMap[action] || 'left_click',
            x: targetCursorX,
            y: targetCursorY,
            hasExplicitCoord: typeof targetCursorX === 'number' && typeof targetCursorY === 'number',
            text: String(args.text ?? args.value ?? ''),
            clearFirst: action === 'set_value' || action === 'clear',
            direction: args.direction,
            amount: args.amount,
            app: effectiveApp,
            windowHandle: finalTargetHwnd,
            elementName: refMeta?.name || args.name,
            elementRole: refMeta?.role || args.role,
            automationId: refMeta?.automationId,
        });
        if (bgFallback.ok) {
            return sanitizeLosslessJson({
                ok: true,
                action,
                sessionId: sessionState.sessionId,
                snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
                deliveryMode,
                starCursorActive: Boolean(chatBubbleText),
                chatBubbleText,
                summary: `✅ [agent_desktop:${action}] (Windows 后台句柄透传自动兜底 @(${targetCursorX ?? 'N/A'},${targetCursorY ?? 'N/A'}) + ✨琉璃小鼠标气泡) 执行成功 [${bgFallback.method}: ${bgFallback.detail}]`,
                data: {
                    ref: qualifiedRef,
                    x: targetCursorX,
                    y: targetCursorY,
                    method: bgFallback.method,
                    detail: bgFallback.detail,
                    hwnd: bgFallback.hwnd,
                },
            });
        }
    }
    if (!res.envelope?.ok) {
        return formatCliFailure(action, sessionState, deliveryMode, res);
    }
    let data = normalizeEnvelopeData(action, res.envelope.data);
    if (typeof data.snapshot_id === 'string' && data.snapshot_id.trim()) {
        const sid = data.snapshot_id.trim();
        agentState.lastSnapshotId = sid;
        sessionState.lastSnapshotId = sid;
        if (effectiveWindowId) {
            sessionState.lastSnapshotByWindow.set(effectiveWindowId, sid);
        }
        sessionState.snapshotOwnerMap.set(sid, { windowId: effectiveWindowId, app: effectiveApp });
        loadSnapshotRefMapFromDisk(sessionState.sessionId, sid, sessionState.refMetaMap, sessionState.snapshotOwnerMap);
    }
    // 若动作返回了目标控件的最新 bounds，同步刷新小鼠标位置与气泡计时器
    const returnedBounds = (data.bounds ?? data.element?.bounds);
    if (chatBubbleText &&
        returnedBounds &&
        typeof returnedBounds.x === 'number' &&
        typeof returnedBounds.y === 'number' &&
        typeof returnedBounds.width === 'number' &&
        typeof returnedBounds.height === 'number') {
        await presentDesktopActionCursor({
            x: Math.round(returnedBounds.x + returnedBounds.width / 2),
            y: Math.round(returnedBounds.y + returnedBounds.height / 2),
            targetRect: {
                x: Math.round(returnedBounds.x),
                y: Math.round(returnedBounds.y),
                width: Math.round(returnedBounds.width),
                height: Math.round(returnedBounds.height),
            },
            bubbleText: chatBubbleText,
            isClick: isClickLike,
            sessionId: sessionState.sessionId,
            agentId: cursorAgentId,
        });
    }
    let summary = `✅ [agent_desktop:${action}] (${deliveryMode === 'headless-semantic-star-cursor' ? '后台无头无感 + ✨琉璃小鼠标气泡' : '前台模式'}) 执行成功`;
    if (action === 'list_windows') {
        const rawWins = Array.isArray(data.windows)
            ? data.windows
            : [];
        const allWins = rawWins.map(w => {
            const appVal = (typeof w.app === 'string' && w.app.trim()) ||
                (typeof w.app_name === 'string' && w.app_name.trim()) ||
                undefined;
            return appVal && !w.app ? { ...w, app: appVal } : w;
        });
        if (process.platform === 'win32' && allWins.length > 0) {
            windowsListCache = { ts: Date.now(), list: allWins };
        }
        const filteredWins = process.platform === 'win32' && args.app?.trim()
            ? allWins.filter(w => matchWindowsAppCandidate(args.app, {
                id: typeof w.id === 'string' ? w.id : undefined,
                app: (typeof w.app === 'string' && w.app) ||
                    (typeof w.app_name === 'string' && w.app_name) ||
                    undefined,
                title: typeof w.title === 'string' ? w.title : undefined,
            }))
            : allWins;
        const finalWins = filteredWins.length > 0 ? filteredWins : allWins;
        data = {
            windows: finalWins,
            items: finalWins,
            count: finalWins.length,
        };
        const winPreview = finalWins.slice(0, 40).map(w => {
            const b = w.bounds;
            const bStr = b && typeof b.x === 'number' ? ` @(${b.x},${b.y} ${b.width}x${b.height})` : '';
            return `  - [${String(w.id ?? '')}] app="${String(w.app ?? '')}" title="${String(w.title ?? '')}"${bStr}`;
        });
        summary = [
            `${summary} | 共枚举到 ${finalWins.length} 个桌面窗口:`,
            ...(winPreview.length > 0 ? winPreview : ['  (当前无可见应用窗口)']),
        ].join('\n');
    }
    else if (action === 'snapshot' || action === 'find') {
        const activeSnapId = agentState.lastSnapshotId || sessionState.lastSnapshotId;
        if (activeSnapId) {
            loadSnapshotRefMapFromDisk(sessionState.sessionId, activeSnapId, sessionState.refMetaMap, sessionState.snapshotOwnerMap);
        }
        const stats = summarizeAndCacheSnapshotTree(data, sessionState.refMetaMap, activeSnapId, {
            windowId: effectiveWindowId,
            app: effectiveApp,
        }, sessionState.sessionId, sessionState.snapshotOwnerMap);
        persistSessionState('default', sessionState);
        const snapId = activeSnapId ? `@${activeSnapId}` : '';
        summary = [
            `${summary} | 快照标识: ${snapId || 'N/A'} | 节点数: ${stats.totalNodes}`,
            ...(stats.interactivePreview.length > 0
                ? [`可交互引用预览 (前 ${stats.interactivePreview.length} 项):`, ...stats.interactivePreview.map(item => `  - ${item}`)]
                : []),
        ].join('\n');
    }
    else if (qualifiedRef) {
        summary += ` | 目标引用: ${qualifiedRef}${chatBubbleText ? ` | 气泡: "${chatBubbleText}"` : ''}`;
    }
    return sanitizeLosslessJson({
        ok: true,
        action,
        sessionId: sessionState.sessionId,
        snapshotId: agentState.lastSnapshotId || sessionState.lastSnapshotId,
        deliveryMode,
        starCursorActive: Boolean(chatBubbleText && (typeof targetCursorX === 'number' || returnedBounds)),
        chatBubbleText,
        summary,
        data,
    });
}
function formatCliFailure(action, sessionState, deliveryMode, res) {
    const errObj = res.envelope?.error;
    const code = errObj?.code || 'CLI_ERROR';
    const message = errObj?.message || res.stderr || res.stdout || `exitCode=${res.exitCode}`;
    const suggestion = errObj?.suggestion;
    const normalizedData = res.envelope?.data !== undefined ? normalizeEnvelopeData(action, res.envelope.data) : undefined;
    return sanitizeLosslessJson({
        ok: false,
        action,
        sessionId: sessionState.sessionId,
        snapshotId: sessionState.lastSnapshotId,
        deliveryMode,
        starCursorActive: false,
        summary: `❌ [agent_desktop:${action}] 失败 (${code}): ${message}${suggestion ? `\n💡 建议: ${suggestion}` : ''}`,
        error: {
            code,
            message,
            suggestion,
        },
        ...(normalizedData ? { data: normalizedData } : {}),
    });
}
function unregisterToolSafely(ctx, toolName) {
    try {
        const anyTools = ctx.tools;
        anyTools?._tools?.delete?.(toolName);
        anyTools?.layers?.global?.tools?.data?.delete?.(toolName);
        if (anyTools?.layers && typeof anyTools.layers === 'object') {
            for (const layer of Object.values(anyTools.layers)) {
                layer?.tools?.data?.delete?.(toolName);
            }
        }
    }
    catch { }
}
;
globalThis.__ghostPawDesktopRuntime = {
    executeAgentDesktopAction,
    executeWindowsBackgroundPointAction,
    findBestRefAtPoint,
    matchWindowsAppCandidate,
    presentDesktopActionCursor,
    sanitizeLosslessJson,
};
/**
 * 向 Cordis 宿主注册 `agent_desktop` 工具
 */
export function applyAgentDesktopTool(ctx) {
    unregisterToolSafely(ctx, 'agent_desktop');
    ctx.tools.register({
        name: 'agent_desktop',
        description: [
            '操作系统级无头无感桌面自动化与专属迷你小鼠标工具（基于 vercel-labs/agent-desktop 无障碍树引擎 + 圆角三角形 3D 琉璃小鼠标与实时聊天气泡覆盖层）。',
            '【核心优势：不抢用户鼠标、不抢前台焦点、遮挡窗口句柄透传、按需显示操作气泡、空闲 10 秒自动隐身】：',
            '1. 默认采用 100% 后台无头语义与句柄透传执行（`headed: false`），直接通过目标窗口句柄作用域 UIA 与子窗口消息透传操作目标软件（即使目标窗口被其他窗口完全遮挡也能精准透传点击与输入），绝不移动用户的真实物理鼠标，绝不改变窗口 Z 序或抢夺用户正在使用的前台窗口焦点；',
            '2. 仅在实际执行桌面操作时唤醒「圆角三角形 3D 琉璃小鼠标」，并在鼠标旁显示实时聊天气泡（如 "Agent-Desktop · 正在点击「保存」"），操作结束 10 秒无后续指令后自动隐身销毁；',
            '3. 标准工作流（Observe -> Ref -> Act -> Verify）：先调用 `list_windows` 或 `snapshot(app="应用名")` 获取带 `@<snapshot_id>:e<N>` 的控件树，再用 `click` / `set_value` / `select` / `press` 操作对应 `ref`，最后用 `wait` 或 `snapshot` 验证结果。',
        ].join('\n'),
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'status',
                        'permissions',
                        'list_apps',
                        'list_windows',
                        'list_displays',
                        'list_surfaces',
                        'open_system_surface',
                        'snapshot',
                        'find',
                        'get',
                        'is',
                        'screenshot',
                        'click',
                        'double_click',
                        'triple_click',
                        'right_click',
                        'set_value',
                        'type',
                        'clear',
                        'focus',
                        'select',
                        'toggle',
                        'check',
                        'uncheck',
                        'expand',
                        'collapse',
                        'scroll',
                        'scroll_to',
                        'press',
                        'launch',
                        'close_app',
                        'focus_window',
                        'resize_window',
                        'move_window',
                        'minimize',
                        'maximize',
                        'restore',
                        'wait',
                        'clipboard_get',
                        'clipboard_set',
                        'clipboard_clear',
                        'batch',
                        'cursor_enable',
                        'cursor_disable',
                    ],
                    description: '要执行的桌面无障碍动作',
                },
                app: {
                    type: 'string',
                    description: '目标应用名称或 Bundle ID（如 "Notepad", "Finder", "WPS Office", "微信"）',
                },
                windowId: {
                    type: 'string',
                    description: '目标窗口 ID（来自 list_windows 返回的 id，如 "w_1234"）',
                },
                ref: {
                    type: 'string',
                    description: '控件无障碍引用 ID（来自 snapshot 或 find 返回的 `@<snapshot_id>:e<N>`，如 "@s8f3k2p9:e5"）',
                },
                text: {
                    type: 'string',
                    description: '输入文本或检索文本（用于 set_value / type / select / find / wait / clipboard_set）',
                },
                value: {
                    type: 'string',
                    description: '设置或匹配的控件值（用于 set_value / select / find / wait）',
                },
                key: {
                    type: 'string',
                    description: '按键或快捷键组合（用于 press，如 "return", "escape", "ctrl+s", "cmd+c"）',
                },
                role: {
                    type: 'string',
                    description: '控件角色过滤（用于 find，如 "button", "textfield", "checkbox", "menuitem"）',
                },
                name: {
                    type: 'string',
                    description: '控件名称过滤（用于 find --name）',
                },
                exact: {
                    type: 'boolean',
                    description: 'find 时是否精确匹配名称/文本',
                },
                first: {
                    type: 'boolean',
                    description: 'find 时是否仅返回第一个匹配项',
                },
                property: {
                    type: 'string',
                    description: '读取或检查的属性（get: text|value|title|bounds|role|states；is: visible|enabled|checked|focused|expanded|selected）',
                },
                surface: {
                    type: 'string',
                    description: '目标表面（window|focused|menu|menubar|sheet|popover|alert|desktop|taskbar|system-tray|start-menu|dock）',
                },
                rootRef: {
                    type: 'string',
                    description: '局部快照或搜索的子树根引用（@<snapshot_id>:e<N>）',
                },
                maxDepth: {
                    type: 'number',
                    description: 'snapshot 最大深度（默认 10）',
                },
                interactiveOnly: {
                    type: 'boolean',
                    description: 'snapshot 是否只保留可交互控件（默认 true）',
                },
                compact: {
                    type: 'boolean',
                    description: 'snapshot 是否压缩单子无名容器（默认 true）',
                },
                skeleton: {
                    type: 'boolean',
                    description: 'snapshot 是否使用浅层骨架模式（适合大型复杂软件首轮探查）',
                },
                includeBounds: {
                    type: 'boolean',
                    description: 'snapshot 是否返回控件矩形坐标（默认 true）',
                },
                direction: {
                    type: 'string',
                    enum: ['up', 'down', 'left', 'right'],
                    description: 'scroll 滚动方向（默认 down）',
                },
                amount: {
                    type: 'number',
                    description: 'scroll 滚动步数（默认 3）',
                },
                x: {
                    type: 'number',
                    description: '目标屏幕 X 坐标（用于 move_window，或当未提供 ref 时通过坐标在后台执行 click/double_click/right_click/type/scroll）',
                },
                y: {
                    type: 'number',
                    description: '目标屏幕 Y 坐标（用于 move_window，或当未提供 ref 时通过坐标在后台执行 click/double_click/right_click/type/scroll）',
                },
                width: { type: 'number', description: 'resize_window 目标宽度' },
                height: { type: 'number', description: 'resize_window 目标高度' },
                timeoutMs: {
                    type: 'number',
                    description: '超时时间或等待毫秒数（默认 30000）',
                },
                waitFor: {
                    type: 'string',
                    description: '动作后自动等待出现的 role:text 选择器（如 "button:保存"）',
                },
                waitForGone: {
                    type: 'string',
                    description: '动作后自动等待消失的 role:text 选择器',
                },
                event: {
                    type: 'string',
                    description: 'wait 等待的桌面事件（window-opened|window-closed|app-launched|app-terminated|focus-changed|surface-appeared|surface-dismissed）',
                },
                predicate: {
                    type: 'string',
                    enum: ['exists', 'enabled', 'visible', 'actionable', 'value'],
                    description: 'wait --element 的断言条件',
                },
                batchCommands: {
                    type: 'array',
                    description: 'batch 批量执行的命令列表',
                    items: {
                        type: 'object',
                        properties: {
                            command: { type: 'string' },
                            args: { type: 'object', additionalProperties: true },
                        },
                        required: ['command'],
                        additionalProperties: false,
                    },
                },
                headed: {
                    type: 'boolean',
                    description: '是否允许物理移动真实鼠标与抢占窗口焦点（默认 false！保持 false 即可后台无感执行并由专属圆角三角琉璃小鼠标展示）',
                },
                cursorLabel: {
                    type: 'string',
                    description: '自定义桌面小鼠标旁显示的实时聊天气泡文案（不传则根据当前动作自动生成）',
                },
                agentId: {
                    type: 'string',
                    description: '子智能体 ID（多智能体并发时可各自拥有独立标签的小鼠标）',
                },
                requestPermission: {
                    type: 'boolean',
                    description: 'permissions 动作时是否请求系统授权',
                },
                force: {
                    type: 'boolean',
                    description: 'close_app 或 press 时是否强制执行',
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
                    sessionId: { type: 'string' },
                    snapshotId: { type: 'string' },
                    deliveryMode: { type: 'string' },
                    starCursorActive: { type: 'boolean' },
                    chatBubbleText: { type: 'string' },
                    summary: { type: 'string' },
                    data: { type: 'object', additionalProperties: true },
                    error: {
                        type: 'object',
                        properties: {
                            code: { type: 'string' },
                            message: { type: 'string' },
                            suggestion: { type: 'string' },
                        },
                        required: ['message'],
                        additionalProperties: false,
                    },
                    screenshotPath: { type: 'string' },
                    imageAttachment: {
                        type: 'object',
                        properties: {
                            attachmentId: { type: 'string' },
                            mediaType: { type: 'string' },
                            bytes: { type: 'number' },
                            width: { type: 'number' },
                            height: { type: 'number' },
                            name: { type: 'string' },
                        },
                        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
                        additionalProperties: false,
                    },
                },
                required: ['ok', 'action', 'deliveryMode', 'starCursorActive', 'summary'],
                additionalProperties: false,
            },
            render(_args, value) {
                const textBlock = {
                    type: 'text',
                    text: `${value.summary}\n\n\`\`\`json\n${JSON.stringify(value.data ?? value.error ?? {}, null, 2).slice(0, 6000)}\n\`\`\``,
                };
                if (value.imageAttachment !== undefined) {
                    return [
                        textBlock,
                        {
                            type: 'image',
                            attachment: {
                                attachmentId: value.imageAttachment.attachmentId,
                                mediaType: value.imageAttachment.mediaType,
                                bytes: value.imageAttachment.bytes,
                                width: value.imageAttachment.width,
                                height: value.imageAttachment.height,
                                ...(value.imageAttachment.name !== undefined ? { name: value.imageAttachment.name } : {}),
                            },
                        },
                    ];
                }
                return [textBlock];
            },
        },
        isConcurrencySafe(args) {
            return (args.action === 'status' ||
                args.action === 'permissions' ||
                args.action === 'list_apps' ||
                args.action === 'list_windows' ||
                args.action === 'list_displays' ||
                args.action === 'list_surfaces' ||
                args.action === 'snapshot' ||
                args.action === 'find' ||
                args.action === 'get' ||
                args.action === 'is');
        },
        async execute(args, exec) {
            const runtimeAgentId = args.agentId ||
                (typeof exec?.agent?.id === 'string'
                    ? exec.agent.id
                    : undefined);
            return executeAgentDesktopAction(runtimeAgentId ? { ...args, agentId: runtimeAgentId } : args, ctx);
        },
    });
}
