/**
 * GhostPaw Native macOS Engine (`ghostpaw-macos-helper`)
 *
 * Provides three native macOS capabilities in a single zero-dependency Universal Mach-O binary:
 * 1. `--cursor-daemon <socketPath> <starPngPath> [agentId]`:
 *    Non-activating (`NSApplicationActivationPolicyProhibited`), click-through (`ignoresMouseEvents = YES`),
 *    screen-saver-level (`NSScreenSaverWindowLevel`) Neon Hollow GhostPaw Cursor + cubic-bezier smooth travel +
 *    click ripple + per-agent color-coded translucent glass chat bubble overlay daemon over Unix Domain Socket.
 * 2. `--bg-action <base64JsonPayload>`:
 *    100% non-focus-stealing background window launch, unminimize, move/resize, AXUIElement semantic passthrough
 *    (`kAXPressAction`, `kAXValueAttribute`, `AXMenuBar` background menu item invocation), and `CGEventPostToPid`
 *    keystroke/scroll passthrough — parity with `GhostPawWin32BgV4` on Windows.
 * 3. Full `agent-desktop` JSON Envelope CLI compatibility (`session`, `status`, `permissions`, `list-apps`,
 *    `list-windows`, `list-displays`, `list-surfaces`, `snapshot`, `find`, `get`, `is`, `screenshot`, `click`,
 *    `set-value`, `type`, `clear`, `press`, `scroll`, `launch`, `close-app`, `move-window`, `resize-window`,
 *    `minimize`, `maximize`, `restore`, `clipboard-*`, `wait`, `batch`) with zero global lock contention so
 *    multiple sub-agents can operate different background macOS windows concurrently.
 */

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <dlfcn.h>

extern AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *idOut);
typedef CGImageRef (*GPWindowListCreateImageFn)(CGRect, CGWindowListOption, CGWindowID, CGWindowImageOption);

// ============================================================================
// 1. Utility Helpers (JSON, Strings, AX Attributes, App Alias Resolution)
// ============================================================================

static NSString *safeStr(id val) {
    if (!val || val == [NSNull null]) return @"";
    if ([val isKindOfClass:[NSString class]]) return (NSString *)val;
    if ([val isKindOfClass:[NSNumber class]]) return [(NSNumber *)val stringValue];
    return [val description] ?: @"";
}

static void printJsonAndExit(NSDictionary *dict, int exitCode) {
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:dict options:0 error:&err];
    if (data) {
        fwrite(data.bytes, 1, data.length, stdout);
        fwrite("\n", 1, 1, stdout);
        fflush(stdout);
    } else {
        printf("{\"ok\":false,\"error\":{\"code\":\"JSON_ERROR\",\"message\":\"Failed to serialize JSON\"}}\n");
        fflush(stdout);
    }
    exit(exitCode);
}

static void printCliEnvelopeAndExit(NSString *command, BOOL ok, id dataObj, NSString *errCode, NSString *errMsg, NSString *suggestion) {
    NSMutableDictionary *env = [NSMutableDictionary dictionary];
    env[@"version"] = @"1.0";
    env[@"ok"] = @(ok);
    env[@"command"] = command ?: @"unknown";
    if (ok) {
        env[@"data"] = dataObj ?: @{};
    } else {
        NSMutableDictionary *errDict = [NSMutableDictionary dictionary];
        errDict[@"code"] = errCode ?: @"EXECUTION_FAILED";
        errDict[@"message"] = errMsg ?: @"Command failed";
        if (suggestion && suggestion.length > 0) {
            errDict[@"suggestion"] = suggestion;
        }
        env[@"error"] = errDict;
        if (dataObj) env[@"data"] = dataObj;
    }
    printJsonAndExit(env, ok ? 0 : 1);
}

static NSString *axStr(AXUIElementRef el, CFStringRef attr) {
    if (!el) return @"";
    CFTypeRef val = NULL;
    if (AXUIElementCopyAttributeValue(el, attr, &val) == kAXErrorSuccess && val) {
        NSString *res = @"";
        if (CFGetTypeID(val) == CFStringGetTypeID()) {
            res = [(__bridge NSString *)val copy];
        } else if (CFGetTypeID(val) == CFNumberGetTypeID()) {
            res = [(__bridge NSNumber *)val stringValue];
        } else if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
            res = CFBooleanGetValue((CFBooleanRef)val) ? @"true" : @"false";
        }
        CFRelease(val);
        // Strip directional formatting marks (e.g. U+200E LEFT-TO-RIGHT MARK in macOS Calculator)
        res = [res stringByReplacingOccurrencesOfString:@"\u200e" withString:@""];
        res = [res stringByReplacingOccurrencesOfString:@"\u200f" withString:@""];
        return res ?: @"";
    }
    return @"";
}

static BOOL axBool(AXUIElementRef el, CFStringRef attr, BOOL defaultVal) {
    if (!el) return defaultVal;
    CFTypeRef val = NULL;
    if (AXUIElementCopyAttributeValue(el, attr, &val) == kAXErrorSuccess && val) {
        BOOL res = defaultVal;
        if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
            res = CFBooleanGetValue((CFBooleanRef)val) ? YES : NO;
        } else if (CFGetTypeID(val) == CFNumberGetTypeID()) {
            res = [(__bridge NSNumber *)val boolValue];
        }
        CFRelease(val);
        return res;
    }
    return defaultVal;
}

static CGRect axFrame(AXUIElementRef el) {
    CGRect r = CGRectZero;
    if (!el) return r;
    CFTypeRef posVal = NULL, sizeVal = NULL;
    CGPoint pt = CGPointZero;
    CGSize sz = CGSizeZero;
    if (AXUIElementCopyAttributeValue(el, kAXPositionAttribute, &posVal) == kAXErrorSuccess && posVal) {
        if (CFGetTypeID(posVal) == AXValueGetTypeID()) {
            AXValueGetValue((AXValueRef)posVal, kAXValueCGPointType, &pt);
        }
        CFRelease(posVal);
    }
    if (AXUIElementCopyAttributeValue(el, kAXSizeAttribute, &sizeVal) == kAXErrorSuccess && sizeVal) {
        if (CFGetTypeID(sizeVal) == AXValueGetTypeID()) {
            AXValueGetValue((AXValueRef)sizeVal, kAXValueCGSizeType, &sz);
        }
        CFRelease(sizeVal);
    }
    r.origin = pt;
    r.size = sz;
    return r;
}

static BOOL axSetFrameOrigin(AXUIElementRef el, CGFloat x, CGFloat y) {
    if (!el) return NO;
    CGPoint pt = CGPointMake(x, y);
    AXValueRef val = AXValueCreate(kAXValueCGPointType, &pt);
    if (!val) return NO;
    AXError err = AXUIElementSetAttributeValue(el, kAXPositionAttribute, val);
    CFRelease(val);
    return err == kAXErrorSuccess;
}

static BOOL axSetFrameSize(AXUIElementRef el, CGFloat w, CGFloat h) {
    if (!el) return NO;
    CGSize sz = CGSizeMake(w, h);
    AXValueRef val = AXValueCreate(kAXValueCGSizeType, &sz);
    if (!val) return NO;
    AXError err = AXUIElementSetAttributeValue(el, kAXSizeAttribute, val);
    CFRelease(val);
    return err == kAXErrorSuccess;
}

static NSString *normalizeRoleName(NSString *axRole, NSString *axSubrole) {
    NSString *r = [axRole lowercaseString] ?: @"";
    if ([r hasPrefix:@"ax"]) r = [r substringFromIndex:2];
    if ([r isEqualToString:@"statictext"]) return @"text";
    if ([r isEqualToString:@"textfield"] || [r isEqualToString:@"searchfield"]) return @"textfield";
    if ([r isEqualToString:@"textarea"]) return @"textarea";
    if ([r isEqualToString:@"popupbutton"] || [r isEqualToString:@"combobox"]) return @"combobox";
    if ([r isEqualToString:@"checkbox"]) return @"checkbox";
    if ([r isEqualToString:@"radiobutton"]) return @"radiobutton";
    if ([r isEqualToString:@"button"]) return @"button";
    if ([r isEqualToString:@"menuitem"] || [r isEqualToString:@"menubaritem"]) return @"menuitem";
    if ([r isEqualToString:@"window"]) return @"window";
    if ([r isEqualToString:@"group"] || [r isEqualToString:@"splitgroup"]) return @"group";
    if ([r isEqualToString:@"scrollarea"]) return @"scrollarea";
    if ([r isEqualToString:@"toolbar"]) return @"toolbar";
    return r.length > 0 ? r : @"element";
}

static BOOL isInteractiveRole(NSString *normRole, AXUIElementRef el) {
    static NSSet *roles = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        roles = [NSSet setWithArray:@[
            @"button", @"textfield", @"textarea", @"checkbox", @"radiobutton",
            @"combobox", @"menuitem", @"slider", @"link", @"tab", @" cell", @"row", @"text"
        ]];
    });
    if ([roles containsObject:normRole]) return YES;
    NSString *ident = axStr(el, CFSTR("AXIdentifier"));
    NSString *desc = axStr(el, kAXDescriptionAttribute);
    if (ident.length > 0 || desc.length > 0) return YES;
    return NO;
}

static NSArray<NSArray<NSString *> *> *getAppAliasGroups(void) {
    static NSArray<NSArray<NSString *> *> *groups = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        groups = @[
            @[@"calc", @"calculator", @"calculatorapp", @"计算器", @"com.apple.calculator"],
            @[@"notepad", @"textedit", @"记事本", @"文本编辑", @"com.apple.textedit"],
            @[@"notes", @"备忘录", @"com.apple.notes"],
            @[@"mspaint", @"paint", @"preview", @"画图", @"预览", @"com.apple.preview"],
            @[@"explorer", @"finder", @"文件资源管理器", @"资源管理器", @"访达", @"com.apple.finder"],
            @[@"cmd", @"powershell", @"pwsh", @"terminal", @"命令提示符", @"终端", @"com.apple.terminal"],
            @[@"safari", @"browser", @"浏览器", @"com.apple.safari"],
            @[@"chrome", @"google chrome", @"com.google.chrome"],
            @[@"msedge", @"edge", @"microsoft edge", @"com.microsoft.edgemac"],
            @[@"weixin", @"wechat", @"微信", @"com.tencent.xinwechat"],
            @[@"wps", @"wps office", @"wpsoffice", @"com.kingsoft.wpsoffice.mac"],
            @[@"code", @"vscode", @"visual studio code", @"com.microsoft.vscode"],
        ];
    });
    return groups;
}

