// Opt-in validation, enabled by a launch variable or an explicit local marker.
// Captures this app's own window and records loaded image names without secrets.
#import "RBConnection.h"
#import "RBDiagnostics.h"
#import "RBPush.h"
#import <UIKit/UIKit.h>
#import <mach-o/dyld.h>
#import <CommonCrypto/CommonDigest.h>
#import <sys/sysctl.h>
#import <objc/runtime.h>
static NSDictionary *RBLoadedBundle;
@interface RBTaskTiming : NSObject
@end
@implementation RBTaskTiming
- (void)observeValueForKeyPath:(NSString *)path ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  NSURLSessionTask *task = object;
  if (task.state != NSURLSessionTaskStateCompleted) return;
  RBDiagnosticsEvent(@"network.taskComplete", @{@"path":task.originalRequest.URL.path ?: @"", @"status":@(((NSHTTPURLResponse *)task.response).statusCode), @"error":@(task.error.code)});
  [task removeObserver:self forKeyPath:@"state"];
  objc_setAssociatedObject(task, @selector(observeValueForKeyPath:ofObject:change:context:), nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
@end
void RBDiagnosticsObserveTask(NSURLSessionTask *task) {
  if (!getenv("ROKBOT_VALIDATE_CAPTURE")) return;
  RBTaskTiming *observer = [RBTaskTiming new];
  objc_setAssociatedObject(task, @selector(observeValueForKeyPath:ofObject:change:context:), observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [task addObserver:observer forKeyPath:@"state" options:NSKeyValueObservingOptionNew context:nil];
}
static IMP RBOriginalNetworkComplete, RBOriginalSplashReady;
static void RBSplashReady(id self, SEL selector) {
  RBDiagnosticsEvent(@"splash.appReady", @{});
  ((void (*)(id,SEL))RBOriginalSplashReady)(self,selector);
}
static void RBNetworkComplete(id self, SEL selector, NSURLSession *session, NSURLSessionTask *task, NSError *error) {
  RBDiagnosticsEvent(@"network.complete", @{@"path":task.originalRequest.URL.path ?: @"", @"status":@(((NSHTTPURLResponse *)task.response).statusCode), @"error":@(error.code)});
  ((void (*)(id,SEL,id,id,id))RBOriginalNetworkComplete)(self,selector,session,task,error);
}
static BOOL RBContainsReadyLabel(UIView *view, NSString *label) {
  if (view.hidden || view.alpha < .01) return NO;
  NSString *value = [view isKindOfClass:UILabel.class] ? ((UILabel *)view).text : view.accessibilityLabel;
  if ([value containsString:label]) return YES;
  for (UIView *child in view.subviews) if (RBContainsReadyLabel(child, label)) return YES;
  return NO;
}
static NSURL *RBValidationDirectory(void) {
  return [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject
      URLByAppendingPathComponent:@"HostValidation" isDirectory:YES];
}
void RBDiagnosticsEvent(NSString *event, NSDictionary *values) {
  NSURL *directory = RBValidationDirectory();
  if (!getenv("ROKBOT_VALIDATE_CAPTURE") &&
      ![NSFileManager.defaultManager fileExistsAtPath:
        [directory URLByAppendingPathComponent:@"enable-notification-diagnostics"].path]) return;
  @synchronized (RBConnection.class) {
    [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *file = [directory URLByAppendingPathComponent:@"notification-events.json"];
    NSData *old = [NSData dataWithContentsOfURL:file];
    NSMutableArray *events = old ? [[NSJSONSerialization JSONObjectWithData:old options:NSJSONReadingMutableContainers error:nil] mutableCopy] : nil;
    if (![events isKindOfClass:NSMutableArray.class]) events = [NSMutableArray new];
    if ([event isEqual:@"bootstrap.begin"]) {
      struct kinfo_proc process = {0}; size_t length = sizeof(process);
      int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
      if (sysctl(mib, 4, &process, &length, NULL, 0) == 0 && length)
        values = @{@"processStartedAt":@((double)process.kp_proc.p_starttime.tv_sec + process.kp_proc.p_starttime.tv_usec / 1e6)};
    }
    [events addObject:@{@"event":event, @"values":values ?: @{}, @"pid":@(getpid()),
      @"time":@([NSDate.date timeIntervalSince1970])}];
    while (events.count > 256) [events removeObjectAtIndex:0];
    [[NSJSONSerialization dataWithJSONObject:events options:NSJSONWritingPrettyPrinted error:nil] writeToURL:file atomically:YES];
  }
}
static NSDictionary *RBBundleDescription(NSURL *url) {
  NSString *kind = [url.path hasPrefix:NSBundle.mainBundle.bundlePath] ? @"embedded" :
      [url.lastPathComponent isEqual:RBConnection.shared.gatewayBundleURL.lastPathComponent] ? @"paired" : @"external-cache";
  NSMutableDictionary *result = [@{@"kind":kind, @"file":url.lastPathComponent ?: @""} mutableCopy];
  if (![kind isEqual:@"paired"] && url.isFileURL) {
    NSData *data = [NSData dataWithContentsOfURL:url];
    if (data && data.length <= UINT_MAX) {
      unsigned char digest[CC_SHA256_DIGEST_LENGTH];
      CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
      NSMutableString *hex = [NSMutableString new];
      for (NSUInteger i=0; i<sizeof(digest); i++) [hex appendFormat:@"%02x",digest[i]];
      result[@"sha256"] = hex;
    }
  }
  return result;
}
void RBDiagnosticsRecordBundle(NSURL *requested, NSURL *loaded) {
  RBDiagnosticsEvent(@"bundle.load", @{@"requested":requested.lastPathComponent ?: @"", @"loaded":loaded.lastPathComponent ?: @""});
  if (getenv("ROKBOT_VALIDATE_CAPTURE"))
    RBLoadedBundle = @{@"requested":RBBundleDescription(requested), @"loaded":RBBundleDescription(loaded)};
}
__attribute__((constructor)) static void RBInstallDiagnostics(void) {
  if (!getenv("ROKBOT_VALIDATE_CAPTURE"))
    return;
  Method networkComplete = class_getInstanceMethod(NSClassFromString(@"RCTHTTPRequestHandler"), @selector(URLSession:task:didCompleteWithError:));
  if (networkComplete) RBOriginalNetworkComplete = method_setImplementation(networkComplete,(IMP)RBNetworkComplete);
  for (NSString *name in @[@"RCTJavaScriptWillStartLoadingNotification", @"RCTJavaScriptWillStartExecutingNotification", @"RCTJavaScriptDidLoadNotification", @"RCTContentDidAppearNotification"])
    [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *n) {
      RBDiagnosticsEvent(@"react.lifecycle", @{@"name":name});
    }];
  Class splash = NSClassFromString(@"_TtC16ExpoSplashScreen19SplashScreenManager");
  Method ready = class_getInstanceMethod(splash, NSSelectorFromString(@"onAppReady"));
  if (ready) RBOriginalSplashReady = method_setImplementation(ready, (IMP)RBSplashReady);
  unsigned int count = 0; Method *methods = class_copyMethodList(splash, &count);
  NSMutableArray *selectors = [NSMutableArray new];
  for (unsigned int i=0; i<count; i++)
    [selectors addObject:@{@"selector":NSStringFromSelector(method_getName(methods[i])), @"type":[NSString stringWithUTF8String:method_getTypeEncoding(methods[i])]}];
  free(methods);
  RBDiagnosticsEvent(@"splash.methods", @{@"methods":selectors});
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *label = [NSString stringWithContentsOfURL:[RBValidationDirectory() URLByAppendingPathComponent:@"expected-ready-label"] encoding:NSUTF8StringEncoding error:nil];
    if (!label.length) return;
    __block NSUInteger ticks = 0;
    [NSTimer scheduledTimerWithTimeInterval:.1 repeats:YES block:^(NSTimer *timer) {
      if (++ticks > 600) { [timer invalidate]; return; }
      for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
        if ([s isKindOfClass:UIWindowScene.class])
          for (UIWindow *w in ((UIWindowScene *)s).windows)
            if (w.isKeyWindow && RBContainsReadyLabel(w, label)) {
              RBDiagnosticsEvent(@"ui.ready", @{@"label":label});
              UIGraphicsImageRenderer *r = [[UIGraphicsImageRenderer alloc] initWithBounds:w.bounds];
              UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *context) { [w drawViewHierarchyInRect:w.bounds afterScreenUpdates:NO]; }];
              [UIImagePNGRepresentation(image) writeToURL:[RBValidationDirectory() URLByAppendingPathComponent:@"ready.png"] atomically:YES];
              [timer invalidate]; return;
            }
    }];
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 12 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    UIWindow *window = nil;
    for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
      if ([s isKindOfClass:UIWindowScene.class])
        for (UIWindow *w in ((UIWindowScene *)s).windows)
          if (w.isKeyWindow)
            window = w;
    if (!window)
      return;
    UIGraphicsImageRenderer *renderer =
        [[UIGraphicsImageRenderer alloc] initWithBounds:window.bounds];
    UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
      [window drawViewHierarchyInRect:window.bounds afterScreenUpdates:NO];
    }];
    NSURL *directory = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory
                                                             inDomains:NSUserDomainMask]
                            .firstObject URLByAppendingPathComponent:@"HostValidation"
                                                         isDirectory:YES];
    [NSFileManager.defaultManager
               createDirectoryAtURL:directory
        withIntermediateDirectories:YES
                         attributes:@{
                           NSFileProtectionKey :
                               NSFileProtectionCompleteUntilFirstUserAuthentication
                         }
                              error:nil];
    [UIImagePNGRepresentation(image)
        writeToURL:[directory URLByAppendingPathComponent:@"cold-start.png"]
        atomically:YES];
    NSMutableArray *images = [NSMutableArray new];
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
      const char *path = _dyld_get_image_name(i);
      if (path)
        [images addObject:[[NSString stringWithUTF8String:path] lastPathComponent]];
    }
    NSDictionary *report = @{
      @"capturedAt" : @([NSDate.date timeIntervalSince1970]),
      @"apnsEnvironment" : RBPushEnvironment() ?: (id)NSNull.null,
      @"bundleId" : NSBundle.mainBundle.bundleIdentifier,
      @"paired" : @(RBConnection.shared.deviceToken.length > 0),
      @"gatewayReady" : @(RBConnection.shared.gatewayBundleURL != nil),
      @"script" : RBLoadedBundle ?: @{},
      @"images" : images
    };
    [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil]
        writeToURL:[directory URLByAppendingPathComponent:@"cold-start.json"]
        atomically:YES];
  });
}
