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
import type { Context } from '@deepseek-ai/cordis';
export interface LibnutScreenCapture {
    readonly width: number;
    readonly height: number;
    readonly byteWidth: number;
    readonly bitsPerPixel: number;
    readonly bytesPerPixel: number;
    readonly image: Buffer;
}
export interface LibnutWindowRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface LibnutNativeAddon {
    moveMouse(x: number, y: number): void;
    dragMouse(x: number, y: number): void;
    getMousePos(): {
        x: number;
        y: number;
    };
    mouseClick(button?: 'left' | 'right' | 'middle', double?: boolean): void;
    mouseToggle(state?: 'down' | 'up', button?: 'left' | 'right' | 'middle'): void;
    scrollMouse(x: number, y: number): void;
    setMouseDelay(delay: number): void;
    keyTap(key: string, modified?: string | string[]): void;
    keyToggle(key: string, state: 'down' | 'up', modified?: string | string[]): void;
    typeString(str: string): void;
    setKeyboardDelay(delay: number): void;
    getScreenSize(): {
        width: number;
        height: number;
    };
    captureScreen(x?: number, y?: number, width?: number, height?: number): LibnutScreenCapture;
    highlight?(x: number, y: number, width: number, height: number, duration: number, opacity: number): void;
    getWindows?(): number[];
    getActiveWindow?(): number;
    getWindowRect?(windowHandle: number): LibnutWindowRect;
    getWindowTitle?(windowHandle: number): string;
    focusWindow?(windowHandle: number): boolean;
    resizeWindow?(windowHandle: number, size: {
        width: number;
        height: number;
    }): boolean;
    moveWindow?(windowHandle: number, origin: {
        x: number;
        y: number;
    }): boolean;
}
export type ComputerAction = 'screenshot' | 'left_click' | 'double_click' | 'triple_click' | 'right_click' | 'middle_click' | 'mouse_move' | 'mouse_down' | 'mouse_up' | 'drag' | 'scroll' | 'type' | 'key' | 'hotkey' | 'wait' | 'cursor_position' | 'list_windows' | 'focus_window';
export type CoordinateSpace = 'pixels' | 'normalized_1000';
export interface ComputerToolArgs {
    /** 要执行的桌面操作类型 */
    readonly action: ComputerAction;
    /** 目标 X 坐标（支持 [x, y] 或独立 x/y；默认使用截图上的像素坐标 pixels，也可通过 coordinateSpace="normalized_1000" 使用 0~1000 归一化坐标） */
    readonly x?: number;
    /** 目标 Y 坐标 */
    readonly y?: number;
    /** 兼容 Anthropic / OpenAI / UI-TARS 的 [x, y] 数组格式坐标 */
    readonly coordinate?: readonly [number, number];
    /** 拖拽起点 X 坐标（若不传则从当前鼠标位置或 x/y 开始） */
    readonly fromX?: number;
    /** 拖拽起点 Y 坐标 */
    readonly fromY?: number;
    /** 拖拽终点 X 坐标 */
    readonly toX?: number;
    /** 拖拽终点 Y 坐标 */
    readonly toY?: number;
    /** 兼容 [toX, toY] 数组格式的拖拽终点坐标 */
    readonly endCoordinate?: readonly [number, number];
    /** 坐标空间：'pixels'（默认，与截图标尺像素 1:1 对应）或 'normalized_1000'（0~1000 相对千分比坐标） */
    readonly coordinateSpace?: CoordinateSpace;
    /** 要输入的文本内容（action="type" 时必填，内置剪贴板无损粘贴支持中文/Emoji/多行文本） */
    readonly text?: string;
    /** 输入文本后是否自动按下回车键（默认 false） */
    readonly pressEnter?: boolean;
    /** 输入文本前是否先全选清空当前输入框 Ctrl+A / Cmd+A -> Backspace（默认 false） */
    readonly clearFirst?: boolean;
    /** 按键或组合快捷键（action="key" 或 "hotkey" 时使用，例如 "Enter", "Escape", "ctrl+c", "ctrl+shift+s", "alt+tab", "cmd+v"） */
    readonly key?: string;
    /** 兼容数组格式的组合键，如 ["ctrl", "v"] */
    readonly keys?: readonly string[];
    /** 滚动方向（action="scroll" 时使用） */
    readonly scrollDirection?: 'up' | 'down' | 'left' | 'right';
    /** 滚动刻度数（默认 5） */
    readonly scrollAmount?: number;
    /** 等待毫秒数（action="wait" 时使用，默认 1000ms，上限 15000ms） */
    readonly durationMs?: number;
    /** 动作执行后等待 UI 渲染稳定的毫秒数（默认 320ms） */
    readonly settleMs?: number;
    /** 动作完成后是否自动截取最新屏幕并返回多模态图像（默认 true） */
    readonly autoScreenshot?: boolean;
    /** 截图上是否叠加半透明像素坐标标尺网格与落点红圈准星（默认 true，极大提升视觉定位精度） */
    readonly grid?: boolean;
    /** 聚焦窗口时的窗口标题关键字（action="focus_window" 时使用，支持大小写不敏感子串匹配） */
    readonly windowTitle?: string;
    /** 聚焦窗口时的窗口句柄 ID（action="focus_window" 时可选） */
    readonly windowHandle?: number;
    /** 当触发 Fail-Safe 鼠标急停后，若人类明确要求继续接管，可传 true 重置急停状态 */
    readonly resetFailSafe?: boolean;
    /** 是否强制移动真实物理鼠标与抢占窗口焦点（默认 false！Windows 下默认通过 Agent-Desktop 后台琉璃小鼠标 + UIA/Win32 消息无感投递，不抢用户鼠标和前台窗口） */
    readonly physicalMouse?: boolean;
    /** 子智能体标识（多智能体并发时拥有独立琉璃小鼠标与独立目标窗口上下文） */
    readonly agentId?: string;
}
export interface DesktopWindowInfo {
    readonly handle: number;
    readonly title: string;
    readonly rect: LibnutWindowRect;
    readonly active: boolean;
}
export interface ComputerImageAttachmentRef {
    readonly attachmentId: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly name?: string;
    readonly originalDimensions?: {
        readonly width: number;
        readonly height: number;
    };
}
export interface ComputerToolResult {
    readonly ok: boolean;
    readonly action: ComputerAction;
    readonly summary: string;
    readonly driver: 'libnut-native-cpp' | 'os-cli-fallback';
    readonly screenSize: {
        readonly width: number;
        readonly height: number;
    };
    readonly screenshotSize?: {
        readonly width: number;
        readonly height: number;
    };
    readonly scaleFactor: {
        readonly x: number;
        readonly y: number;
    };
    readonly cursorPosition: {
        readonly x: number;
        readonly y: number;
    };
    readonly targetCoordinate?: {
        readonly x: number;
        readonly y: number;
    };
    readonly activeWindow?: string;
    readonly windows?: readonly DesktopWindowInfo[];
    readonly screenshotPath?: string;
    readonly failSafeTriggered?: boolean;
    readonly image?: ComputerImageAttachmentRef;
}
/**
 * 解析当前平台对应的预编译 C++ N-API `libnut.node` 路径
 */