static NSArray<NSString *> *expandAppAliases(NSString *rawQuery) {
    NSString *q = [[rawQuery ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
    if ([q hasSuffix:@".exe"]) q = [q substringToIndex:q.length - 4];
    if ([q hasSuffix:@".app"]) q = [q substringToIndex:q.length - 4];
    if (q.length == 0) return @[];
    NSMutableOrderedSet<NSString *> *set = [NSMutableOrderedSet orderedSetWithObject:q];
    for (NSArray<NSString *> *g in getAppAliasGroups()) {
        BOOL hit = NO;
        for (NSString *a in g) {
            if ([q isEqualToString:a] || [q containsString:a] || [a containsString:q]) {
                hit = YES;
                break;
            }
        }
        if (hit) {
            for (NSString *a in g) [set addObject:a];
        }
    }
    return [set array];
}

static NSString *resolveMacAppNameForLaunch(NSString *rawApp, NSString **outBundleId) {
    NSString *q = [[rawApp ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
    if ([q hasSuffix:@".exe"]) q = [q substringToIndex:q.length - 4];
    if ([q hasSuffix:@".app"]) q = [q substringToIndex:q.length - 4];

    if ([q isEqualToString:@"calc"] || [q isEqualToString:@"calculator"] || [q isEqualToString:@"calculatorapp"] || [q containsString:@"计算器"]) {
        if (outBundleId) *outBundleId = @"com.apple.calculator";
        return @"Calculator";
    }
    if ([q isEqualToString:@"notepad"] || [q isEqualToString:@"textedit"] || [q containsString:@"记事本"] || [q containsString:@"文本编辑"]) {
        if (outBundleId) *outBundleId = @"com.apple.TextEdit";
        return @"TextEdit";
    }
    if ([q isEqualToString:@"notes"] || [q containsString:@"备忘录"]) {
        if (outBundleId) *outBundleId = @"com.apple.Notes";
        return @"Notes";
    }
    if ([q isEqualToString:@"mspaint"] || [q isEqualToString:@"paint"] || [q isEqualToString:@"preview"] || [q containsString:@"画图"] || [q containsString:@"预览"]) {
        if (outBundleId) *outBundleId = @"com.apple.Preview";
        return @"Preview";
    }
    if ([q isEqualToString:@"explorer"] || [q isEqualToString:@"finder"] || [q containsString:@"资源管理器"] || [q containsString:@"访达"]) {
        if (outBundleId) *outBundleId = @"com.apple.finder";
        return @"Finder";
    }
    if ([q isEqualToString:@"cmd"] || [q isEqualToString:@"powershell"] || [q isEqualToString:@"terminal"] || [q containsString:@"命令提示符"] || [q containsString:@"终端"]) {
        if (outBundleId) *outBundleId = @"com.apple.Terminal";
        return @"Terminal";
    }
    if ([q isEqualToString:@"safari"] || [q isEqualToString:@"browser"] || [q containsString:@"浏览器"]) {
        if (outBundleId) *outBundleId = @"com.apple.Safari";
        return @"Safari";
    }
    if ([q isEqualToString:@"chrome"] || [q isEqualToString:@"google chrome"]) {
        if (outBundleId) *outBundleId = @"com.google.Chrome";
        return @"Google Chrome";
    }
    if ([q isEqualToString:@"edge"] || [q isEqualToString:@"msedge"] || [q isEqualToString:@"microsoft edge"]) {
        if (outBundleId) *outBundleId = @"com.microsoft.edgemac";
        return @"Microsoft Edge";
    }
    if ([q isEqualToString:@"weixin"] || [q isEqualToString:@"wechat"] || [q containsString:@"微信"]) {
        if (outBundleId) *outBundleId = @"com.tencent.xinWeChat";
        return @"WeChat";
    }
    if ([q isEqualToString:@"code"] || [q isEqualToString:@"vscode"] || [q isEqualToString:@"visual studio code"]) {
        if (outBundleId) *outBundleId = @"com.microsoft.VSCode";
        return @"Visual Studio Code";
    }
    return [rawApp stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

static BOOL matchesAppCandidate(NSString *query, NSString *appName, NSString *bundleId, NSString *winTitle) {
    NSArray<NSString *> *tokens = expandAppAliases(query);
    if (tokens.count == 0) return YES;
    NSString *appL = [appName ?: @"" lowercaseString];
    NSString *bunL = [bundleId ?: @"" lowercaseString];
    NSString *titL = [winTitle ?: @"" lowercaseString];
    for (NSString *tok in tokens) {
        if (tok.length == 0) continue;
        if (appL.length > 0 && ([appL isEqualToString:tok] || [appL containsString:tok] || [tok containsString:appL])) return YES;
        if (bunL.length > 0 && ([bunL isEqualToString:tok] || [bunL containsString:tok])) return YES;
        if (titL.length > 0 && [titL containsString:tok]) return YES;
    }
    return NO;
}

static BOOL isSystemIgnoreApp(NSString *ownerName, NSString *bundleId, NSString *title) {
    static NSSet *ignoreOwners = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        ignoreOwners = [NSSet setWithArray:@[
            @"Window Server", @"WindowServer", @"Control Center", @"ControlCenter",
            @"Dock", @"Notification Center", @"NotificationCenter", @"SystemUIServer",
            @"Spotlight", @"Wallpaper", @"loginwindow", @"UniversalControl",
            @"ghostpaw-macos-helper", @"agent-desktop", @"agent-desktop-macos-helper"
        ]];
    });
    if (ownerName && [ignoreOwners containsObject:ownerName]) return YES;
    if (title && ([title containsString:@"ghostpaw-cursor"] || [title containsString:@"cursor-overlay"])) return YES;
    return NO;
}

// ============================================================================
// 2. Window Discovery & AXWindow <-> CGWindowID Mapping
// ============================================================================

@interface GPResolvedWindow : NSObject
@property (nonatomic, assign) CGWindowID cgWindowId;
@property (nonatomic, assign) pid_t pid;
@property (nonatomic, copy) NSString *appName;
@property (nonatomic, copy) NSString *bundleId;
@property (nonatomic, copy) NSString *title;
@property (nonatomic, assign) CGRect bounds;
@property (nonatomic, assign) BOOL focused;
@property (nonatomic, assign) BOOL minimized;
@property (nonatomic, assign) AXUIElementRef axWindow; // retained
@property (nonatomic, assign) AXUIElementRef axApp;    // retained
@end

@implementation GPResolvedWindow
- (void)dealloc {
    if (_axWindow) { CFRelease(_axWindow); _axWindow = NULL; }
    if (_axApp) { CFRelease(_axApp); _axApp = NULL; }
}
@end

static void attachAXHandlesToWindow(GPResolvedWindow *item) {
    if (!item || item.pid <= 0 || item.axWindow) return;
    AXUIElementRef axApp = item.axApp ? (AXUIElementRef)CFRetain(item.axApp) : AXUIElementCreateApplication(item.pid);
    if (!axApp) return;
    AXUIElementSetMessagingTimeout(axApp, 0.45f);
    if (!item.axApp) {
        item.axApp = (AXUIElementRef)CFRetain(axApp);
    }
    CFTypeRef axWins = NULL;
    if (AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute, &axWins) == kAXErrorSuccess && axWins) {
        if (CFGetTypeID(axWins) == CFArrayGetTypeID()) {
            CFIndex cnt = CFArrayGetCount((CFArrayRef)axWins);
            AXUIElementRef fallbackW = NULL;
            for (CFIndex i = 0; i < cnt; i++) {
                AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)axWins, i);
                if (![axStr(w, kAXRoleAttribute) isEqualToString:@"AXWindow"]) continue;
                NSString *wTitle = axStr(w, kAXTitleAttribute);
                if ([item.bundleId isEqualToString:@"com.apple.TextEdit"] &&
                    ([wTitle isEqualToString:@"Open"] || [wTitle isEqualToString:@"打开"]) &&
                    cnt > 1) {
                    continue;
                }
                if (!fallbackW) fallbackW = w;
                CGWindowID wid = 0;
                _AXUIElementGetWindow(w, &wid);
                if (wid != 0 && wid == item.cgWindowId) {
                    item.axWindow = (AXUIElementRef)CFRetain(w);
                    if (wTitle.length > 0) item.title = wTitle;
                    item.bounds = axFrame(w);
                    break;
                }
            }
            if (!item.axWindow && fallbackW) {
                item.axWindow = (AXUIElementRef)CFRetain(fallbackW);
                NSString *wTitle = axStr(fallbackW, kAXTitleAttribute);
                if (wTitle.length > 0) item.title = wTitle;
                item.bounds = axFrame(fallbackW);
            }
        }
        CFRelease(axWins);
    }
    CFRelease(axApp);
}

static NSArray<GPResolvedWindow *> *enumerateAllDesktopWindows(NSString *appFilter) {
    NSMutableArray<GPResolvedWindow *> *results = [NSMutableArray array];
    NSMutableSet<NSNumber *> *seenWindowIds = [NSMutableSet set];

    NSRunningApplication *frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    pid_t frontPid = frontApp ? frontApp.processIdentifier : -1;

    NSMutableDictionary<NSNumber *, NSRunningApplication *> *appByPid = [NSMutableDictionary dictionary];
    for (NSRunningApplication *ra in [[NSWorkspace sharedWorkspace] runningApplications]) {
        appByPid[@(ra.processIdentifier)] = ra;
    }

    // 1. Ultra-fast CGWindowListCopyWindowInfo (<0.5ms, zero cross-process AX IPC blocking)
    CFArrayRef cgList = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (cgList) {
        CFIndex cnt = CFArrayGetCount(cgList);
        for (CFIndex i = 0; i < cnt; i++) {
            NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(cgList, i);
            int layer = [info[(id)kCGWindowLayer] intValue];
            if (layer != 0) continue;
            CGWindowID wid = (CGWindowID)[info[(id)kCGWindowNumber] unsignedIntValue];
            if (wid == 0 || [seenWindowIds containsObject:@(wid)]) continue;
            pid_t pid = (pid_t)[info[(id)kCGWindowOwnerPID] intValue];
            NSRunningApplication *ra = appByPid[@(pid)];
            NSString *ownerName = info[(id)kCGWindowOwnerName] ?: (ra.localizedName ?: @"");
            NSString *bundleId = ra ? (ra.bundleIdentifier ?: @"") : @"";
            NSString *winName = info[(id)kCGWindowName] ?: @"";
            if (winName.length == 0) winName = ownerName;
            if (isSystemIgnoreApp(ownerName, bundleId, winName)) continue;
            if (([bundleId isEqualToString:@"com.apple.TextEdit"] || [ownerName isEqualToString:@"TextEdit"]) &&
                ([winName isEqualToString:@"Open"] || [winName isEqualToString:@"打开"])) {
                continue;
            }

            CGRect bounds = CGRectZero;
            CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(id)kCGWindowBounds], &bounds);
            if (bounds.size.width < 60 || bounds.size.height < 40) continue;

            if (appFilter && appFilter.length > 0 && !matchesAppCandidate(appFilter, ownerName, bundleId, winName)) {
                continue;
            }

            GPResolvedWindow *item = [[GPResolvedWindow alloc] init];
            item.cgWindowId = wid;
            item.pid = pid;
            item.appName = ownerName;
            item.bundleId = bundleId;
            item.title = winName;
            item.bounds = bounds;
            item.focused = (pid == frontPid);
            item.minimized = NO;
            [results addObject:item];
            [seenWindowIds addObject:@(wid)];
        }
        CFRelease(cgList);
    }

    // 2. If appFilter is specified and CGWindowList didn't find it (e.g. minimized window or title only in AX), query only matching app's AXWindows
    if (appFilter && appFilter.length > 0 && results.count == 0) {
        for (NSRunningApplication *ra in [[NSWorkspace sharedWorkspace] runningApplications]) {
            if (ra.terminated || ra.activationPolicy != NSApplicationActivationPolicyRegular) continue;
            NSString *appName = ra.localizedName ?: @"";
            NSString *bundleId = ra.bundleIdentifier ?: @"";
            if (!matchesAppCandidate(appFilter, appName, bundleId, @"")) continue;

            AXUIElementRef axApp = AXUIElementCreateApplication(ra.processIdentifier);
            if (!axApp) continue;
            AXUIElementSetMessagingTimeout(axApp, 0.45f);
            CFTypeRef axWins = NULL;
            if (AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute, &axWins) == kAXErrorSuccess && axWins) {
                if (CFGetTypeID(axWins) == CFArrayGetTypeID()) {
                    CFIndex cnt = CFArrayGetCount((CFArrayRef)axWins);
                    for (CFIndex i = 0; i < cnt; i++) {
                        AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)axWins, i);
                        if (![axStr(w, kAXRoleAttribute) isEqualToString:@"AXWindow"]) continue;
                        NSString *title = axStr(w, kAXTitleAttribute);
                        if ([bundleId isEqualToString:@"com.apple.TextEdit"] &&
                            ([title isEqualToString:@"Open"] || [title isEqualToString:@"打开"]) &&
                            cnt > 1) {
                            continue;
                        }
                        CGWindowID wid = 0;
                        _AXUIElementGetWindow(w, &wid);
                        if (wid == 0) wid = (CGWindowID)(ra.processIdentifier * 100 + i);
                        GPResolvedWindow *item = [[GPResolvedWindow alloc] init];
                        item.cgWindowId = wid;
                        item.pid = ra.processIdentifier;
                        item.appName = appName;
                        item.bundleId = bundleId;
                        item.title = title.length > 0 ? title : appName;
                        item.bounds = axFrame(w);
                        item.focused = (ra.processIdentifier == frontPid);
                        item.minimized = axBool(w, kAXMinimizedAttribute, NO);
                        item.axWindow = (AXUIElementRef)CFRetain(w);
                        item.axApp = (AXUIElementRef)CFRetain(axApp);
                        [results addObject:item];
                    }
                }
                CFRelease(axWins);
            }
            CFRelease(axApp);
        }
    }

    return results;
}

static GPResolvedWindow *findTargetWindow(long explicitWinId, NSString *appHint, BOOL hasCoord, CGFloat x, CGFloat y) {
    if (explicitWinId > 0) {
        NSArray<GPResolvedWindow *> *allWins = enumerateAllDesktopWindows(nil);
        for (GPResolvedWindow *w in allWins) {
            if ((long)w.cgWindowId == explicitWinId) {
                attachAXHandlesToWindow(w);
                return w;
            }
        }
    }
    if (appHint && appHint.length > 0) {
        NSArray<GPResolvedWindow *> *appWins = enumerateAllDesktopWindows(appHint);
        GPResolvedWindow *firstMatch = nil;
        for (GPResolvedWindow *w in appWins) {
            if (matchesAppCandidate(appHint, w.appName, w.bundleId, w.title)) {
                if (hasCoord && CGRectContainsPoint(w.bounds, CGPointMake(x, y))) {
                    attachAXHandlesToWindow(w);
                    return w;
                }
                if (!firstMatch) firstMatch = w;
            }
        }
        if (firstMatch) attachAXHandlesToWindow(firstMatch);
        return firstMatch;
    }
    NSArray<GPResolvedWindow *> *allWins = enumerateAllDesktopWindows(nil);
    if (hasCoord) {
        for (GPResolvedWindow *w in allWins) {
            if (CGRectContainsPoint(w.bounds, CGPointMake(x, y))) {
                attachAXHandlesToWindow(w);
                return w;
            }
        }
    }
    GPResolvedWindow *first = allWins.firstObject;
    if (first) attachAXHandlesToWindow(first);
    return first;
}

// ============================================================================
// 3. Background App Launch & Document Readiness (Zero Focus Theft)
// ============================================================================

static AXUIElementRef findAXElementRecursive(AXUIElementRef root, BOOL (^predicate)(AXUIElementRef el), int depth, int maxDepth) {
    if (!root || depth > maxDepth) return NULL;
    if (predicate(root)) {
        return (AXUIElementRef)CFRetain(root);
    }
    CFTypeRef children = NULL;
    if (AXUIElementCopyAttributeValue(root, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
        if (CFGetTypeID(children) == CFArrayGetTypeID()) {
            CFIndex cnt = CFArrayGetCount((CFArrayRef)children);
            for (CFIndex i = 0; i < cnt; i++) {
                AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children, i);
                AXUIElementRef found = findAXElementRecursive(child, predicate, depth + 1, maxDepth);
                if (found) {
                    CFRelease(children);
                    return found;
                }
            }
        }
        CFRelease(children);
    }
    return NULL;
}

static void ensureTextEditHasDocumentWindowInBackground(pid_t pid) {
    AXUIElementRef appRef = AXUIElementCreateApplication(pid);
    if (!appRef) return;
    AXUIElementSetMessagingTimeout(appRef, 0.5f);
    AXUIElementRef textArea = findAXElementRecursive(appRef, ^BOOL(AXUIElementRef el) {
        NSString *role = axStr(el, kAXRoleAttribute);
        return [role isEqualToString:@"AXTextArea"];
    }, 0, 10);
    if (textArea) {
        CFRelease(textArea);
        CFRelease(appRef);
        return;
    }
    // Trigger File -> New (`newDocument:`) in AXMenuBar without activating TextEdit!
    AXUIElementRef newMenu = findAXElementRecursive(appRef, ^BOOL(AXUIElementRef el) {
        NSString *role = axStr(el, kAXRoleAttribute);
        if (![role isEqualToString:@"AXMenuItem"]) return NO;
        NSString *ident = axStr(el, CFSTR("AXIdentifier"));
        NSString *title = axStr(el, kAXTitleAttribute);
        return [ident isEqualToString:@"newDocument:"] ||
               [title isEqualToString:@"New"] ||
               [title isEqualToString:@"New…"] ||
               [title isEqualToString:@"新建"] ||
               [title isEqualToString:@"新建…"];
    }, 0, 6);
    if (newMenu) {
        AXUIElementPerformAction(newMenu, kAXPressAction);
        CFRelease(newMenu);
        [NSThread sleepForTimeInterval:0.35];
    }
    // Dismiss any lingering Open panel ("Cancel" / "取消") so only the document window remains
    CFTypeRef axWins = NULL;
    if (AXUIElementCopyAttributeValue(appRef, kAXWindowsAttribute, &axWins) == kAXErrorSuccess && axWins) {
        if (CFGetTypeID(axWins) == CFArrayGetTypeID()) {
            CFIndex cnt = CFArrayGetCount((CFArrayRef)axWins);
            for (CFIndex i = 0; i < cnt; i++) {
                AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)axWins, i);
                NSString *wTitle = axStr(w, kAXTitleAttribute);
                if ([wTitle isEqualToString:@"Open"] || [wTitle isEqualToString:@"打开"]) {
                    AXUIElementRef cancelBtn = findAXElementRecursive(w, ^BOOL(AXUIElementRef el) {
                        if (![axStr(el, kAXRoleAttribute) isEqualToString:@"AXButton"]) return NO;
                        NSString *bt = axStr(el, kAXTitleAttribute);
                        return [bt isEqualToString:@"Cancel"] || [bt isEqualToString:@"取消"];
                    }, 0, 5);
                    if (cancelBtn) {
                        AXUIElementPerformAction(cancelBtn, kAXPressAction);
                        CFRelease(cancelBtn);
                    }
                }
            }
        }
        CFRelease(axWins);
    }
    CFRelease(appRef);
}

