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
import type { Context } from '@deepseek-ai/cordis';
import type { ComputerImageAttachmentRef } from '../computer-use/index.js';
/**
 * 彻底剥离返回对象中的 `undefined` 字段，防止 Cordis 抛出 `value is not lossless JSON`
 */
export declare function sanitizeLosslessJson<T>(value: T): T;
/** 圆角三角形 3D 琉璃渐变小鼠标 (34×34) 的左上角点击尖端热点 */
export declare const STAR_CURSOR_HOTSPOT: {
    readonly x: 11;
    readonly y: 11;
};
/** 集成的 vercel-labs/agent-desktop 官方稳定版本号 */
export declare const AGENT_DESKTOP_VERSION = "1.2.0";
/** 操作结束后若超过该毫秒数未发出下一条指令，自动隐藏并销毁桌面迷你小鼠标（10 秒） */
export declare const CURSOR_IDLE_AUTO_HIDE_MS = 10000;
export interface AgentDesktopTargetInfo {
    readonly key: string;
    readonly rustTarget: string;
    readonly tarballName: string;
    readonly sha256: string;
    readonly mainBinary: string;
    readonly entries: readonly string[];
}
/**
 * `vercel-labs/agent-desktop v1.2.0` 全平台官方预编译包矩阵与 SHA-256 校验表
 */
export declare const AGENT_DESKTOP_RELEASE_MATRIX: Readonly<Record<string, AgentDesktopTargetInfo>>;
/**
 * 解析当前操作系统与 CPU 架构对应的 `agent-desktop` 目标描述
 */
export declare function resolveAgentDesktopTarget(platform?: NodeJS.Platform, arch?: string): AgentDesktopTargetInfo | undefined;
/** 获取插件专属的 `agent-desktop` 根目录 (`~/.ghostpaw`) */
export declare function getAgentDesktopRootDir(): string;
/** 获取 `agent-desktop` 状态目录 (`~/.ghostpaw/state`) */
export declare function getAgentDesktopStateDir(): string;
/**
 * 确保插件标志性的 Gemini 圆角三角形 3D 琉璃渐变小鼠标透明 PNG (56×56, hotspot `6,2`) 已落盘
 */
export declare function ensureStarCursorAsset(): string;
export interface PresentDesktopCursorOptions {
    readonly x?: number;
    readonly y?: number;
    readonly targetRect?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
    readonly bubbleText: string;
    readonly isClick?: boolean;
    readonly idleTimeoutMs?: number;
    readonly sessionId?: string;
    readonly agentId?: string;
}
/**
 * 计算与 `agent-desktop` Rust 内核 (`pipe_name.rs` / `endpoint.rs`) 100% 字节一致的 FNV-1a 64 位哈希
 */
export declare function fnv1a64Hex(parts: readonly string[]): string;
/**
 * 计算 Windows Named Pipe 或 macOS Unix Socket 控制端点路径
 */
export declare function computeCursorOverlayEndpoint(stateDir: string, sessionId: string, agentId?: string): string;
/**
 * 直接更新 `<stateDir>/sessions/<sessionId>/session.json` 及多智能体 `<stateDir>/sessions/<sessionId>/cursor-overlays/<agentId>.json` 中的 `cursor_overlay` 配置：
 * - 绝不调用 `agent-desktop cursor-overlay enable`（避免触发 `CursorOverlayControl::Enable` 导致小鼠标停在屏幕正中央 `(960, 520)`）；
 * - 当后续 `agent-desktop click/set-value/select` 执行时，Rust 内核会自动读取该配置并将 34×34 琉璃小鼠标与气泡直接投送到目标控件 `@ref` 坐标！
 */
export declare function syncSessionCursorOverlayManifest(sessionId: string, options: {
    readonly enabled: boolean;
    readonly label?: string;
    readonly multiAgent?: boolean;
    readonly agentId?: string;
}): void;
/**
 * 向 Windows Named Pipe 或 macOS Unix Socket 直接发送 `CursorOverlayControl` 指令（如 `Present` / `Hide` / `Disable`）
 */
export declare function sendNativeCursorOverlayControl(sessionId: string, control: Record<string, unknown>, options?: {
    readonly agentId?: string;
    readonly expectAck?: boolean;
    readonly allowSpawn?: boolean;
}): Promise<boolean>;
/**
 * 在执行 `agent_desktop` 或 `computer` 操作时按需唤醒圆角三角形 3D 琉璃小鼠标与实时动作聊天气泡，
 * 直接将小鼠标移动到目标 `(x, y)` 坐标（绝不停留在屏幕正中央！），
 * 并在 `idleTimeoutMs`（默认 10 秒）无新指令后自动隐藏覆盖层窗口！
 */