export declare function resolveNativeLibnutPath(): string | undefined;
/**
 * 加载内置 C++ `@nut-tree-fork/libnut` 原生模块（支持 Windows / macOS Universal / Linux X11）
 */
export declare function loadLibnutNative(): LibnutNativeAddon | null;
export declare function getLibnutLoadStatus(): {
    readonly loaded: boolean;
    readonly addonPath?: string;
    readonly error?: string;
};
/**
 * 在 RGBA 画布上绘制半透明像素坐标网格标尺与鼠标点击准星
 */
export declare function drawCoordinateGridAndCrosshair(rgba: Uint8Array, width: number, height: number, options?: {
    readonly drawGrid?: boolean;
    readonly marker?: {
        readonly x: number;
        readonly y: number;
        readonly label?: string;
    };
}): void;
/**
 * 将 `libnut.captureScreen()` 返回的原始 BGRA Buffer 转换并缩放到目标逻辑分辨率 RGBA PNG Buffer
 */
export declare function encodeBgraCaptureToPng(capture: LibnutScreenCapture, targetLogicalSize: {
    readonly width: number;
    readonly height: number;
}, overlayOptions?: {
    readonly drawGrid?: boolean;
    readonly marker?: {
        readonly x: number;
        readonly y: number;
        readonly label?: string;
    };
}): {
    readonly pngBuffer: Buffer;
    readonly width: number;
    readonly height: number;
};
/**
 * 将用户或模型传入的快捷键字符串（如 `"Ctrl+Shift+S"`, `"Alt+Tab"`, `"Enter"`）解析为 `libnut` 标准格式
 */
export declare function normalizeKeyCombo(rawKey?: string, rawKeys?: readonly string[]): {
    readonly mainKey: string;
    readonly modifiers: string[];
    readonly rawLabel: string;
};
/**
 * 列出当前桌面所有可见顶层应用窗口
 */
export declare function listDesktopWindows(libnut: LibnutNativeAddon): DesktopWindowInfo[];
/**
 * 解析并映射输入坐标到操作系统逻辑屏幕像素坐标
 */
export declare function resolveLogicalCoordinate(rawX: number | undefined, rawY: number | undefined, rawTuple: readonly [number, number] | undefined, screenSize: {
    readonly width: number;
    readonly height: number;
}, coordinateSpace?: CoordinateSpace): {
    readonly x: number;
    readonly y: number;
} | undefined;
/**
 * 在 Cordis Context 上注册统一的操作系统级鼠键接管工具 `computer`
 */
export declare function applyComputerUseTool(ctx: Context): void;