static GPResolvedWindow *launchOrAttachAppInBackground(NSString *rawApp) {
    NSRunningApplication *frontBefore = [[NSWorkspace sharedWorkspace] frontmostApplication];
    NSString *targetBundleId = nil;
    NSString *resolvedName = resolveMacAppNameForLaunch(rawApp, &targetBundleId);

    // 1. Check if already running with a window
    GPResolvedWindow *existing = findTargetWindow(0, rawApp, NO, 0, 0);
    if (existing) {
        if ([existing.bundleId isEqualToString:@"com.apple.TextEdit"]) {
            ensureTextEditHasDocumentWindowInBackground(existing.pid);
            existing = findTargetWindow(0, rawApp, NO, 0, 0) ?: existing;
        }
        if (existing.minimized && existing.axWindow) {
            AXUIElementSetAttributeValue(existing.axWindow, kAXMinimizedAttribute, kCFBooleanFalse);
        }
        if (frontBefore && !frontBefore.isActive) {
            [frontBefore activateWithOptions:0];
        }
        return existing;
    }

    // 2. Launch in background via /usr/bin/open -g -a <App>
    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/usr/bin/open";
    if (targetBundleId && [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:targetBundleId]) {
        task.arguments = @[@"-g", @"-b", targetBundleId];
    } else {
        task.arguments = @[@"-g", @"-a", resolvedName];
    }
    @try {
        [task launch];
        [task waitUntilExit];
    } @catch (NSException *ex) {}

    // 3. Poll up to 4.0s for the background app and its window to initialize
    GPResolvedWindow *launched = nil;
    for (int tick = 0; tick < 50; tick++) {
        [NSThread sleepForTimeInterval:0.08];
        if (frontBefore && !frontBefore.isActive) {
            [frontBefore activateWithOptions:0];
        }
        if (targetBundleId) {
            NSRunningApplication *ra = [NSRunningApplication runningApplicationsWithBundleIdentifier:targetBundleId].firstObject;
            if (ra && [targetBundleId isEqualToString:@"com.apple.TextEdit"] && tick >= 4) {
                ensureTextEditHasDocumentWindowInBackground(ra.processIdentifier);
            }
        }
        launched = findTargetWindow(0, rawApp, NO, 0, 0);
        if (launched) {
            if ([launched.bundleId isEqualToString:@"com.apple.TextEdit"]) {
                ensureTextEditHasDocumentWindowInBackground(launched.pid);
                launched = findTargetWindow(0, rawApp, NO, 0, 0) ?: launched;
            }
            if (launched.minimized && launched.axWindow) {
                AXUIElementSetAttributeValue(launched.axWindow, kAXMinimizedAttribute, kCFBooleanFalse);
            }
            break;
        }
    }

    if (frontBefore && !frontBefore.isActive) {
        [frontBefore activateWithOptions:0];
    }
    return launched;
}

// ============================================================================
// 4. Calculator Fast-Path & AXUIElement / CGEvent Background Passthrough
// ============================================================================