export declare function presentDesktopActionCursor(options: PresentDesktopCursorOptions): Promise<void>;
/**
 * 立即隐藏并关闭桌面迷你小鼠标覆盖层
 */
export declare function hideDesktopActionCursor(sessionId?: string, agentId?: string): Promise<void>;
/**
 * 确保本机已安装并校验 `agent-desktop v1.2.0` 原生二进制（优先走 GitHub Release镜像，GitHub Release 兜底）
 */
export declare function ensureAgentDesktopBinary(): Promise<string>;
export interface AgentDesktopCliResponse {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly envelope?: {
        readonly version?: string;
        readonly ok: boolean;
        readonly command?: string;
        readonly data?: Record<string, unknown>;
        readonly error?: {
            readonly code?: string;
            readonly message?: string;
            readonly suggestion?: string;
            readonly platform_detail?: string;
            readonly disposition?: Record<string, unknown>;
        };
        readonly warnings?: ReadonlyArray<Record<string, unknown>>;
    };
}
/**
 * 调用 `agent-desktop` CLI 并解析其标准 JSON Envelope 输出
 */
export declare function runAgentDesktopCli(args: readonly string[], options?: {
    readonly stdinText?: string;
    readonly timeoutMs?: number;
    readonly sessionId?: string;
    readonly agentId?: string;
}): Promise<AgentDesktopCliResponse>;
export interface CachedRefMeta {
    readonly ref: string;
    readonly role: string;
    readonly name: string;
    readonly automationId?: string;
    readonly windowId?: string;
    readonly app?: string;
    readonly centerX?: number;
    readonly centerY?: number;
    readonly bounds?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
}
interface AgentTargetState {
    lastSnapshotId?: string;
    lastApp?: string;
    lastWindowId?: string;
}
interface SessionState {
    sessionId: string;
    cursorEnabled: boolean;
    cursorLabel: string;
    multiAgent: boolean;
    lastSnapshotId?: string;
    lastApp?: string;
    lastWindowId?: string;
    refMetaMap: Map<string, CachedRefMeta>;
    snapshotOwnerMap: Map<string, {
        windowId?: string;
        app?: string;
    }>;
    lastSnapshotByWindow: Map<string, string>;
    agentStates: Map<string, AgentTargetState>;
}
/**
 * 从 `<stateDir>/sessions/<sessionId>/snapshots/<snapshotId>/refmap.json` 加载原生快照元数据：
 * - 包含每个 `@ref` 的精确 `bounds`、`source_window_id`、`source_app` 以及 UIA `native_id.value` (`automationId`)；
 * - 即使 `@ref` 来自 `find`（默认 CLI JSON 不含 `bounds`）或跨轮次调用，也能毫秒级还原完整坐标与 AutomationId！
 */
export declare function loadSnapshotRefMapFromDisk(sessionId: string, snapshotId: string | undefined, refMetaMap: Map<string, CachedRefMeta>, snapshotOwnerMap?: Map<string, {
    windowId?: string;
    app?: string;
}>): void;
/**
 * 在当前缓存的无障碍快照中查找包含坐标 `(x, y)`（或中心点距离最近）的最佳 `@ref`
 * 支持按目标 `windowId` / `app` 过滤，确保多智能体并发或窗口重叠时绝不误命中上层遮挡窗口的控件！
 */
export declare function findBestRefAtPoint(x: number, y: number, sessionKey?: string, filter?: {
    readonly windowId?: string;
    readonly app?: string;
}): CachedRefMeta | undefined;
export interface WindowsBackgroundPointActionOptions {
    readonly action: 'click' | 'left_click' | 'double_click' | 'triple_click' | 'right_click' | 'type' | 'set_value' | 'clear' | 'toggle' | 'check' | 'uncheck' | 'scroll' | 'key' | 'hotkey' | 'restore_no_activate' | 'focus_no_activate' | 'launch_background' | 'move_window_background' | 'resize_window_background';
    readonly x?: number;
    readonly y?: number;
    readonly width?: number;
    readonly height?: number;
    readonly hasExplicitCoord?: boolean;
    readonly text?: string;
    readonly clearFirst?: boolean;
    readonly pressEnter?: boolean;
    readonly key?: string;
    readonly direction?: 'up' | 'down' | 'left' | 'right';
    readonly amount?: number;
    readonly app?: string;
    readonly windowHandle?: number;
    readonly elementName?: string;
    readonly elementRole?: string;
    readonly automationId?: string;
}
export interface WindowsBackgroundPointActionResult {
    readonly ok: boolean;
    readonly method: string;
    readonly detail: string;
    readonly windowTitle?: string;
    readonly elementName?: string;
    readonly elementRole?: string;
    readonly automationId?: string;
    readonly hwnd?: number;
    readonly clientX?: number;
    readonly clientY?: number;
    readonly error?: string;
}
export declare function normalizeAppQueryTokens(rawApp?: string): string[];
export declare function matchWindowsAppCandidate(query: string | undefined, candidate: {
    readonly id?: string;
    readonly app?: string;
    readonly title?: string;
}): boolean;
export declare function parseWindowHandleFromId(windowId?: string): number | undefined;
export declare function executeWindowsBackgroundPointAction(options: WindowsBackgroundPointActionOptions): WindowsBackgroundPointActionResult;
export declare function executeWindowsBackgroundPointActionAsync(options: WindowsBackgroundPointActionOptions): Promise<WindowsBackgroundPointActionResult>;
/**
 * 将简写引用（如 `e5` 或 `@e5`）自动补全为带最新 `snapshot_id` 的完整引用（`@<snapshot_id>:e5`）
 */
