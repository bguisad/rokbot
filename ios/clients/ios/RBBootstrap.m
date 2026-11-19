#import "RBComputers.h"
#import "RBConnection.h"
#import "RBAppIntents.h"
#import "RBLibrary.h"
#import "RBNotifications.h"
#import "RBProfile.h"
#import "RBPush.h"
#import "RBConnectors.h"
#import "RBDeepLinks.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"
#import "RBUsage.h"
#import "RBNetwork.h"
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static IMP RBOriginalLoad;
static __weak id RBHost;
static BOOL RBLoadedPairedBundle;
static UIWindow *RBWindow(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow)
          return window;
  return nil;
}
static id RBIvar(id object, const char *name) {
  if (!object)
    return nil;
  Ivar ivar = class_getInstanceVariable(object_getClass(object), name);
  return ivar ? object_getIvar(object, ivar) : nil;
}
static id RBFindHost(void) {
  id delegate = UIApplication.sharedApplication.delegate;
  return RBIvar(RBIvar(RBIvar(delegate, "reactNativeFactory"), "_rootViewFactory"), "_reactHost");
}
static void RBLoad(id self, SEL cmd, NSURL *url, id progress, id completion) {
  RBHost = self;
  NSURL *patched = RBConnection.shared.gatewayBundleURL;
  RBLoadedPairedBundle = patched != nil;
  RBDiagnosticsRecordBundle(url, patched ?: url);
  ((void (*)(id, SEL, NSURL *, id, id))RBOriginalLoad)(self, cmd, patched ?: url, progress,
                                                       completion);
}
void RBReloadReactHost(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    RBDiagnosticsEvent(@"react.reload", @{});
    id host = RBHost ?: RBFindHost();
    SEL reload = sel_registerName("didReceiveReloadCommand");
    if ([host respondsToSelector:reload])
      ((void (*)(id, SEL))objc_msgSend)(host, reload);
  });
}
@interface RBInterface : NSObject
+ (void)showConnection;
+ (void)refresh;
@end
@implementation RBInterface
+ (void)showLibrary {
  RBShowLibrary();
}
+ (void)showComputers {
  RBShowComputers();
}
+ (void)showConnection {
  [RBConnection.shared show];
}
+ (void)replaceEntry:(UIView *)view {
  if ((view.tag >= 731989 && view.tag <= 731999))
    return;
  NSString *label = view.accessibilityLabel;
  if ([view isKindOfClass:UILabel.class])
    label = ((UILabel *)view).text;
  if ([view isKindOfClass:UIButton.class])
    label = [((UIButton *)view) titleForState:UIControlStateNormal];
  RBObserveAppLanguage(label);
  NSSet *labels = [NSSet setWithArray:@[
    @"Log in", @"Login", @"Sign in", @"登录", @"登入", @"登陆", @"登录或注册", @"Log in or sign up"
  ]];
  for (UIView *child in [view.subviews copy]) {
    if (child.tag == 731989 && ![@[@"用量", @"Usage"] containsObject:label])
      [child removeFromSuperview];
    if (child.tag == 731991 && ![labels containsObject:label] && ![@[@"调试", @"Debug", @"link"] containsObject:label])
      [child removeFromSuperview];
    if (child.tag == 731992 && ![@[@"资料库", @"Library"] containsObject:label])
      [child removeFromSuperview];
    if (child.tag == 731993 && ![label isEqual:@"dev-gateway@localhost"] &&
        ![label isEqual:@"dev-gateway@localhost avatar"]) {
      RBResetProfileView(view);
      [child removeFromSuperview];
    }
    if (child.tag == 731999 && ![@[@"Bot 电脑", @"Bot Computer"] containsObject:label])
      [child removeFromSuperview];
  }
  if (RBReplaceProfileView(view))
    return;
  if (RBReplacePushView(view))
    return;
  if ([@[@"Bot 电脑", @"Bot Computer"] containsObject:label] && view.bounds.size.width > 300 &&
      view.bounds.size.height >= 44) {
    if (![view viewWithTag:731999]) {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731999;
      button.frame = view.bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityLabel = RBL(@"Bot 电脑", @"Bot Computer");
      [button addTarget:self
                    action:@selector(showComputers)
          forControlEvents:UIControlEventTouchUpInside];
      view.userInteractionEnabled = YES;
      [view addSubview:button];
    }
    return;
  }
  if (([@[@"调试", @"Debug", @"link", @"连接 Host", @"Host Connection"] containsObject:label]) && RBConnection.shared.deviceToken.length && view.bounds.size.width <= 88) {
    // Keep the original toolbar and link icon; only route the original touch.
    view.accessibilityLabel = RBL(@"连接 Host", @"Host Connection");
    view.accessibilityIdentifier = @"rokbot.host.settings";
    return;
  }
  if ([@[@"资料库", @"Library"] containsObject:label] && RBConnection.shared.deviceToken.length &&
      view.bounds.size.width > 20) {
    if (![view viewWithTag:731992]) {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
      button.tag = 731992;
      button.frame = view.bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.backgroundColor = view.backgroundColor ?: UIColor.clearColor;
      [button setTitle:RBL(@"资料库", @"Library") forState:UIControlStateNormal];
      button.titleLabel.font = [UIFont systemFontOfSize:14];
      [button setTitleColor:UIColor.secondaryLabelColor forState:UIControlStateNormal];
      [button addTarget:self
                    action:@selector(showLibrary)
          forControlEvents:UIControlEventTouchUpInside];
      view.userInteractionEnabled = YES;
      [view addSubview:button];
    }
    return;
  }
  RBReplaceUsageView(view);
}
+ (void)replaceLogin:(UIView *)view {
  [self replaceEntry:view];
  if (view.tag >= 731989 && view.tag <= 731999) return;
  for (UIView *child in view.subviews) [self replaceLogin:child];
}
+ (void)refresh {
  UIWindow *window = RBWindow();
  if (!window)
    return;
  [self replaceLogin:window];
}