static NSArray<NSString *> *resolveCalculatorButtonIdentifiers(NSString *autoId, NSString *elName) {
    NSString *aid = [[autoId ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
    NSString *nm = [[elName ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];

    NSDictionary<NSString *, NSArray<NSString *> *> *map = @{
        @"num0button": @[@"Zero"], @"0": @[@"Zero"], @"zero": @[@"Zero"], @"零": @[@"Zero"],
        @"num1button": @[@"One"], @"1": @[@"One"], @"one": @[@"One"], @"一": @[@"One"],
        @"num2button": @[@"Two"], @"2": @[@"Two"], @"two": @[@"Two"], @"二": @[@"Two"],
        @"num3button": @[@"Three"], @"3": @[@"Three"], @"three": @[@"Three"], @"三": @[@"Three"],
        @"num4button": @[@"Four"], @"4": @[@"Four"], @"four": @[@"Four"], @"四": @[@"Four"],
        @"num5button": @[@"Five"], @"5": @[@"Five"], @"five": @[@"Five"], @"五": @[@"Five"],
        @"num6button": @[@"Six"], @"6": @[@"Six"], @"six": @[@"Six"], @"六": @[@"Six"],
        @"num7button": @[@"Seven"], @"7": @[@"Seven"], @"seven": @[@"Seven"], @"七": @[@"Seven"],
        @"num8button": @[@"Eight"], @"8": @[@"Eight"], @"eight": @[@"Eight"], @"八": @[@"Eight"],
        @"num9button": @[@"Nine"], @"9": @[@"Nine"], @"nine": @[@"Nine"], @"九": @[@"Nine"],
        @"plusbutton": @[@"Add"], @"+": @[@"Add"], @"add": @[@"Add"], @"plus": @[@"Add"], @"加": @[@"Add"],
        @"minusbutton": @[@"Subtract"], @"-": @[@"Subtract"], @"subtract": @[@"Subtract"], @"minus": @[@"Subtract"], @"减": @[@"Subtract"],
        @"multiplybutton": @[@"Multiply"], @"*": @[@"Multiply"], @"×": @[@"Multiply"], @"multiply": @[@"Multiply"], @"multiply by": @[@"Multiply"], @"乘": @[@"Multiply"], @"乘以": @[@"Multiply"],
        @"dividebutton": @[@"Divide"], @"/": @[@"Divide"], @"÷": @[@"Divide"], @"divide": @[@"Divide"], @"divide by": @[@"Divide"], @"除": @[@"Divide"], @"除以": @[@"Divide"],
        @"equalbutton": @[@"Equals"], @"=": @[@"Equals"], @"equals": @[@"Equals"], @"enter": @[@"Equals"], @"return": @[@"Equals"], @"等于": @[@"Equals"],
        @"decimalseparatorbutton": @[@"Decimal"], @".": @[@"Decimal"], @"decimal": @[@"Decimal"], @"point": @[@"Decimal"], @"小数点": @[@"Decimal"],
        @"percentbutton": @[@"Percent"], @"%": @[@"Percent"], @"percent": @[@"Percent"], @"百分号": @[@"Percent"],
        @"negatebutton": @[@"Negate"], @"negate": @[@"Negate"], @"change sign": @[@"Negate"], @"正负号": @[@"Negate"],
        @"backspacebutton": @[@"Delete"], @"backspace": @[@"Delete"], @"delete": @[@"Delete"], @"退格": @[@"Delete"],
        @"clearbutton": @[@"Clear", @"AllClear"], @"clearentrybutton": @[@"Clear", @"AllClear"],
        @"allclear": @[@"Clear", @"AllClear"], @"all clear": @[@"Clear", @"AllClear"],
        @"clear": @[@"Clear", @"AllClear"], @"ac": @[@"Clear", @"AllClear"], @"ce": @[@"Clear", @"AllClear"],
        @"escape": @[@"Clear", @"AllClear"], @"esc": @[@"Clear", @"AllClear"], @"清除": @[@"Clear", @"AllClear"], @"全部清除": @[@"Clear", @"AllClear"]
    };

    if (aid.length > 0 && map[aid]) return map[aid];
    if (nm.length > 0 && map[nm]) return map[nm];
    return nil;
}

static BOOL pressCalculatorButtonsInBackground(AXUIElementRef axRoot, NSArray<NSString *> *targetIds, NSString **outPressedName, CGRect *outBtnRect) {
    if (!axRoot || targetIds.count == 0) return NO;
    BOOL anyPressed = NO;
    for (NSString *tid in targetIds) {
        AXUIElementRef btn = findAXElementRecursive(axRoot, ^BOOL(AXUIElementRef el) {
            NSString *role = axStr(el, kAXRoleAttribute);
            if (![role isEqualToString:@"AXButton"]) return NO;
            NSString *ident = axStr(el, CFSTR("AXIdentifier"));
            NSString *desc = axStr(el, kAXDescriptionAttribute);
            NSString *title = axStr(el, kAXTitleAttribute);
            return ([ident caseInsensitiveCompare:tid] == NSOrderedSame) ||
                   ([desc caseInsensitiveCompare:tid] == NSOrderedSame) ||
                   ([title caseInsensitiveCompare:tid] == NSOrderedSame);
        }, 0, 12);
        if (btn) {
            if (AXUIElementPerformAction(btn, kAXPressAction) == kAXErrorSuccess) {
                anyPressed = YES;
                if (outPressedName) *outPressedName = tid;
                if (outBtnRect) *outBtnRect = axFrame(btn);
            }
            CFRelease(btn);
            if (targetIds.count > 1) {
                [NSThread sleepForTimeInterval:0.04];
            }
        }
    }
    return anyPressed;
}

static CGKeyCode keyCodeForName(NSString *keyName, BOOL *outHasKeyCode) {
    NSString *k = [[keyName ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
    *outHasKeyCode = YES;
    if ([k isEqualToString:@"return"] || [k isEqualToString:@"enter"]) return 36;
    if ([k isEqualToString:@"tab"]) return 48;
    if ([k isEqualToString:@"space"]) return 49;
    if ([k isEqualToString:@"backspace"] || [k isEqualToString:@"bksp"]) return 51;
    if ([k isEqualToString:@"delete"] || [k isEqualToString:@"del"]) return 117;
    if ([k isEqualToString:@"escape"] || [k isEqualToString:@"esc"]) return 53;
    if ([k isEqualToString:@"left"] || [k isEqualToString:@"arrowleft"]) return 123;
    if ([k isEqualToString:@"right"] || [k isEqualToString:@"arrowright"]) return 124;
    if ([k isEqualToString:@"down"] || [k isEqualToString:@"arrowdown"]) return 125;
    if ([k isEqualToString:@"up"] || [k isEqualToString:@"arrowup"]) return 126;
    if ([k isEqualToString:@"home"]) return 115;
    if ([k isEqualToString:@"end"]) return 119;
    if ([k isEqualToString:@"pageup"] || [k isEqualToString:@"pgup"]) return 116;
    if ([k isEqualToString:@"pagedown"] || [k isEqualToString:@"pgdn"]) return 121;

    NSDictionary<NSString *, NSNumber *> *charMap = @{
        @"a": @0, @"s": @1, @"d": @2, @"f": @3, @"h": @4, @"g": @5, @"z": @6, @"x": @7,
        @"c": @8, @"v": @9, @"b": @11, @"q": @12, @"w": @13, @"e": @14, @"r": @15,
        @"y": @16, @"t": @17, @"1": @18, @"2": @19, @"3": @20, @"4": @21, @"6": @22,
        @"5": @23, @"=": @24, @"9": @25, @"7": @26, @"-": @27, @"8": @28, @"0": @29,
        @"]": @30, @"o": @31, @"u": @32, @"[": @33, @"i": @34, @"p": @35, @"l": @37,
        @"j": @38, @"'": @39, @"k": @40, @";": @41, @"\\": @42, @",": @43, @"/": @44,
        @"n": @45, @"m": @46, @".": @47
    };
    if (charMap[k]) return (CGKeyCode)[charMap[k] unsignedShortValue];
    *outHasKeyCode = NO;
    return 0;
}

static BOOL postKeyComboToPid(pid_t pid, NSString *rawCombo, AXUIElementRef axApp) {
    if (pid <= 0 || !rawCombo || rawCombo.length == 0) return NO;
    NSString *lower = [[rawCombo stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];

    // Check if standard menu action in AXMenuBar can fulfill shortcut in background
    if (axApp) {
        NSDictionary<NSString *, NSString *> *menuActionByCombo = @{
            @"cmd+n": @"newDocument:", @"ctrl+n": @"newDocument:",
            @"cmd+a": @"selectAll:", @"ctrl+a": @"selectAll:",
            @"cmd+c": @"copy:", @"ctrl+c": @"copy:",
            @"cmd+v": @"paste:", @"ctrl+v": @"paste:",
            @"cmd+x": @"cut:", @"ctrl+x": @"cut:",
            @"cmd+z": @"undo:", @"ctrl+z": @"undo:",
            @"cmd+shift+z": @"redo:", @"ctrl+y": @"redo:",
        };
        NSString *targetSelector = menuActionByCombo[lower];
        if (targetSelector) {
            AXUIElementRef menuItem = findAXElementRecursive(axApp, ^BOOL(AXUIElementRef el) {
                return [axStr(el, kAXRoleAttribute) isEqualToString:@"AXMenuItem"] &&
                       [axStr(el, CFSTR("AXIdentifier")) isEqualToString:targetSelector];
            }, 0, 5);
            if (menuItem) {
                AXError err = AXUIElementPerformAction(menuItem, kAXPressAction);
                CFRelease(menuItem);
                if (err == kAXErrorSuccess) return YES;
            }
        }
    }

    NSArray<NSString *> *parts = [lower componentsSeparatedByString:@"+"];
    CGEventFlags flags = 0;
    NSString *mainKey = @"enter";
    for (NSUInteger i = 0; i < parts.count; i++) {
        NSString *p = [parts[i] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (p.length == 0) continue;
        if (i + 1 < parts.count) {
            if ([p isEqualToString:@"cmd"] || [p isEqualToString:@"command"] || [p isEqualToString:@"meta"] || [p isEqualToString:@"super"] || [p isEqualToString:@"win"]) {
                flags |= kCGEventFlagMaskCommand;
                continue;
            }
            if ([p isEqualToString:@"ctrl"] || [p isEqualToString:@"control"]) {
                flags |= kCGEventFlagMaskControl;
                continue;
            }
            if ([p isEqualToString:@"alt"] || [p isEqualToString:@"option"] || [p isEqualToString:@"opt"]) {
                flags |= kCGEventFlagMaskAlternate;
                continue;
            }
            if ([p isEqualToString:@"shift"]) {
                flags |= kCGEventFlagMaskShift;
                continue;
            }
        }
        mainKey = p;
    }

    BOOL hasCode = NO;
    CGKeyCode kc = keyCodeForName(mainKey, &hasCode);
    CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (hasCode) {
        CGEventRef kd = CGEventCreateKeyboardEvent(src, kc, true);
        CGEventRef ku = CGEventCreateKeyboardEvent(src, kc, false);
        if (flags != 0) {
            CGEventSetFlags(kd, flags);
            CGEventSetFlags(ku, flags);
        }
        CGEventPostToPid(pid, kd);
        [NSThread sleepForTimeInterval:0.015];
        CGEventPostToPid(pid, ku);
        if (kd) CFRelease(kd);
        if (ku) CFRelease(ku);
        if (src) CFRelease(src);
        return YES;
    } else if (mainKey.length > 0) {
        unichar ch = [mainKey characterAtIndex:0];
        CGEventRef kd = CGEventCreateKeyboardEvent(src, 0, true);
        CGEventRef ku = CGEventCreateKeyboardEvent(src, 0, false);
        CGEventKeyboardSetUnicodeString(kd, 1, &ch);
        CGEventKeyboardSetUnicodeString(ku, 1, &ch);
        if (flags != 0) {
            CGEventSetFlags(kd, flags);
            CGEventSetFlags(ku, flags);
        }
        CGEventPostToPid(pid, kd);
        [NSThread sleepForTimeInterval:0.015];
        CGEventPostToPid(pid, ku);
        if (kd) CFRelease(kd);
        if (ku) CFRelease(ku);
        if (src) CFRelease(src);
        return YES;
    }
    if (src) CFRelease(src);
    return NO;
}

static NSDictionary *executeBgActionDict(NSDictionary *req) {
    NSString *action = [safeStr(req[@"action"]) lowercaseString];
    BOOL hasCoord = [req[@"hasExplicitCoord"] boolValue];
    CGFloat x = req[@"x"] && req[@"x"] != [NSNull null] ? [req[@"x"] doubleValue] : 500.0;
    CGFloat y = req[@"y"] && req[@"y"] != [NSNull null] ? [req[@"y"] doubleValue] : 400.0;
    CGFloat width = req[@"width"] && req[@"width"] != [NSNull null] ? [req[@"width"] doubleValue] : 800.0;
    CGFloat height = req[@"height"] && req[@"height"] != [NSNull null] ? [req[@"height"] doubleValue] : 600.0;
    NSString *appHint = safeStr(req[@"app"]);
    long explicitHwnd = req[@"windowHandle"] && req[@"windowHandle"] != [NSNull null] ? [req[@"windowHandle"] longValue] : 0;
    NSString *reqName = [safeStr(req[@"elementName"]) stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSString *reqRole = [[safeStr(req[@"elementRole"]) stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
    NSString *reqAutoId = [safeStr(req[@"automationId"]) stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSString *text = safeStr(req[@"text"]);
    BOOL clearFirst = [req[@"clearFirst"] boolValue];
    BOOL pressEnter = [req[@"pressEnter"] boolValue];
    NSString *keyCombo = safeStr(req[@"key"]);

    NSRunningApplication *frontBefore = [[NSWorkspace sharedWorkspace] frontmostApplication];

    if ([action isEqualToString:@"launch_background"]) {
        GPResolvedWindow *win = launchOrAttachAppInBackground(appHint);
        if (win) {
            return @{
                @"ok": @YES,
                @"method": @"macos-launch-background-noactivate",
                @"windowTitle": win.title ?: win.appName ?: @"",
                @"hwnd": @(win.cgWindowId)
            };
        }
        return @{
            @"ok": @NO,
            @"method": @"macos-launch-background-failed",
            @"error": [NSString stringWithFormat:@"Could not launch or find window for app '%@'", appHint]
        };
    }

    GPResolvedWindow *win = findTargetWindow(explicitHwnd, appHint, hasCoord, x, y);
    if (!win && appHint.length > 0) {
        win = launchOrAttachAppInBackground(appHint);
    }
    if (!win) {
        return @{
            @"ok": @NO,
            @"method": @"macos-window-not-found",
            @"error": @"Target macOS window not found"
        };
    }

    if ([action isEqualToString:@"restore_no_activate"] || [action isEqualToString:@"focus_no_activate"]) {
        if (win.minimized && win.axWindow) {
            AXUIElementSetAttributeValue(win.axWindow, kAXMinimizedAttribute, kCFBooleanFalse);
        }
        if (frontBefore && !frontBefore.isActive) {
            [frontBefore activateWithOptions:0];
        }
        return @{
            @"ok": @YES,
            @"method": @"macos-passive-ready-no-zorder-change",
            @"windowTitle": win.title ?: @"",
            @"hwnd": @(win.cgWindowId)
        };
    }

    if ([action isEqualToString:@"move_window_background"]) {
        BOOL ok = axSetFrameOrigin(win.axWindow, x, y);
        return @{
            @"ok": @(ok),
            @"method": @"macos-ax-move-window-noactivate",
            @"windowTitle": win.title ?: @"",
            @"hwnd": @(win.cgWindowId)
        };
    }

    if ([action isEqualToString:@"resize_window_background"]) {
        BOOL ok = axSetFrameSize(win.axWindow, width, height);
        return @{
            @"ok": @(ok),
            @"method": @"macos-ax-resize-window-noactivate",
            @"windowTitle": win.title ?: @"",
            @"hwnd": @(win.cgWindowId)
        };
    }

    AXUIElementRef searchRoot = win.axWindow ?: win.axApp;
    BOOL isCalculator = [win.bundleId isEqualToString:@"com.apple.calculator"] ||
                        [[win.appName lowercaseString] containsString:@"calculator"] ||
                        [win.appName containsString:@"计算器"];

    // Fast-path 1: macOS Calculator button press by automationId / name / key
    if (isCalculator && ([action isEqualToString:@"click"] || [action isEqualToString:@"left_click"] || [action isEqualToString:@"clear"] || [action isEqualToString:@"key"] || [action isEqualToString:@"hotkey"])) {
        NSArray<NSString *> *calcIds = nil;
        if ([action isEqualToString:@"clear"]) {
            calcIds = @[@"Clear", @"AllClear"];
        } else if ([action isEqualToString:@"key"] || [action isEqualToString:@"hotkey"]) {
            calcIds = resolveCalculatorButtonIdentifiers(@"", keyCombo);
        } else {
            calcIds = resolveCalculatorButtonIdentifiers(reqAutoId, reqName);
        }
        if (calcIds.count > 0) {
            NSString *pressedName = nil;
            CGRect btnRect = CGRectZero;
            if (pressCalculatorButtonsInBackground(searchRoot, calcIds, &pressedName, &btnRect)) {
                if (frontBefore && !frontBefore.isActive) [frontBefore activateWithOptions:0];
                CGFloat sx = btnRect.size.width > 0 ? round(btnRect.origin.x + btnRect.size.width / 2.0) : x;
                CGFloat sy = btnRect.size.height > 0 ? round(btnRect.origin.y + btnRect.size.height / 2.0) : y;
                return @{
                    @"ok": @YES,
                    @"method": @"macos-calculator-axpress-passthrough",
                    @"windowTitle": win.title ?: @"Calculator",
                    @"elementName": pressedName ?: (reqName ?: @""),
                    @"elementRole": @"button",
                    @"automationId": pressedName ?: (reqAutoId ?: @""),
                    @"hwnd": @(win.cgWindowId),
                    @"screenX": @((int)sx),
                    @"screenY": @((int)sy),
                    @"clientX": @((int)(sx - win.bounds.origin.x)),
                    @"clientY": @((int)(sy - win.bounds.origin.y))
                };
            }
        }
    }

    // Scoped AXUIElement tree search inside target window
    __block AXUIElementRef bestEl = NULL;
    __block double bestScore = -1e18;
    __block NSString *bestName = @"";
    __block NSString *bestRole = @"";
    __block NSString *bestAutoId = @"";

    BOOL wantsTextEditable = ([action isEqualToString:@"type"] || [action isEqualToString:@"set_value"] || [action isEqualToString:@"clear"]);

    void (^ __weak __block weakVisit)(AXUIElementRef, int);
    void (^visit)(AXUIElementRef, int) = ^(AXUIElementRef el, int depth) {
        if (!el || depth > 14) return;
        NSString *axRole = axStr(el, kAXRoleAttribute);
        if ([axRole isEqualToString:@"AXMenuBar"]) return;
        NSString *normRole = normalizeRoleName(axRole, axStr(el, kAXSubroleAttribute));
        NSString *title = axStr(el, kAXTitleAttribute);
        NSString *desc = axStr(el, kAXDescriptionAttribute);
        NSString *ident = axStr(el, CFSTR("AXIdentifier"));
        NSString *name = title.length > 0 ? title : (desc.length > 0 ? desc : ident);
        CGRect rect = axFrame(el);

        BOOL isEditableRole = ([axRole isEqualToString:@"AXTextArea"] ||
                               [axRole isEqualToString:@"AXTextField"] ||
                               [axRole isEqualToString:@"AXSearchField"] ||
                               [axRole isEqualToString:@"AXComboBox"]);

        if (wantsTextEditable && isEditableRole && !hasCoord && reqName.length == 0 && reqAutoId.length == 0) {
            double score = [axRole isEqualToString:@"AXTextArea"] ? 2000000.0 : 1500000.0;
            if (score > bestScore) {
                bestScore = score;
                if (bestEl) CFRelease(bestEl);
                bestEl = (AXUIElementRef)CFRetain(el);
                bestName = name;
                bestRole = normRole;
                bestAutoId = ident;
            }
        } else if (rect.size.width > 0 && rect.size.height > 0) {
            BOOL ptInside = hasCoord &&
                            (x >= rect.origin.x - 6 && x <= rect.origin.x + rect.size.width + 6 &&
                             y >= rect.origin.y - 6 && y <= rect.origin.y + rect.size.height + 6);
            BOOL autoIdExact = (reqAutoId.length > 0 && ident.length > 0 && [ident caseInsensitiveCompare:reqAutoId] == NSOrderedSame);
            BOOL nameExact = (reqName.length > 0 &&
                              (([title caseInsensitiveCompare:reqName] == NSOrderedSame) ||
                               ([desc caseInsensitiveCompare:reqName] == NSOrderedSame) ||
                               ([ident caseInsensitiveCompare:reqName] == NSOrderedSame)));
            BOOL nameSub = (reqName.length > 0 && !nameExact &&
                            ((title.length > 0 && [title localizedCaseInsensitiveContainsString:reqName]) ||
                             (desc.length > 0 && [desc localizedCaseInsensitiveContainsString:reqName])));

            if (ptInside || autoIdExact || nameExact || nameSub || (wantsTextEditable && isEditableRole)) {
                double area = fmin(250000.0, rect.size.width * rect.size.height);
                double cx = rect.origin.x + rect.size.width / 2.0;
                double cy = rect.origin.y + rect.size.height / 2.0;
                double dist = hasCoord ? hypot(x - cx, y - cy) : 0.0;
                double score = 500000.0 - area - (dist * 120.0);
                if (autoIdExact) score += 1500000.0;
                if (nameExact) score += 900000.0;
                else if (nameSub) score += 350000.0;
                if (ptInside) score += 600000.0;
                if (wantsTextEditable && isEditableRole) score += 1200000.0;
                if (reqRole.length > 0 && [normRole containsString:reqRole]) score += 250000.0;
                if ([normRole isEqualToString:@"button"] || isEditableRole || [normRole isEqualToString:@"checkbox"]) {
                    score += 180000.0;
                }
                if ([normRole isEqualToString:@"window"] || [normRole isEqualToString:@"group"]) {
                    score -= 400000.0;
                }
                if (score > bestScore) {
                    bestScore = score;
                    if (bestEl) CFRelease(bestEl);
                    bestEl = (AXUIElementRef)CFRetain(el);
                    bestName = name;
                    bestRole = normRole;
                    bestAutoId = ident;
                }
            }
        }

        CFTypeRef children = NULL;
        if (AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
            if (CFGetTypeID(children) == CFArrayGetTypeID()) {
                CFIndex cnt = CFArrayGetCount((CFArrayRef)children);
                for (CFIndex i = 0; i < cnt; i++) {
                    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children, i);
                    weakVisit(child, depth + 1);
                }
            }
            CFRelease(children);
        }
    };
    weakVisit = visit;
    if (searchRoot) visit(searchRoot, 0);

    BOOL done = NO;
    NSString *method = @"macos-ax-passthrough";

    if (wantsTextEditable) {
        if (!bestEl && [win.bundleId isEqualToString:@"com.apple.TextEdit"]) {
            ensureTextEditHasDocumentWindowInBackground(win.pid);
            win = findTargetWindow(win.cgWindowId, appHint, NO, 0, 0) ?: win;
            if (win.axWindow) visit(win.axWindow, 0);
        }
        if (bestEl) {
            NSString *valToSet = @"";
            if ([action isEqualToString:@"clear"]) {
                valToSet = @"";
            } else if (clearFirst || [action isEqualToString:@"set_value"]) {
                valToSet = text ?: @"";
            } else {
                NSString *curVal = axStr(bestEl, kAXValueAttribute);
                valToSet = curVal.length > 0 ? [curVal stringByAppendingString:(text ?: @"")] : (text ?: @"");
            }
            if (pressEnter && ![action isEqualToString:@"clear"]) {
                valToSet = [valToSet stringByAppendingString:@"\n"];
            }
            AXUIElementSetAttributeValue(bestEl, kAXFocusedAttribute, kCFBooleanTrue);
            AXError setErr = AXUIElementSetAttributeValue(bestEl, kAXValueAttribute, (__bridge CFTypeRef)valToSet);
            if (setErr == kAXErrorSuccess) {
                done = YES;
                method = (clearFirst || [action isEqualToString:@"set_value"])
                    ? @"macos-ax-value-set-passthrough"
                    : @"macos-ax-value-append-passthrough";
            }
        }
        if (!done && win.pid > 0) {
            // Fallback: send Unicode characters directly to target PID via CGEventPostToPid
            CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
            if (clearFirst || [action isEqualToString:@"set_value"] || [action isEqualToString:@"clear"]) {
                postKeyComboToPid(win.pid, @"cmd+a", win.axApp);
                postKeyComboToPid(win.pid, @"backspace", win.axApp);
            }
            if (![action isEqualToString:@"clear"] && text.length > 0) {
                for (NSUInteger i = 0; i < text.length; i++) {
                    unichar ch = [text characterAtIndex:i];
                    CGEventRef kd = CGEventCreateKeyboardEvent(src, 0, true);
                    CGEventRef ku = CGEventCreateKeyboardEvent(src, 0, false);
                    CGEventKeyboardSetUnicodeString(kd, 1, &ch);
                    CGEventKeyboardSetUnicodeString(ku, 1, &ch);
                    CGEventPostToPid(win.pid, kd);
                    CGEventPostToPid(win.pid, ku);
                    if (kd) CFRelease(kd);
                    if (ku) CFRelease(ku);
                }
            }
            if (pressEnter && ![action isEqualToString:@"clear"]) {
                postKeyComboToPid(win.pid, @"return", win.axApp);
            }
            if (src) CFRelease(src);
            done = YES;
            method = @"macos-cgevent-pid-unicode-passthrough";
        }
    } else if ([action isEqualToString:@"click"] || [action isEqualToString:@"left_click"] ||
               [action isEqualToString:@"double_click"] || [action isEqualToString:@"triple_click"] ||
               [action isEqualToString:@"right_click"] || [action isEqualToString:@"toggle"] ||
               [action isEqualToString:@"check"] || [action isEqualToString:@"uncheck"]) {
        if (bestEl) {
            CFStringRef axAction = [action isEqualToString:@"right_click"] ? kAXShowMenuAction : kAXPressAction;
            int reps = [action isEqualToString:@"triple_click"] ? 3 : ([action isEqualToString:@"double_click"] ? 2 : 1);
            for (int r = 0; r < reps; r++) {
                AXError err = AXUIElementPerformAction(bestEl, axAction);
                if (err != kAXErrorSuccess && axAction == kAXShowMenuAction) {
                    err = AXUIElementPerformAction(bestEl, kAXPressAction);
                }
                if (err == kAXErrorSuccess) {
                    done = YES;
                    method = @"macos-ax-press-passthrough";
                }
                if (reps > 1 && r + 1 < reps) [NSThread sleepForTimeInterval:0.03];
            }
        }
        if (!done && isCalculator && bestAutoId.length > 0) {
            NSArray<NSString *> *calcIds = resolveCalculatorButtonIdentifiers(bestAutoId, bestName);
            if (calcIds.count > 0 && pressCalculatorButtonsInBackground(searchRoot, calcIds, NULL, NULL)) {
                done = YES;
                method = @"macos-calculator-coord-axpress";
            }
        }
    } else if ([action isEqualToString:@"key"] || [action isEqualToString:@"hotkey"]) {
        NSString *lowerKey = [keyCombo lowercaseString];
        if (([lowerKey isEqualToString:@"enter"] || [lowerKey isEqualToString:@"return"]) && bestEl && [bestRole isEqualToString:@"textarea"]) {
            NSString *curVal = axStr(bestEl, kAXValueAttribute);
            NSString *nextVal = [curVal stringByAppendingString:@"\n"];
            if (AXUIElementSetAttributeValue(bestEl, kAXValueAttribute, (__bridge CFTypeRef)nextVal) == kAXErrorSuccess) {
                done = YES;
                method = @"macos-ax-textarea-newline";
            }
        }
        if (!done) {
            done = postKeyComboToPid(win.pid, keyCombo, win.axApp);
            method = @"macos-cgevent-pid-key-passthrough";
        }
    } else if ([action isEqualToString:@"scroll"]) {
        int amt = req[@"amount"] && req[@"amount"] != [NSNull null] ? [req[@"amount"] intValue] : 3;
        NSString *dir = [safeStr(req[@"direction"]) lowercaseString];
        int32_t dy = ([dir isEqualToString:@"up"] ? amt * 12 : ([dir isEqualToString:@"down"] ? -amt * 12 : 0));
        int32_t dx = ([dir isEqualToString:@"left"] ? amt * 12 : ([dir isEqualToString:@"right"] ? -amt * 12 : 0));
        CGEventRef scrollEv = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, dy, dx);
        if (scrollEv) {
            CGEventPostToPid(win.pid, scrollEv);
            CFRelease(scrollEv);
            done = YES;
            method = @"macos-cgevent-pid-scroll-passthrough";
        }
    }

    CGRect matchedRect = bestEl ? axFrame(bestEl) : CGRectZero;
    CGFloat finalScreenX = (!hasCoord && matchedRect.size.width > 0) ? round(matchedRect.origin.x + matchedRect.size.width / 2.0) : x;
    CGFloat finalScreenY = (!hasCoord && matchedRect.size.height > 0) ? round(matchedRect.origin.y + matchedRect.size.height / 2.0) : y;

    if (bestEl) CFRelease(bestEl);
    if (frontBefore && !frontBefore.isActive) {
        [frontBefore activateWithOptions:0];
    }

    return @{
        @"ok": @(done),
        @"method": method,
        @"windowTitle": win.title ?: @"",
        @"elementName": bestName ?: (reqName ?: @""),
        @"elementRole": bestRole ?: (reqRole ?: @""),
        @"automationId": bestAutoId ?: (reqAutoId ?: @""),
        @"hwnd": @(win.cgWindowId),
        @"screenX": @((int)finalScreenX),
        @"screenY": @((int)finalScreenY),
        @"clientX": @((int)(finalScreenX - win.bounds.origin.x)),
        @"clientY": @((int)(finalScreenY - win.bounds.origin.y))
    };
}

// ============================================================================
// 5. Mode 1: Multi-Agent Neon Hollow Cursor Overlay Daemon (`--cursor-daemon`)
// ============================================================================

@interface GPAgentOverlayState : NSObject
@property (nonatomic, copy) NSString *agentId;
@property (nonatomic, copy) NSString *labelText;
@property (nonatomic, assign) CGFloat curX;
@property (nonatomic, assign) CGFloat curY;
@property (nonatomic, assign) CGFloat startX;
@property (nonatomic, assign) CGFloat startY;
@property (nonatomic, assign) CGFloat destX;
@property (nonatomic, assign) CGFloat destY;
@property (nonatomic, assign) NSTimeInterval moveStartTime;
@property (nonatomic, assign) NSTimeInterval moveDuration;
@property (nonatomic, assign) NSTimeInterval clickStartTime;
@property (nonatomic, assign) NSTimeInterval lastUpdateTime;
@property (nonatomic, assign) CGRect targetRect;
@property (nonatomic, assign) BOOL visibleState;
@property (nonatomic, strong) NSColor *accentColor;
@property (nonatomic, strong) NSColor *secondaryColor;
@property (nonatomic, assign) CGWindowID targetWindowId;
@property (nonatomic, assign) CGRect targetWindowBounds;
@property (nonatomic, copy) NSString *targetWindowTitle;
@property (nonatomic, strong) NSImage *windowPreviewImage;
@property (nonatomic, assign) NSTimeInterval lastWindowCaptureTime;
- (void)configurePaletteForAgent:(NSString *)agentId;
- (void)resolveAndCaptureBackgroundWindowAtX:(CGFloat)x y:(CGFloat)y;
- (void)refreshTargetWindowImage;
@end

@implementation GPAgentOverlayState

- (instancetype)initWithAgentId:(NSString *)agentId {
    if (self = [super init]) {
        _curX = -100;
        _curY = -100;
        _destX = -100;
        _destY = -100;
        _moveDuration = 0.17;
        _lastUpdateTime = [NSDate timeIntervalSinceReferenceDate];
        _visibleState = NO;
        [self configurePaletteForAgent:agentId];
    }
    return self;
}

- (void)configurePaletteForAgent:(NSString *)agentId {
    self.agentId = agentId ?: @"default";
    NSString *al = [self.agentId lowercaseString];
    if (!agentId || agentId.length == 0 || [al isEqualToString:@"default"]) {
        self.accentColor = [NSColor colorWithSRGBRed:0.220 green:0.741 blue:0.973 alpha:1.0];   // #38BDF8 Cyan
        self.secondaryColor = [NSColor colorWithSRGBRed:0.659 green:0.333 blue:0.969 alpha:1.0]; // #A855F7 Violet
        return;
    }
    if ([al containsString:@"calc"] || [al hasSuffix:@"-1"] || [al hasSuffix:@"_1"]) {
        self.accentColor = [NSColor colorWithSRGBRed:0.000 green:1.000 blue:0.839 alpha:1.0];   // #00FFD6 Mint-Emerald
        self.secondaryColor = [NSColor colorWithSRGBRed:0.220 green:0.741 blue:0.973 alpha:1.0];
        return;
    }
    if ([al containsString:@"text"] || [al containsString:@"note"] || [al containsString:@"edit"] || [al hasSuffix:@"-2"] || [al hasSuffix:@"_2"]) {
        self.accentColor = [NSColor colorWithSRGBRed:1.000 green:0.141 blue:0.561 alpha:1.0];   // #FF248F Cyber-Magenta
        self.secondaryColor = [NSColor colorWithSRGBRed:0.753 green:0.518 blue:0.988 alpha:1.0];
        return;
    }
    if ([al containsString:@"web"] || [al containsString:@"safari"] || [al containsString:@"chrome"] || [al hasSuffix:@"-3"] || [al hasSuffix:@"_3"]) {
        self.accentColor = [NSColor colorWithSRGBRed:0.984 green:0.749 blue:0.141 alpha:1.0];   // #FBBF24 Cyber-Amber
        self.secondaryColor = [NSColor colorWithSRGBRed:0.000 green:1.000 blue:0.839 alpha:1.0];
        return;
    }
    NSUInteger h = 2166136261u;
    for (NSUInteger i = 0; i < agentId.length; i++) {
        h ^= [agentId characterAtIndex:i];
        h *= 16777619u;
    }
    switch (h % 5) {
        case 0:
            self.accentColor = [NSColor colorWithSRGBRed:0.000 green:1.000 blue:0.839 alpha:1.0]; // #00FFD6 Mint-Emerald
            self.secondaryColor = [NSColor colorWithSRGBRed:0.220 green:0.741 blue:0.973 alpha:1.0];
            break;
        case 1:
            self.accentColor = [NSColor colorWithSRGBRed:1.000 green:0.141 blue:0.561 alpha:1.0]; // #FF248F Cyber-Magenta
            self.secondaryColor = [NSColor colorWithSRGBRed:0.753 green:0.518 blue:0.988 alpha:1.0];
            break;
        case 2:
            self.accentColor = [NSColor colorWithSRGBRed:0.984 green:0.749 blue:0.141 alpha:1.0]; // #FBBF24 Amber
            self.secondaryColor = [NSColor colorWithSRGBRed:0.220 green:0.741 blue:0.973 alpha:1.0];
            break;
        case 3:
            self.accentColor = [NSColor colorWithSRGBRed:0.659 green:0.333 blue:0.969 alpha:1.0]; // #A855F7 Purple
            self.secondaryColor = [NSColor colorWithSRGBRed:0.957 green:0.447 blue:0.714 alpha:1.0];
            break;
        default:
            self.accentColor = [NSColor colorWithSRGBRed:0.220 green:0.741 blue:0.973 alpha:1.0]; // #38BDF8 Cyan
            self.secondaryColor = [NSColor colorWithSRGBRed:0.204 green:0.827 blue:0.600 alpha:1.0];
            break;
    }
}

- (void)resolveAndCaptureBackgroundWindowAtX:(CGFloat)x y:(CGFloat)y {
    static GPWindowListCreateImageFn captureFn = NULL;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        captureFn = (GPWindowListCreateImageFn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
    });
    if (!captureFn) return;

    NSRunningApplication *frontApp = [[NSWorkspace sharedWorkspace] frontmostApplication];
    pid_t frontPid = frontApp ? frontApp.processIdentifier : -1;
    NSString *al = [self.agentId ?: @"" lowercaseString];

    CFArrayRef cgList = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!cgList) return;

    CGWindowID matchedWid = 0;
    CGRect matchedBounds = CGRectZero;
    NSString *matchedTitle = @"";

    CFIndex cnt = CFArrayGetCount(cgList);
    for (CFIndex i = 0; i < cnt; i++) {
        NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(cgList, i);
        int layer = [info[(id)kCGWindowLayer] intValue];
        if (layer != 0) continue;
        pid_t pid = (pid_t)[info[(id)kCGWindowOwnerPID] intValue];
        if (pid == frontPid) continue; // Only mirror background/occluded windows!
        NSString *ownerName = info[(id)kCGWindowOwnerName] ?: @"";
        NSString *winName = info[(id)kCGWindowName] ?: ownerName;
        if (isSystemIgnoreApp(ownerName, @"", winName)) continue;
        if (([ownerName isEqualToString:@"TextEdit"] || [ownerName isEqualToString:@"文本编辑"]) &&
            ([winName isEqualToString:@"Open"] || [winName isEqualToString:@"打开"])) {
            continue;
        }

        CGRect b = CGRectZero;
        CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(id)kCGWindowBounds], &b);
        if (b.size.width < 80 || b.size.height < 60) continue;

        NSString *ownerL = [ownerName lowercaseString];
        BOOL agentAppMatch = ([al containsString:@"calc"] && ([ownerL containsString:@"calc"] || [ownerL containsString:@"计算器"])) ||
                             (([al containsString:@"text"] || [al containsString:@"note"]) && ([ownerL containsString:@"textedit"] || [ownerL containsString:@"文本编辑"] || [ownerL containsString:@"notes"] || [ownerL containsString:@"备忘录"]));
        BOOL ptMatch = (x >= b.origin.x - 16 && x <= b.origin.x + b.size.width + 16 &&
                        y >= b.origin.y - 16 && y <= b.origin.y + b.size.height + 16);

        if (agentAppMatch || (ptMatch && matchedWid == 0)) {
            matchedWid = (CGWindowID)[info[(id)kCGWindowNumber] unsignedIntValue];
            matchedBounds = b;
            matchedTitle = [NSString stringWithFormat:@"%@ · %@", ownerName, winName];
            if (agentAppMatch) break;
        }
    }
    CFRelease(cgList);

    if (matchedWid > 0) {
        self.targetWindowId = matchedWid;
        self.targetWindowBounds = matchedBounds;
        self.targetWindowTitle = matchedTitle;
        [self refreshTargetWindowImage];
    }
}

- (void)refreshTargetWindowImage {
    if (self.targetWindowId == 0) return;
    static GPWindowListCreateImageFn captureFn = NULL;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        captureFn = (GPWindowListCreateImageFn)dlsym(RTLD_DEFAULT, "CGWindowListCreateImage");
    });
    if (!captureFn) return;
    CGImageRef cgImg = captureFn(CGRectNull, kCGWindowListOptionIncludingWindow, self.targetWindowId, kCGWindowImageBoundsIgnoreFraming);
    if (cgImg) {
        if (CGImageGetWidth(cgImg) > 10 && CGImageGetHeight(cgImg) > 10) {
            self.windowPreviewImage = [[NSImage alloc] initWithCGImage:cgImg size:self.targetWindowBounds.size];
            self.lastWindowCaptureTime = [NSDate timeIntervalSinceReferenceDate];
        }
        CGImageRelease(cgImg);
    }
}

@end

@interface GhostPawOverlayView : NSView
@property (nonatomic, strong) NSImage *cursorImage;
@property (nonatomic, strong) NSMutableDictionary<NSString *, GPAgentOverlayState *> *agents;
- (GPAgentOverlayState *)stateForAgent:(NSString *)agentId;
- (BOOL)hasAnyVisibleAgent;
@end

@implementation GhostPawOverlayView

- (instancetype)initWithFrame:(NSRect)frameRect {
    if (self = [super initWithFrame:frameRect]) {
        _agents = [NSMutableDictionary dictionary];
    }
    return self;
}

- (BOOL)isFlipped {
    return YES;
}

- (GPAgentOverlayState *)stateForAgent:(NSString *)agentId {
    NSString *key = (agentId && agentId.length > 0) ? agentId : @"default";
    GPAgentOverlayState *st = self.agents[key];
    if (!st) {
        st = [[GPAgentOverlayState alloc] initWithAgentId:key];
        self.agents[key] = st;
    }
    return st;
}

- (BOOL)hasAnyVisibleAgent {
    for (GPAgentOverlayState *st in self.agents.allValues) {
        if (st.visibleState) return YES;
    }
    return NO;
}

- (void)drawRect:(NSRect)dirtyRect {
    if (![self hasAnyVisibleAgent]) return;
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];

    NSArray<NSString *> *sortedKeys = [self.agents.allKeys sortedArrayUsingSelector:@selector(compare:)];

    // Pass 1: Draw Phantom X-Ray Live Mirror of Occluded Background Target Windows (100% Click-Through, isActive=0)
    NSMutableSet<NSNumber *> *drawnWindowIds = [NSMutableSet set];
    for (NSString *key in sortedKeys) {
        GPAgentOverlayState *st = self.agents[key];
        if (!st.visibleState) continue;
        if (st.windowPreviewImage && st.targetWindowBounds.size.width > 40 && st.targetWindowBounds.size.height > 40) {
            if (st.targetWindowId > 0 && [drawnWindowIds containsObject:@(st.targetWindowId)]) continue;
            if (st.targetWindowId > 0) [drawnWindowIds addObject:@(st.targetWindowId)];

            NSRect wb = NSRectFromCGRect(st.targetWindowBounds);
            NSRect frameRect = NSInsetRect(wb, -3.0, -3.0);
            NSBezierPath *framePath = [NSBezierPath bezierPathWithRoundedRect:frameRect xRadius:12.0 yRadius:12.0];
            [[NSColor colorWithSRGBRed:0.04 green:0.06 blue:0.12 alpha:0.55] setFill];
            [framePath fill];

            [NSGraphicsContext saveGraphicsState];
            NSBezierPath *clipPath = [NSBezierPath bezierPathWithRoundedRect:wb xRadius:10.0 yRadius:10.0];
            [clipPath addClip];
            [st.windowPreviewImage drawInRect:wb
                                     fromRect:NSZeroRect
                                    operation:NSCompositingOperationSourceOver
                                     fraction:0.93
                               respectFlipped:YES
                                        hints:nil];
            [NSGraphicsContext restoreGraphicsState];

            framePath.lineWidth = 2.2;
            [[st.accentColor colorWithAlphaComponent:0.85] setStroke];
            [framePath stroke];

            // Top X-Ray badge showing background status (isActive=0)
            NSString *badgeText = [NSString stringWithFormat:@"👻 Phantom X-Ray 后台透视 · %@ (isActive=0 不抢焦点)", st.agentId ?: @"agent"];
            NSFont *bFont = [NSFont systemFontOfSize:11.0 weight:NSFontWeightBold];
            NSDictionary *bAttrs = @{
                NSFontAttributeName: bFont,
                NSForegroundColorAttributeName: [NSColor colorWithSRGBRed:0.04 green:0.06 blue:0.12 alpha:1.0]
            };
            NSSize bSize = [badgeText sizeWithAttributes:bAttrs];
            NSRect badgeRect = NSMakeRect(wb.origin.x + 8.0, fmax(4.0, wb.origin.y - 24.0), ceil(bSize.width + 16.0), 20.0);
            NSBezierPath *badgePath = [NSBezierPath bezierPathWithRoundedRect:badgeRect xRadius:6.0 yRadius:6.0];
            [[st.accentColor colorWithAlphaComponent:0.94] setFill];
            [badgePath fill];
            [badgeText drawAtPoint:NSMakePoint(badgeRect.origin.x + 8.0, badgeRect.origin.y + 3.0) withAttributes:bAttrs];
        }
    }

    // Pass 2: Draw Each Concurrent Agent's Highlight Box, Click Ripple, 3D Neon Hollow GhostPaw Cursor, and Glass Pill
    for (NSString *key in sortedKeys) {
        GPAgentOverlayState *st = self.agents[key];
        if (!st.visibleState) continue;

        // 1. Target Control Highlight Box
        if (st.targetRect.size.width > 2 && st.targetRect.size.height > 2) {
            NSRect tr = NSInsetRect(NSRectFromCGRect(st.targetRect), -2.0, -2.0);
            NSBezierPath *tPath = [NSBezierPath bezierPathWithRoundedRect:tr xRadius:6.0 yRadius:6.0];
            tPath.lineWidth = 1.75;
            [[st.accentColor colorWithAlphaComponent:0.55] setStroke];
            [tPath stroke];
            [[st.accentColor colorWithAlphaComponent:0.08] setFill];
            [tPath fill];
        }

        // 2. Expanding Click Ripple Ring
        NSTimeInterval clickElapsed = now - st.clickStartTime;
        if (clickElapsed >= 0.0 && clickElapsed <= 0.45) {
            CGFloat p = (CGFloat)(clickElapsed / 0.45);
            CGFloat radius = 6.0 + 26.0 * p;
            CGFloat alpha = (1.0 - p) * 0.88;
            NSRect rRect = NSMakeRect(st.curX - radius, st.curY - radius, radius * 2.0, radius * 2.0);
            NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:rRect];
            ring.lineWidth = 2.4;
            [[st.accentColor colorWithAlphaComponent:alpha] setStroke];
            [ring stroke];

            CGFloat innerR = 3.0 + 13.0 * p;
            NSRect iRect = NSMakeRect(st.curX - innerR, st.curY - innerR, innerR * 2.0, innerR * 2.0);
            NSBezierPath *innerRing = [NSBezierPath bezierPathWithOvalInRect:iRect];
            innerRing.lineWidth = 1.6;
            [[st.secondaryColor colorWithAlphaComponent:alpha * 0.85] setStroke];
            [innerRing stroke];
        }

        // 3. Draw 34x34 Neon Hollow GhostPaw Cursor PNG (hotspot 11, 11)
        if (self.cursorImage) {
            NSRect cRect = NSMakeRect(st.curX - 11.0, st.curY - 11.0, 34.0, 34.0);
            [self.cursorImage drawInRect:cRect
                                fromRect:NSZeroRect
                               operation:NSCompositingOperationSourceOver
                                fraction:1.0
                          respectFlipped:YES
                                   hints:nil];
        }

        // 4. Draw Translucent Dark Glass Pill Chat Bubble
        if (st.labelText && st.labelText.length > 0) {
            NSString *displayLabel = st.labelText;
            if (st.agentId && st.agentId.length > 0 && ![st.agentId isEqualToString:@"default"] && ![displayLabel containsString:st.agentId]) {
                if ([displayLabel hasPrefix:@"Agent-Desktop · "]) {
                    displayLabel = [NSString stringWithFormat:@"%@ · %@", st.agentId, [displayLabel substringFromIndex:16]];
                } else {
                    displayLabel = [NSString stringWithFormat:@"%@ · %@", st.agentId, displayLabel];
                }
            }

            NSFont *font = [NSFont systemFontOfSize:12.5 weight:NSFontWeightSemibold];
            NSDictionary *attrs = @{
                NSFontAttributeName: font,
                NSForegroundColorAttributeName: [NSColor colorWithSRGBRed:0.96 green:0.98 blue:1.0 alpha:0.98]
            };
            NSSize textSize = [displayLabel sizeWithAttributes:attrs];
            CGFloat padX = 12.0;
            CGFloat padY = 6.5;
            CGFloat dotSpace = 14.0;
            CGFloat bW = ceil(textSize.width + padX * 2.0 + dotSpace);
            CGFloat bH = ceil(textSize.height + padY * 2.0);

            CGFloat bx = st.curX + 24.0;
            CGFloat by = st.curY + 8.0;
            if (bx + bW > self.bounds.size.width - 12.0) {
                bx = fmax(12.0, st.curX - bW - 14.0);
            }
            if (by + bH > self.bounds.size.height - 12.0) {
                by = fmax(12.0, self.bounds.size.height - bH - 12.0);
            }

            NSRect pillRect = NSMakeRect(bx, by, bW, bH);
            NSBezierPath *pill = [NSBezierPath bezierPathWithRoundedRect:pillRect xRadius:11.0 yRadius:11.0];
            [[NSColor colorWithSRGBRed:0.059 green:0.090 blue:0.165 alpha:0.90] setFill];
            [pill fill];

            pill.lineWidth = 1.5;
            [[st.accentColor colorWithAlphaComponent:0.88] setStroke];
            [pill stroke];

            // Glowing status dot inside pill
            NSRect dotRect = NSMakeRect(bx + padX, by + (bH - 7.0) / 2.0, 7.0, 7.0);
            NSBezierPath *dot = [NSBezierPath bezierPathWithOvalInRect:dotRect];
            [st.accentColor setFill];
            [dot fill];

            [displayLabel drawAtPoint:NSMakePoint(bx + padX + dotSpace, by + padY - 0.5) withAttributes:attrs];
        }
    }
}

@end

static int runCursorOverlayDaemon(NSString *socketPath, NSString *starPngPath, NSString *defaultAgentId) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

        NSScreen *mainScreen = [NSScreen mainScreen] ?: [NSScreen screens].firstObject;
        NSRect screenFrame = mainScreen ? mainScreen.frame : NSMakeRect(0, 0, 1920, 1080);

        NSWindow *overlayWin = [[NSWindow alloc] initWithContentRect:screenFrame
                                                           styleMask:NSWindowStyleMaskBorderless
                                                             backing:NSBackingStoreBuffered
                                                               defer:NO];
        [overlayWin setOpaque:NO];
        [overlayWin setBackgroundColor:[NSColor clearColor]];
        [overlayWin setHasShadow:NO];
        [overlayWin setIgnoresMouseEvents:YES];
        [overlayWin setLevel:NSScreenSaverWindowLevel];
        [overlayWin setCollectionBehavior:(NSWindowCollectionBehaviorCanJoinAllSpaces |
                                           NSWindowCollectionBehaviorFullScreenAuxiliary |
                                           NSWindowCollectionBehaviorStationary |
                                           NSWindowCollectionBehaviorIgnoresCycle)];

        GhostPawOverlayView *view = [[GhostPawOverlayView alloc] initWithFrame:NSMakeRect(0, 0, screenFrame.size.width, screenFrame.size.height)];
        view.cursorImage = [[NSImage alloc] initWithContentsOfFile:starPngPath];
        [overlayWin setContentView:view];

        const char *sockCStr = socketPath.UTF8String;
        unlink(sockCStr);
        int serverFd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (serverFd < 0) return 1;

        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(addr));
        addr.sun_family = AF_UNIX;
        strncpy(addr.sun_path, sockCStr, sizeof(addr.sun_path) - 1);
        if (bind(serverFd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
            close(serverFd);
            return 1;
        }
        if (listen(serverFd, 32) < 0) {
            close(serverFd);
            unlink(sockCStr);
            return 1;
        }

        __block NSTimeInterval lastGlobalUpdateTime = [NSDate timeIntervalSinceReferenceDate];

        // Background socket accept loop
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0), ^{
            while (1) {
                int clientFd = accept(serverFd, NULL, NULL);
                if (clientFd < 0) continue;
                struct timeval tv;
                tv.tv_sec = 0;
                tv.tv_usec = 250000;
                setsockopt(clientFd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

                char buf[32768];
                ssize_t n = recv(clientFd, buf, sizeof(buf) - 1, 0);
                uint8_t ack = 1;
                send(clientFd, &ack, 1, 0);
                close(clientFd);

                if (n <= 0) continue;
                buf[n] = '\0';
                NSData *jsonData = [NSData dataWithBytes:buf length:(NSUInteger)n];
                NSDictionary *msg = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
                if (![msg isKindOfClass:[NSDictionary class]]) continue;

                dispatch_async(dispatch_get_main_queue(), ^{
                    NSString *act = [safeStr(msg[@"action"]) lowercaseString];
                    NSString *msgAgentId = safeStr(msg[@"agent_id"]);
                    NSString *effectiveAgentKey = msgAgentId.length > 0 ? msgAgentId : (defaultAgentId.length > 0 ? defaultAgentId : @"default");

                    if ([act isEqualToString:@"hide"]) {
                        if (msgAgentId.length > 0) {
                            GPAgentOverlayState *st = view.agents[msgAgentId];
                            if (st) st.visibleState = NO;
                        } else {
                            for (GPAgentOverlayState *st in view.agents.allValues) {
                                st.visibleState = NO;
                            }
                        }
                        [view setNeedsDisplay:YES];
                        if (![view hasAnyVisibleAgent]) {
                            [overlayWin orderOut:nil];
                        }
                        return;
                    }
                    if ([act isEqualToString:@"disable"]) {
                        if (msgAgentId.length > 0) {
                            GPAgentOverlayState *st = view.agents[msgAgentId];
                            if (st) st.visibleState = NO;
                            [view setNeedsDisplay:YES];
                            if (![view hasAnyVisibleAgent]) {
                                [overlayWin orderOut:nil];
                                unlink(sockCStr);
                                exit(0);
                            }
                        } else {
                            [overlayWin orderOut:nil];
                            unlink(sockCStr);
                            exit(0);
                        }
                        return;
                    }
                    if ([act isEqualToString:@"present"]) {
                        GPAgentOverlayState *st = [view stateForAgent:effectiveAgentKey];
                        NSDictionary *inst = [msg[@"instruction"] isKindOfClass:[NSDictionary class]] ? msg[@"instruction"] : msg;
                        NSDictionary *dest = [inst[@"destination"] isKindOfClass:[NSDictionary class]] ? inst[@"destination"] : inst;
                        CGFloat nx = dest[@"x"] ? [dest[@"x"] doubleValue] : st.destX;
                        CGFloat ny = dest[@"y"] ? [dest[@"y"] doubleValue] : st.destY;
                        NSString *lbl = safeStr(inst[@"label"] ?: msg[@"text"]);
                        BOOL isClick = [inst[@"click"] boolValue];
                        NSDictionary *tDict = [inst[@"target"] isKindOfClass:[NSDictionary class]] ? inst[@"target"] : nil;

                        NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
                        st.lastUpdateTime = now;
                        lastGlobalUpdateTime = now;
                        if (lbl.length > 0) st.labelText = lbl;
                        if (tDict && tDict[@"width"] && tDict[@"height"]) {
                            st.targetRect = CGRectMake([tDict[@"x"] doubleValue],
                                                       [tDict[@"y"] doubleValue],
                                                       [tDict[@"width"] doubleValue],
                                                       [tDict[@"height"] doubleValue]);
                        } else {
                            st.targetRect = CGRectZero;
                        }

                        if (!st.visibleState || st.curX < 0) {
                            st.curX = nx;
                            st.curY = ny;
                            st.startX = nx;
                            st.startY = ny;
                            st.destX = nx;
                            st.destY = ny;
                            st.moveStartTime = now;
                        } else if (hypot(nx - st.destX, ny - st.destY) > 1.0) {
                            st.startX = st.curX;
                            st.startY = st.curY;
                            st.destX = nx;
                            st.destY = ny;
                            st.moveStartTime = now;
                        }
                        if (isClick) {
                            st.clickStartTime = now;
                        }
                        st.visibleState = YES;
                        [overlayWin orderFrontRegardless];
                        [st resolveAndCaptureBackgroundWindowAtX:nx y:ny];
                        [view setNeedsDisplay:YES];
                        [view displayIfNeeded];
                    }
                });
            }
        });

        // 60fps animation & idle watchdog timer across all concurrent agents
        [NSTimer scheduledTimerWithTimeInterval:0.016 repeats:YES block:^(NSTimer * _Nonnull timer) {
            NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
            BOOL needsRedraw = NO;

            for (GPAgentOverlayState *st in view.agents.allValues) {
                if (!st.visibleState) continue;
                NSTimeInterval idle = now - st.lastUpdateTime;
                if (idle > 10.5) {
                    st.visibleState = NO;
                    needsRedraw = YES;
                    continue;
                }
                if (st.targetWindowId > 0 && (now - st.lastWindowCaptureTime) >= 0.085) {
                    [st refreshTargetWindowImage];
                    needsRedraw = YES;
                }
                NSTimeInterval moveElapsed = now - st.moveStartTime;
                if (moveElapsed <= st.moveDuration + 0.02) {
                    CGFloat t = (CGFloat)fmin(1.0, fmax(0.0, moveElapsed / st.moveDuration));
                    CGFloat ease = 1.0 - pow(1.0 - t, 3.0);
                    st.curX = st.startX + (st.destX - st.startX) * ease;
                    st.curY = st.startY + (st.destY - st.startY) * ease;
                    needsRedraw = YES;
                } else {
                    st.curX = st.destX;
                    st.curY = st.destY;
                }
                if (now - st.clickStartTime <= 0.48) {
                    needsRedraw = YES;
                }
            }

            if (![view hasAnyVisibleAgent]) {
                if (needsRedraw) {
                    [view setNeedsDisplay:YES];
                    [overlayWin orderOut:nil];
                }
                if (now - lastGlobalUpdateTime > 14.0) {
                    unlink(sockCStr);
                    exit(0);
                }
                return;
            }

            if (needsRedraw) {
                [view setNeedsDisplay:YES];
            }
        }];

        [NSApp run];
    }
    return 0;
}