export declare function qualifyAgentDesktopRef(rawRef: string | undefined, lastSnapshotId?: string): string;
/**
 * 确保当前智能体会话已初始化 `agent-desktop` 命名空间（注意：绝不在会话创建时常驻开启小鼠标，仅在实际动作发生时按需唤醒！）
 */
export declare function ensureAgentDesktopSession(options?: {
    readonly sessionKey?: string;
    readonly cursorLabel?: string;
    readonly enableCursorOverlay?: boolean;
    readonly multiAgent?: boolean;
    readonly agentId?: string;
}): Promise<SessionState>;
/**
 * 将插件专属的圆角三角形 3D 琉璃小鼠标 (`ghostpaw-neon-hollow-cursor.png`, 34×34, hotspot `4,1`) 与当前动作气泡同步到会话配置
 * 注意：绝不直接调用 `agent-desktop cursor-overlay enable`（那会发送 `CursorOverlayControl::Enable` 将光标停在屏幕正中央 `(960, 520)`）！
 */
export declare function configureStarCursorOverlay(sessionId: string, options?: {
    readonly label?: string;
    readonly multiAgent?: boolean;
    readonly agentId?: string;
    readonly x?: number;
    readonly y?: number;
}): Promise<AgentDesktopCliResponse>;
export type AgentDesktopAction = 'status' | 'permissions' | 'list_apps' | 'list_windows' | 'list_displays' | 'list_surfaces' | 'open_system_surface' | 'snapshot' | 'find' | 'get' | 'is' | 'screenshot' | 'click' | 'double_click' | 'triple_click' | 'right_click' | 'set_value' | 'type' | 'clear' | 'focus' | 'select' | 'toggle' | 'check' | 'uncheck' | 'expand' | 'collapse' | 'scroll' | 'scroll_to' | 'press' | 'launch' | 'close_app' | 'focus_window' | 'resize_window' | 'move_window' | 'minimize' | 'maximize' | 'restore' | 'wait' | 'clipboard_get' | 'clipboard_set' | 'clipboard_clear' | 'batch' | 'cursor_enable' | 'cursor_disable';
export interface AgentDesktopToolArgs {
    readonly action: AgentDesktopAction;
    /** 目标应用名称或 Bundle ID（如 "Finder", "Notepad", "微信", "WPS Office"） */
    readonly app?: string;
    /** 目标窗口 ID（来自 list_windows 返回的 id，如 "w_1234"） */
    readonly windowId?: string;
    /** 无障碍元素语义引用 ID（来自 snapshot 或 find 返回的 `@<snapshot_id>:e<N>`，也支持简写 `e<N>` 自动补全最新快照 ID） */
    readonly ref?: string;
    /** 输入或设置的文本内容（用于 set_value / type / select / clipboard_set / wait --text / find --text） */
    readonly text?: string;
    /** 属性值（用于 set_value / find --value / wait --value） */
    readonly value?: string;
    /** 按键组合（用于 press，如 "return", "escape", "ctrl+s", "cmd+c", "shift+tab"） */
    readonly key?: string;
    /** 无障碍角色过滤（用于 find，如 "button", "textfield", "checkbox", "menuitem", "tab"） */
    readonly role?: string;
    /** 无障碍名称过滤（用于 find --name） */
    readonly name?: string;
    /** 是否精确匹配（用于 find --exact） */
    readonly exact?: boolean;
    /** 是否只返回第一个匹配元素（用于 find --first） */
    readonly first?: boolean;
    /** 读取或判断的属性名（get: text|value|title|bounds|role|states；is: visible|enabled|checked|focused|expanded|selected） */
    readonly property?: string;
    /** 快照或打开的系统表面类型（window|focused|menu|menubar|sheet|popover|alert|desktop|taskbar|system-tray|start-menu|dock 等） */
    readonly surface?: string;
    /** 子树根引用（用于 snapshot --root 或 find --root，局部深挖某个容器） */
    readonly rootRef?: string;
    /** 快照最大深度（默认 10） */
    readonly maxDepth?: number;
    /** 快照是否仅保留可交互元素（默认 true，大幅节省 Token） */
    readonly interactiveOnly?: boolean;
    /** 快照是否折叠单子无名容器（默认 true） */
    readonly compact?: boolean;
    /** 快照是否启用浅层骨架屏概览模式（用于超大复杂窗口首轮探查） */
    readonly skeleton?: boolean;
    /** 快照是否包含元素像素边界坐标（默认 true，驱动小鼠标精准落点） */
    readonly includeBounds?: boolean;
    /** 滚动方向（up|down|left|right，默认 down） */
    readonly direction?: 'up' | 'down' | 'left' | 'right';
    /** 滚动步长（默认 3） */
    readonly amount?: number;
    /** 窗口坐标 X 或宽度 Width（用于 move_window / resize_window） */
    readonly x?: number;
    readonly y?: number;
    readonly width?: number;
    readonly height?: number;
    /** 等待毫秒数或超时时间（用于 wait / launch / snapshot） */
    readonly timeoutMs?: number;
    /** 动作执行后自动等待某个元素出现的 role:text 选择器（如 "button:确定"） */
    readonly waitFor?: string;
    /** 动作执行后自动等待某个元素消失的 role:text 选择器 */
    readonly waitForGone?: string;
    /** wait 动作的事件类型（window-opened|window-closed|app-launched|app-terminated|focus-changed|surface-appeared|surface-dismissed） */
    readonly event?: string;
    /** wait --element 的断言条件（exists|enabled|visible|actionable|value） */
    readonly predicate?: 'exists' | 'enabled' | 'visible' | 'actionable' | 'value';
    /** 批量执行的命令数组（用于 batch） */
    readonly batchCommands?: ReadonlyArray<{
        readonly command: string;
        readonly args?: Record<string, unknown>;
    }>;
    /**
     * 是否允许物理接管真实鼠标与抢占窗口焦点（默认 `false`！）。
     * - `false`（默认推荐）：100% 后台无头语义执行 + 独立圆角三角琉璃小鼠标展示，绝不移动用户真实鼠标，绝不抢夺前台窗口焦点；
     * - `true`：仅当需要 double_click 或目标控件不支持无障碍语义调用时开启。
     */
    readonly headed?: boolean;
    /** 自定义桌面迷你小鼠标旁显示的状态聊天气泡文本 */
    readonly cursorLabel?: string;
    /** 子智能体标识（开启多智能体并发独立小鼠标时传入，如 "subagent-excel"） */
    readonly agentId?: string;
    /** 是否请求系统无障碍权限弹窗（用于 permissions） */
    readonly requestPermission?: boolean;
    /** 是否强制关闭应用或强制发送快捷键 */
    readonly force?: boolean;
}
export interface AgentDesktopToolResult {
    readonly ok: boolean;
    readonly action: AgentDesktopAction;
    readonly sessionId?: string;
    readonly snapshotId?: string;
    readonly deliveryMode: 'headless-semantic-star-cursor' | 'headed-physical';
    readonly starCursorActive: boolean;
    readonly chatBubbleText?: string;
    readonly summary: string;
    readonly data?: Record<string, unknown>;
    readonly error?: {
        readonly code?: string;
        readonly message: string;
        readonly suggestion?: string;
    };
    readonly screenshotPath?: string;
    readonly imageAttachment?: ComputerImageAttachmentRef;
}
/**
 * 将 `agent-desktop` CLI 返回的 `envelope.data` 规范化为普通 JSON Object（防止 `list-windows` / `list-displays` 返回顶层 Array 导致工具 Schema 校验报错 `value.data must be an object`）
 */
export declare function normalizeEnvelopeData(action: AgentDesktopAction | string, rawData: unknown): Record<string, unknown>;
/**
 * 根据当前执行的 `agent_desktop` 动作生成显示在迷你小鼠标旁的实时聊天气泡文案
 * 注意：纯读取/枚举/观察类动作返回 undefined，不唤醒桌面鼠标，仅在实际执行交互操作时显示！
 */
export declare function buildActionChatBubbleText(args: AgentDesktopToolArgs, qualifiedRef: string, refMeta?: CachedRefMeta): string | undefined;
/**
 * 执行 `agent_desktop` 工具指令
 */
export declare function executeAgentDesktopAction(args: AgentDesktopToolArgs, ctx?: Context): Promise<AgentDesktopToolResult>;
/**
 * 向 Cordis 宿主注册 `agent_desktop` 工具
 */
export declare function applyAgentDesktopTool(ctx: Context): void;
export {};