@end
static IMP RBOriginalTask;
static IMP RBOriginalSimpleTask;
static IMP RBOriginalTouches;
static IMP RBOriginalRecycle;
static IMP RBOriginalLayout;
static void RBLayout(id self, SEL selector) {
  ((void (*)(id, SEL))RBOriginalLayout)(self, selector);
  // Fabric has populated labels and bounds at this point, before the first
  // frame is displayed. Update the affected view here, without polling the
  // entire window while the interface is idle.
  [RBInterface replaceEntry:self];
}
static void RBRecycle(id self, SEL selector) {
  RBResetProfileView(self);
  RBResetPushView(self);
  for (UIView *child in [[self subviews] copy])
    if (child.tag >= 731989 && child.tag <= 731999)
      [child removeFromSuperview];
  ((void (*)(id, SEL))RBOriginalRecycle)(self, selector);
}
static void RBTouches(id self, SEL selector, NSSet<UITouch *> *touches, UIEvent *event) {
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if ([@[@"连接服务端", @"Connect to Host"] containsObject:v.accessibilityLabel] || [v.accessibilityIdentifier isEqual:@"rokbot.host.settings"] || ([v.accessibilityLabel isEqual:@"link"] && RBConnection.shared.deviceToken.length)) {
        [RBConnection.shared show];
        return;
      }
  // Fabric handles ancestor touches even when a native button receives them.
  // Exclude only plugin controls to prevent both local and cloud actions firing.
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if (v.tag >= 731989 && v.tag <= 731999)
        return;
  ((void (*)(id, SEL, id, id))RBOriginalTouches)(self, selector, touches, event);
}
static id RBSimpleTask(id self, SEL selector, NSURLRequest *request) {
  BOOL networkReady = RBNetworkEnsureReadyForURL(request.URL);
  RBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  RBObserveRequest(request);
  id task = ((id (*)(id, SEL, id))RBOriginalSimpleTask)(self, selector, request);
  if (!networkReady) [task cancel];
  RBDiagnosticsObserveTask(task);
  return task;
}
static id RBTask(id self, SEL selector, NSURLRequest *request, id completion) {
  BOOL networkReady = RBNetworkEnsureReadyForURL(request.URL);
  RBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  RBObserveRequest(request);
  if (getenv("ROKBOT_VALIDATE_CAPTURE") && completion) {
    void (^original)(NSData *, NSURLResponse *, NSError *) = completion;
    completion = ^(NSData *data, NSURLResponse *response, NSError *error) {
      RBDiagnosticsEvent(@"network.complete", @{@"path":request.URL.path ?: @"", @"status":@(((NSHTTPURLResponse *)response).statusCode), @"error":@(error.code)});
      original(data, response, error);
    };
  }
  id task = ((id (*)(id, SEL, id, id))RBOriginalTask)(self, selector, request, completion);
  if (!networkReady) [task cancel];
  return task;
}
static void RBInstall(void) {
  RBInstallDeepLinks();
  if (!RBOriginalLayout) {
    Class cls = NSClassFromString(@"RCTViewComponentView");
    Method method = class_getInstanceMethod(cls, @selector(layoutSubviews));
    if (method) {
      RBOriginalLayout = method_getImplementation(method);
      class_replaceMethod(cls, @selector(layoutSubviews), (IMP)RBLayout, method_getTypeEncoding(method));
    }
  }
  if (!RBOriginalRecycle) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTViewComponentView"),
                                            sel_registerName("prepareForRecycle"));
    if (method)
      RBOriginalRecycle = method_setImplementation(method, (IMP)RBRecycle);
  }
  if (!RBOriginalTouches) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTSurfaceTouchHandler"),
                                            @selector(touchesBegan:withEvent:));
    if (method)
      RBOriginalTouches = method_setImplementation(method, (IMP)RBTouches);
  }
  if (!RBOriginalSimpleTask) {
    Method method =
        class_getInstanceMethod(NSURLSession.class, sel_registerName("dataTaskWithRequest:"));
    if (method)
      RBOriginalSimpleTask = method_setImplementation(method, (IMP)RBSimpleTask);
  }
  if (!RBOriginalTask) {
    Method method = class_getInstanceMethod(
        NSURLSession.class, sel_registerName("dataTaskWithRequest:completionHandler:"));
    if (method)
      RBOriginalTask = method_setImplementation(method, (IMP)RBTask);
  }
  if (!RBOriginalLoad) {
    Method method = class_getInstanceMethod(
        NSClassFromString(@"RCTHost"), sel_registerName("loadBundleAtURL:onProgress:onComplete:"));
    if (method)
      RBOriginalLoad = method_setImplementation(method, (IMP)RBLoad);
  }
}
__attribute__((constructor)) static void RBInitialize(void) {
  @autoreleasepool {
    RBDiagnosticsEvent(@"bootstrap.begin", @{});
    Dl_info location = {0};
    dladdr((const void *)&RBInitialize, &location);
    NSString *libraryPath =
        location.dli_fname ? [NSString stringWithUTF8String:location.dli_fname] : nil;
    if (!libraryPath.length)
      return;
    RBConnection.shared.resourcesURL =
        [[NSURL fileURLWithPath:libraryPath.stringByDeletingLastPathComponent]
            URLByAppendingPathComponent:@"RokBotLocal.bundle"
                            isDirectory:YES];
    NSError *error = nil;
    BOOL restored = [RBConnection.shared restore:&error];
    RBDiagnosticsEvent(@"connection.restore", @{@"restored":restored ? @YES : @NO});
    RBInstallConnectorTransport();
    RBInstall();
    // Restore before the app creates its first RCTHost. A delayed unconditional
    // reload discards the navigation established by a cold notification click.
    dispatch_async(dispatch_get_main_queue(), ^{
      RBNetworkEnsureReadyForURL([NSURL URLWithString:RBConnection.shared.serverURL]);
      RBConnection.shared.didConnect = ^{
        RBSyncAppIntentCredentials();
        [[RBNotifications shared] start];
        RBPushSetForeground(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
        RBRefreshProfile();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ RBPushRefresh(); });
      };
      RBConnection.shared.didDisconnect = ^{
        [[RBNotifications shared] stop];
      };
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      [center addObserverForName:UIApplicationDidBecomeActiveNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        RBInstall();
                        RBNetworkEnsureReadyForURL([NSURL URLWithString:RBConnection.shared.serverURL]);
                        RBSyncAppIntentCredentials();
                        [RBInterface refresh];
                        [[RBNotifications shared] start];
                        RBPushSetForeground(YES);
                        RBRefreshProfile();
                        RBPushRefresh();
                      }];
      [center addObserverForName:UIApplicationDidEnterBackgroundNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        [[RBNotifications shared] stop];
                        RBPushSetForeground(NO);
                      }];
      for (NSString *name in @[@"RokBotProfileChanged", @"RokBotPushStateChanged"])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { [RBInterface refresh]; }];
      [NSTimer scheduledTimerWithTimeInterval:25 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive) RBPushSetForeground(YES);
      }];
      // Inspect cached transport health only while active. This also recovers a
      // stale peer when the original UI is waiting without making new requests.
      [NSTimer scheduledTimerWithTimeInterval:5 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
          RBNetworkEnsureReadyForURL([NSURL URLWithString:RBConnection.shared.serverURL]);
      }];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [RBInterface refresh];
        if (restored) {
          if (RBHost && !RBLoadedPairedBundle) RBReloadReactHost();
          [[RBNotifications shared] start];
          RBRefreshProfile();
          RBPushRefresh();
        }
      });
    });
  }
}