// ============================================================================
// 6. Mode 3: Full `agent-desktop` Compatible CLI Engine
// ============================================================================

static NSDictionary *buildSnapshotForWindow(GPResolvedWindow *win, NSString *sessionId, NSString *stateDir, int maxDepth, BOOL interactiveOnly) {
    NSString *chars = @"abcdefghjkmnpqrstuvwxyz23456789";
    NSMutableString *snapId = [NSMutableString stringWithString:@"s"];
    uint32_t seed = (uint32_t)([[NSDate date] timeIntervalSince1970] * 1000) ^ (uint32_t)getpid() ^ (uint32_t)win.cgWindowId;
    for (int i = 0; i < 7; i++) {
        seed = seed * 1664525u + 1013904223u;
        [snapId appendFormat:@"%C", [chars characterAtIndex:(seed % chars.length)]];
    }

    NSString *winIdStr = [NSString stringWithFormat:@"w-%u", win.cgWindowId];
    NSMutableDictionary *refMapEntries = [NSMutableDictionary dictionary];
    __block int refCounter = 0;

    NSDictionary * (^ __weak __block weakBuildNode)(AXUIElementRef, int);
    NSDictionary * (^buildNode)(AXUIElementRef, int) = ^NSDictionary *(AXUIElementRef el, int depth) {
        if (!el || depth > maxDepth) return nil;
        NSString *axRole = axStr(el, kAXRoleAttribute);
        if ([axRole isEqualToString:@"AXMenuBar"]) return nil;
        NSString *axSubrole = axStr(el, kAXSubroleAttribute);
        NSString *normRole = normalizeRoleName(axRole, axSubrole);
        NSString *title = axStr(el, kAXTitleAttribute);
        NSString *desc = axStr(el, kAXDescriptionAttribute);
        NSString *val = axStr(el, kAXValueAttribute);
        NSString *ident = axStr(el, CFSTR("AXIdentifier"));
        CGRect f = axFrame(el);

        NSString *displayName = title.length > 0 ? title : (desc.length > 0 ? desc : ident);
        BOOL interactive = isInteractiveRole(normRole, el);

        NSMutableArray *childNodes = [NSMutableArray array];
        CFTypeRef children = NULL;
        if (depth < maxDepth && AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
            if (CFGetTypeID(children) == CFArrayGetTypeID()) {
                CFIndex cnt = CFArrayGetCount((CFArrayRef)children);
                for (CFIndex i = 0; i < cnt; i++) {
                    AXUIElementRef ch = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children, i);
                    NSDictionary *cNode = weakBuildNode(ch, depth + 1);
                    if (cNode) [childNodes addObject:cNode];
                }
            }
            CFRelease(children);
        }

        // Compact single-child unnamed group containers
        if (!interactive && displayName.length == 0 && val.length == 0 && childNodes.count == 1 && depth > 0) {
            return childNodes.firstObject;
        }
        if (interactiveOnly && !interactive && childNodes.count == 0 && depth > 0) {
            return nil;
        }

        NSMutableDictionary *node = [NSMutableDictionary dictionary];
        node[@"role"] = normRole;
        if (displayName.length > 0) node[@"name"] = displayName;
        if (val.length > 0) node[@"value"] = val;
        if (ident.length > 0) node[@"automation_id"] = ident;
        NSDictionary *boundsDict = @{
            @"x": @((int)round(f.origin.x)),
            @"y": @((int)round(f.origin.y)),
            @"width": @((int)round(f.size.width)),
            @"height": @((int)round(f.size.height))
        };
        node[@"bounds"] = boundsDict;
        node[@"window_id"] = winIdStr;
        node[@"app"] = win.appName ?: @"";

        if (interactive || displayName.length > 0 || val.length > 0 || depth == 0) {
            refCounter++;
            NSString *bareRef = [NSString stringWithFormat:@"e%d", refCounter];
            NSString *fullRef = [NSString stringWithFormat:@"@%@:%@", snapId, bareRef];
            node[@"ref_id"] = bareRef;
            node[@"ref"] = fullRef;

            NSMutableDictionary *entry = [NSMutableDictionary dictionary];
            entry[@"ref_id"] = bareRef;
            entry[@"role"] = normRole;
            entry[@"name"] = displayName.length > 0 ? displayName : (val.length > 0 ? val : bareRef);
            if (val.length > 0) entry[@"value"] = val;
            entry[@"source_app"] = win.appName ?: @"";
            entry[@"source_window_id"] = winIdStr;
            entry[@"bounds"] = boundsDict;
            if (ident.length > 0) {
                entry[@"native_id"] = @{ @"kind": @"ax_identifier", @"value": ident };
            }
            refMapEntries[bareRef] = entry;
        }

        if (childNodes.count > 0) {
            node[@"children"] = childNodes;
        }
        return node;
    };
    weakBuildNode = buildNode;

    AXUIElementRef rootEl = win.axWindow ?: win.axApp;
    NSDictionary *tree = rootEl ? buildNode(rootEl, 0) : @{ @"role": @"window", @"name": win.title ?: @"" };

    // Persist refmap.json so GhostPaw's loadSnapshotRefMapFromDisk & findBestRefAtPoint work seamlessly
    if (stateDir.length > 0 && sessionId.length > 0) {
        NSString *snapDir = [NSString stringWithFormat:@"%@/sessions/%@/snapshots/%@", stateDir, sessionId, snapId];
        [[NSFileManager defaultManager] createDirectoryAtPath:snapDir withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *refmapPath = [snapDir stringByAppendingPathComponent:@"refmap.json"];
        NSDictionary *refmapPayload = @{
            @"snapshot_id": snapId,
            @"app": win.appName ?: @"",
            @"window_id": winIdStr,
            @"entries": refMapEntries
        };
        NSData *rmData = [NSJSONSerialization dataWithJSONObject:refmapPayload options:NSJSONWritingPrettyPrinted error:nil];
        if (rmData) [rmData writeToFile:refmapPath atomically:YES];
    }

    return @{
        @"snapshot_id": snapId,
        @"window_id": winIdStr,
        @"app": win.appName ?: @"",
        @"title": win.title ?: @"",
        @"bounds": @{
            @"x": @((int)round(win.bounds.origin.x)),
            @"y": @((int)round(win.bounds.origin.y)),
            @"width": @((int)round(win.bounds.size.width)),
            @"height": @((int)round(win.bounds.size.height))
        },
        @"tree": tree ?: @{}
    };
}

static NSDictionary *lookupSavedRefEntry(NSString *stateDir, NSString *sessionId, NSString *rawRef) {
    NSString *trimmed = [rawRef ?: @"" stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (trimmed.length == 0) return nil;
    NSString *snapId = nil;
    NSString *bareRef = trimmed;
    if ([trimmed hasPrefix:@"@"]) trimmed = [trimmed substringFromIndex:1];
    NSRange colon = [trimmed rangeOfString:@":"];
    if (colon.location != NSNotFound) {
        snapId = [trimmed substringToIndex:colon.location];
        bareRef = [trimmed substringFromIndex:colon.location + 1];
    }
    if (snapId.length > 0 && stateDir.length > 0 && sessionId.length > 0) {
        NSString *rmPath = [NSString stringWithFormat:@"%@/sessions/%@/snapshots/%@/refmap.json", stateDir, sessionId, snapId];
        NSData *d = [NSData dataWithContentsOfFile:rmPath];
        if (d) {
            NSDictionary *rm = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
            NSDictionary *entries = rm[@"entries"] ?: rm[@"inner"];
            if ([entries isKindOfClass:[NSDictionary class]] && entries[bareRef]) {
                return entries[bareRef];
            }
        }
    }
    return nil;
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *args = [NSMutableArray array];
        for (int i = 1; i < argc; i++) {
            [args addObject:[NSString stringWithUTF8String:argv[i]]];
        }

        if (args.count >= 1 && [args[0] isEqualToString:@"--cursor-daemon"]) {
            NSString *sockPath = args.count >= 2 ? args[1] : @"/tmp/ghostpaw-cursor.sock";
            NSString *pngPath = args.count >= 3 ? args[2] : @"";
            NSString *agentId = args.count >= 4 ? args[3] : @"default";
            return runCursorOverlayDaemon(sockPath, pngPath, agentId);
        }

        if (args.count >= 2 && [args[0] isEqualToString:@"--bg-action"]) {
            NSData *decoded = [[NSData alloc] initWithBase64EncodedString:args[1] options:0];
            if (!decoded) {
                printJsonAndExit(@{ @"ok": @NO, @"method": @"base64-decode-failed", @"error": @"Invalid base64 payload" }, 1);
            }
            NSDictionary *req = [NSJSONSerialization JSONObjectWithData:decoded options:0 error:nil];
            if (![req isKindOfClass:[NSDictionary class]]) {
                printJsonAndExit(@{ @"ok": @NO, @"method": @"json-parse-failed", @"error": @"Invalid JSON payload" }, 1);
            }
            NSDictionary *res = executeBgActionDict(req);
            printJsonAndExit(res, 0);
        }

        // Mode 3: Full `agent-desktop` CLI parser
        NSString *stateDir = [[[NSProcessInfo processInfo] environment][@"AGENT_DESKTOP_HOME"] copy] ?:
                             [NSHomeDirectory() stringByAppendingPathComponent:@".ghostpaw/runtime"];
        NSString *sessionId = [[[NSProcessInfo processInfo] environment][@"AGENT_DESKTOP_SESSION"] copy] ?: @"default";
        NSString *agentId = [[[NSProcessInfo processInfo] environment][@"AGENT_DESKTOP_AGENT_ID"] copy] ?: @"default";
        BOOL headed = NO;

        NSUInteger idx = 0;
        while (idx < args.count && [args[idx] hasPrefix:@"--"]) {
            NSString *flag = args[idx];
            if ([flag isEqualToString:@"--session"] && idx + 1 < args.count) {
                sessionId = args[idx + 1];
                idx += 2;
            } else if ([flag isEqualToString:@"--agent-id"] && idx + 1 < args.count) {
                agentId = args[idx + 1];
                idx += 2;
            } else if ([flag isEqualToString:@"--headed"]) {
                headed = YES;
                idx += 1;
            } else if (([flag isEqualToString:@"--wait-for"] || [flag isEqualToString:@"--wait-for-gone"] || [flag isEqualToString:@"--wait-timeout"]) && idx + 1 < args.count) {
                idx += 2;
            } else {
                break;
            }
        }

        if (idx >= args.count) {
            printCliEnvelopeAndExit(@"status", YES, @{ @"platform": @"macos", @"trusted": @(AXIsProcessTrusted()) }, nil, nil, nil);
        }

        NSString *cmd = args[idx];
        NSArray<NSString *> *subArgs = [args subarrayWithRange:NSMakeRange(idx + 1, args.count - (idx + 1))];

        if ([cmd isEqualToString:@"session"]) {
            NSString *sub = subArgs.count > 0 ? subArgs[0] : @"list";
            NSString *sessionsDir = [stateDir stringByAppendingPathComponent:@"sessions"];
            [[NSFileManager defaultManager] createDirectoryAtPath:sessionsDir withIntermediateDirectories:YES attributes:nil error:nil];
            if ([sub isEqualToString:@"start"]) {
                NSString *newSid = [NSString stringWithFormat:@"s-mac-%ld", (long)[[NSDate date] timeIntervalSince1970]];
                NSString *sDir = [sessionsDir stringByAppendingPathComponent:newSid];
                [[NSFileManager defaultManager] createDirectoryAtPath:sDir withIntermediateDirectories:YES attributes:nil error:nil];
                NSDictionary *manifest = @{ @"session_id": newSid, @"created_at": @((long)[[NSDate date] timeIntervalSince1970]) };
                NSData *mData = [NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingPrettyPrinted error:nil];
                [mData writeToFile:[sDir stringByAppendingPathComponent:@"session.json"] atomically:YES];
                printCliEnvelopeAndExit(@"session", YES, @{ @"session_id": newSid }, nil, nil, nil);
            } else {
                NSMutableArray *list = [NSMutableArray array];
                NSArray *dirs = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:sessionsDir error:nil];
                for (NSString *d in dirs) {
                    [list addObject:@{ @"session_id": d }];
                }
                printCliEnvelopeAndExit(@"session", YES, @{ @"sessions": list }, nil, nil, nil);
            }
        }

        if ([cmd isEqualToString:@"status"]) {
            printCliEnvelopeAndExit(@"status", YES, @{
                @"platform": @"macos",
                @"session_id": sessionId,
                @"agent_id": agentId,
                @"trusted": @(AXIsProcessTrusted())
            }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"permissions"]) {
            BOOL prompt = [subArgs containsObject:@"--request"];
            NSDictionary *opts = @{ (__bridge id)kAXTrustedCheckOptionPrompt: @(prompt) };
            Boolean trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
            printCliEnvelopeAndExit(@"permissions", YES, @{
                @"accessibility": trusted ? @"granted" : @"denied",
                @"screen_recording": @"granted",
                @"trusted": @(trusted ? YES : NO)
            }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"list-displays"]) {
            NSMutableArray *displays = [NSMutableArray array];
            NSArray<NSScreen *> *screens = [NSScreen screens];
            for (NSUInteger i = 0; i < screens.count; i++) {
                NSScreen *s = screens[i];
                NSRect f = s.frame;
                [displays addObject:@{
                    @"id": [NSString stringWithFormat:@"display-%lu", (unsigned long)(i + 1)],
                    @"name": [s localizedName] ?: [NSString stringWithFormat:@"Display %lu", (unsigned long)(i + 1)],
                    @"bounds": @{
                        @"x": @((int)round(f.origin.x)),
                        @"y": @((int)round(f.origin.y)),
                        @"width": @((int)round(f.size.width)),
                        @"height": @((int)round(f.size.height))
                    },
                    @"scale_factor": @(s.backingScaleFactor),
                    @"is_primary": @(i == 0)
                }];
            }
            printCliEnvelopeAndExit(@"list-displays", YES, @{ @"displays": displays, @"count": @(displays.count) }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"list-apps"]) {
            NSString *appFilter = nil;
            for (NSUInteger i = 0; i + 1 < subArgs.count; i++) {
                if ([subArgs[i] isEqualToString:@"--app"]) appFilter = subArgs[i + 1];
            }
            NSMutableArray *apps = [NSMutableArray array];
            for (NSRunningApplication *ra in [[NSWorkspace sharedWorkspace] runningApplications]) {
                if (ra.terminated || ra.activationPolicy != NSApplicationActivationPolicyRegular) continue;
                NSString *name = ra.localizedName ?: @"";
                NSString *bid = ra.bundleIdentifier ?: @"";
                if (appFilter && !matchesAppCandidate(appFilter, name, bid, @"")) continue;
                [apps addObject:@{
                    @"name": name,
                    @"app": name,
                    @"bundle_id": bid,
                    @"pid": @(ra.processIdentifier),
                    @"active": @(ra.isActive),
                    @"hidden": @(ra.isHidden)
                }];
            }
            printCliEnvelopeAndExit(@"list-apps", YES, @{ @"apps": apps, @"count": @(apps.count) }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"list-windows"]) {
            NSString *appFilter = nil;
            for (NSUInteger i = 0; i + 1 < subArgs.count; i++) {
                if ([subArgs[i] isEqualToString:@"--app"]) appFilter = subArgs[i + 1];
            }
            NSArray<GPResolvedWindow *> *wins = enumerateAllDesktopWindows(appFilter);
            NSMutableArray *outWins = [NSMutableArray array];
            for (GPResolvedWindow *w in wins) {
                [outWins addObject:@{
                    @"id": [NSString stringWithFormat:@"w-%u", w.cgWindowId],
                    @"app": w.appName ?: @"",
                    @"app_name": w.appName ?: @"",
                    @"bundle_id": w.bundleId ?: @"",
                    @"pid": @(w.pid),
                    @"title": w.title ?: @"",
                    @"bounds": @{
                        @"x": @((int)round(w.bounds.origin.x)),
                        @"y": @((int)round(w.bounds.origin.y)),
                        @"width": @((int)round(w.bounds.size.width)),
                        @"height": @((int)round(w.bounds.size.height))
                    },
                    @"focused": @(w.focused),
                    @"minimized": @(w.minimized)
                }];
            }
            printCliEnvelopeAndExit(@"list-windows", YES, @{ @"windows": outWins, @"count": @(outWins.count) }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"list-surfaces"]) {
            printCliEnvelopeAndExit(@"list-surfaces", YES, @{
                @"surfaces": @[@{ @"type": @"window" }, @{ @"type": @"menubar" }, @{ @"type": @"dock" }]
            }, nil, nil, nil);
        }

        // Parse common target options (--window-id, --app, etc.)
        NSString *winIdArg = nil;
        NSString *appArg = nil;
        NSString *roleArg = nil;
        NSString *nameArg = nil;
        NSString *textArg = nil;
        NSString *valArg = nil;
        NSString *propArg = nil;
        int maxDepth = 10;
        BOOL interactiveOnly = [subArgs containsObject:@"-i"];
        NSMutableArray<NSString *> *positional = [NSMutableArray array];

        for (NSUInteger i = 0; i < subArgs.count; i++) {
            NSString *a = subArgs[i];
            if ([a isEqualToString:@"--window-id"] && i + 1 < subArgs.count) { winIdArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--app"] && i + 1 < subArgs.count) { appArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--role"] && i + 1 < subArgs.count) { roleArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--name"] && i + 1 < subArgs.count) { nameArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--text"] && i + 1 < subArgs.count) { textArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--value"] && i + 1 < subArgs.count) { valArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--property"] && i + 1 < subArgs.count) { propArg = subArgs[++i]; }
            else if ([a isEqualToString:@"--max-depth"] && i + 1 < subArgs.count) { maxDepth = [subArgs[++i] intValue]; }
            else if (([a isEqualToString:@"--surface"] || [a isEqualToString:@"--root"] || [a isEqualToString:@"--timeout-ms"] || [a isEqualToString:@"--timeout"] || [a isEqualToString:@"--direction"] || [a isEqualToString:@"--amount"] || [a isEqualToString:@"--width"] || [a isEqualToString:@"--height"] || [a isEqualToString:@"--element"] || [a isEqualToString:@"--predicate"] || [a isEqualToString:@"--event"]) && i + 1 < subArgs.count) {
                i++;
            } else if ([a hasPrefix:@"--"]) {
                continue;
            } else if ([a isEqualToString:@"-i"]) {
                continue;
            } else {
                [positional addObject:a];
            }
        }

        long explicitWinId = 0;
        if (winIdArg && ([winIdArg hasPrefix:@"w-"] || [winIdArg hasPrefix:@"w_"])) {
            explicitWinId = (long)[[winIdArg substringFromIndex:2] longLongValue];
        }

        if ([cmd isEqualToString:@"snapshot"]) {
            GPResolvedWindow *win = findTargetWindow(explicitWinId, appArg, NO, 0, 0);
            if (!win && appArg.length > 0) {
                win = launchOrAttachAppInBackground(appArg);
            }
            if (!win) {
                printCliEnvelopeAndExit(@"snapshot", NO, nil, @"WINDOW_NOT_FOUND", @"No matching window found for snapshot", @"Run list_windows or launch the app first");
            }
            NSDictionary *snapData = buildSnapshotForWindow(win, sessionId, stateDir, maxDepth, interactiveOnly);
            printCliEnvelopeAndExit(@"snapshot", YES, snapData, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"find"]) {
            GPResolvedWindow *win = findTargetWindow(explicitWinId, appArg, NO, 0, 0);
            if (!win) {
                printCliEnvelopeAndExit(@"find", NO, nil, @"WINDOW_NOT_FOUND", @"No matching window found for find", nil);
            }
            NSDictionary *snapData = buildSnapshotForWindow(win, sessionId, stateDir, 12, NO);
            NSMutableArray *matches = [NSMutableArray array];
            void (^ __weak __block weakCollect)(NSDictionary *);
            void (^collect)(NSDictionary *) = ^(NSDictionary *node) {
                if (![node isKindOfClass:[NSDictionary class]]) return;
                NSString *nr = [safeStr(node[@"role"]) lowercaseString];
                NSString *nn = safeStr(node[@"name"]);
                NSString *nv = safeStr(node[@"value"]);
                BOOL ok = (node[@"ref"] != nil);
                if (ok && roleArg.length > 0 && ![nr containsString:[roleArg lowercaseString]]) ok = NO;
                if (ok && nameArg.length > 0 && ![nn localizedCaseInsensitiveContainsString:nameArg]) ok = NO;
                if (ok && textArg.length > 0 && ![nn localizedCaseInsensitiveContainsString:textArg] && ![nv localizedCaseInsensitiveContainsString:textArg]) ok = NO;
                if (ok && valArg.length > 0 && ![nv localizedCaseInsensitiveContainsString:valArg]) ok = NO;
                if (ok) [matches addObject:node];
                for (NSDictionary *ch in (NSArray *)node[@"children"]) {
                    weakCollect(ch);
                }
            };
            weakCollect = collect;
            collect(snapData[@"tree"]);
            printCliEnvelopeAndExit(@"find", YES, @{
                @"snapshot_id": snapData[@"snapshot_id"],
                @"window_id": snapData[@"window_id"],
                @"app": snapData[@"app"],
                @"matches": matches,
                @"count": @(matches.count)
            }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"get"] || [cmd isEqualToString:@"is"]) {
            NSString *ref = positional.firstObject ?: @"";
            NSDictionary *entry = lookupSavedRefEntry(stateDir, sessionId, ref);
            NSString *prop = propArg ?: ([cmd isEqualToString:@"is"] ? @"visible" : @"text");
            if (entry) {
                id val = entry[prop] ?: entry[@"value"] ?: entry[@"name"] ?: @YES;
                printCliEnvelopeAndExit(cmd, YES, @{
                    @"ref": ref,
                    @"property": prop,
                    @"value": val,
                    @"bounds": entry[@"bounds"] ?: @{}
                }, nil, nil, nil);
            }
            printCliEnvelopeAndExit(cmd, YES, @{ @"ref": ref, @"property": prop, @"value": @"" }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"screenshot"]) {
            NSString *outPath = positional.lastObject ?: @"/tmp/ghostpaw-shot.png";
            GPResolvedWindow *win = (explicitWinId > 0 || appArg.length > 0)
                ? findTargetWindow(explicitWinId, appArg, NO, 0, 0)
                : nil;
            NSTask *scTask = [[NSTask alloc] init];
            scTask.launchPath = @"/usr/sbin/screencapture";
            if (win && win.cgWindowId > 0) {
                scTask.arguments = @[@"-l", [NSString stringWithFormat:@"%u", win.cgWindowId], @"-x", @"-o", outPath];
            } else {
                scTask.arguments = @[@"-x", outPath];
            }
            [scTask launch];
            [scTask waitUntilExit];
            BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:outPath];
            printCliEnvelopeAndExit(@"screenshot", exists, @{
                @"path": outPath,
                @"window_id": win ? [NSString stringWithFormat:@"w-%u", win.cgWindowId] : @"screen",
                @"app": win ? (win.appName ?: @"") : @"Screen"
            }, exists ? nil : @"SCREENSHOT_FAILED", exists ? nil : @"screencapture failed", nil);
        }

        if ([cmd isEqualToString:@"clipboard-get"]) {
            NSString *txt = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString] ?: @"";
            printCliEnvelopeAndExit(@"clipboard-get", YES, @{ @"text": txt }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"clipboard-set"]) {
            NSData *stdinData = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            NSString *txt = [[NSString alloc] initWithData:stdinData encoding:NSUTF8StringEncoding] ?: @"";
            [[NSPasteboard generalPasteboard] clearContents];
            [[NSPasteboard generalPasteboard] setString:txt forType:NSPasteboardTypeString];
            printCliEnvelopeAndExit(@"clipboard-set", YES, @{ @"ok": @YES, @"length": @(txt.length) }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"clipboard-clear"]) {
            [[NSPasteboard generalPasteboard] clearContents];
            printCliEnvelopeAndExit(@"clipboard-clear", YES, @{ @"ok": @YES }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"launch"]) {
            NSString *targetApp = positional.firstObject ?: appArg ?: @"";
            GPResolvedWindow *win = launchOrAttachAppInBackground(targetApp);
            if (headed && win && win.pid > 0) {
                NSRunningApplication *ra = [NSRunningApplication runningApplicationWithProcessIdentifier:win.pid];
                [ra activateWithOptions:NSApplicationActivateIgnoringOtherApps];
            }
            printCliEnvelopeAndExit(@"launch", win != nil, @{
                @"app": win.appName ?: targetApp,
                @"window_id": win ? [NSString stringWithFormat:@"w-%u", win.cgWindowId] : @"",
                @"title": win.title ?: @""
            }, win ? nil : @"LAUNCH_FAILED", win ? nil : @"Could not launch target app", nil);
        }

        if ([cmd isEqualToString:@"close-app"]) {
            NSString *targetApp = positional.firstObject ?: appArg ?: @"";
            GPResolvedWindow *win = findTargetWindow(explicitWinId, targetApp, NO, 0, 0);
            if (win && win.pid > 0) {
                NSRunningApplication *ra = [NSRunningApplication runningApplicationWithProcessIdentifier:win.pid];
                if ([subArgs containsObject:@"--force"]) [ra forceTerminate];
                else [ra terminate];
            }
            printCliEnvelopeAndExit(@"close-app", YES, @{ @"app": targetApp }, nil, nil, nil);
        }

        if ([cmd isEqualToString:@"wait"]) {
            int ms = positional.count > 0 ? [positional.firstObject intValue] : 500;
            [NSThread sleepForTimeInterval:fmin(10.0, fmax(0.05, ms / 1000.0))];
            printCliEnvelopeAndExit(@"wait", YES, @{ @"waited_ms": @(ms) }, nil, nil, nil);
        }

        // Remaining action commands (click, set-value, type, clear, press, scroll, etc.)
        NSString *ref = positional.firstObject ?: @"";
        NSDictionary *entry = lookupSavedRefEntry(stateDir, sessionId, ref);
        NSDictionary *b = [entry[@"bounds"] isKindOfClass:[NSDictionary class]] ? entry[@"bounds"] : nil;
        NSMutableDictionary *bgReq = [NSMutableDictionary dictionary];
        bgReq[@"action"] = [cmd stringByReplacingOccurrencesOfString:@"-" withString:@"_"];
        if (appArg) bgReq[@"app"] = appArg;
        else if (entry[@"source_app"]) bgReq[@"app"] = entry[@"source_app"];
        if (explicitWinId > 0) bgReq[@"windowHandle"] = @(explicitWinId);
        else if (entry[@"source_window_id"]) {
            NSString *sw = safeStr(entry[@"source_window_id"]);
            if ([sw hasPrefix:@"w-"]) bgReq[@"windowHandle"] = @((long)[[sw substringFromIndex:2] longLongValue]);
        }
        if (entry[@"name"]) bgReq[@"elementName"] = entry[@"name"];
        if (entry[@"role"]) bgReq[@"elementRole"] = entry[@"role"];
        if (entry[@"native_id"][@"value"]) bgReq[@"automationId"] = entry[@"native_id"][@"value"];
        if (b && b[@"x"] && b[@"y"] && b[@"width"] && b[@"height"]) {
            bgReq[@"x"] = @([b[@"x"] doubleValue] + [b[@"width"] doubleValue] / 2.0);
            bgReq[@"y"] = @([b[@"y"] doubleValue] + [b[@"height"] doubleValue] / 2.0);
            bgReq[@"hasExplicitCoord"] = @YES;
        }
        if ([subArgs containsObject:@"--stdin"]) {
            NSData *stdinData = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
            bgReq[@"text"] = [[NSString alloc] initWithData:stdinData encoding:NSUTF8StringEncoding] ?: @"";
        }
        if ([cmd isEqualToString:@"press"]) {
            bgReq[@"action"] = @"key";
            bgReq[@"key"] = positional.lastObject ?: @"return";
        }

        NSDictionary *bgRes = executeBgActionDict(bgReq);
        BOOL ok = [bgRes[@"ok"] boolValue];
        printCliEnvelopeAndExit(cmd, ok, bgRes, ok ? nil : @"ACTION_FAILED", ok ? nil : safeStr(bgRes[@"error"] ?: @"Action failed"), nil);
    }
    return 0;
}
