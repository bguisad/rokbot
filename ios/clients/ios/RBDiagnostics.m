// Opt-in validation, enabled by a launch variable or an explicit local marker.
// Captures this app's own window and records loaded image names without secrets.
#import "RBConnection.h"
#import "RBDiagnostics.h"
#import "RBPush.h"
#import <UIKit/UIKit.h>
#import <mach-o/dyld.h>
#import <CommonCrypto/CommonDigest.h>
#import <dlfcn.h>
#import <sys/sysctl.h>
#import <objc/runtime.h>
#import <stdatomic.h>
static NSDictionary *RBLoadedBundle;
static atomic_bool RBDiagnosticsActive;
static void *RBTaskTimingContext = &RBTaskTimingContext;
static BOOL RBValidateCaptureEnv(void) {
  static BOOL enabled;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    enabled = getenv("ROKBOT_VALIDATE_CAPTURE") != NULL ||
              getenv("GROKBOT_VALIDATE_CAPTURE") != NULL;
  });
  return enabled;
}
static NSURL *RBValidationDirectory(void) {
  return [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject
      URLByAppendingPathComponent:@"HostValidation" isDirectory:YES];
}
BOOL RBDiagnosticsEnabled(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    BOOL active = RBValidateCaptureEnv();
    if (!active) {
      NSURL *directory = RBValidationDirectory();
      active = directory != nil &&
          [NSFileManager.defaultManager fileExistsAtPath:
            [directory URLByAppendingPathComponent:@"enable-notification-diagnostics"].path];
    }
    atomic_store_explicit(&RBDiagnosticsActive, active, memory_order_relaxed);
    if (!RBValidateCaptureEnv()) {
      [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidBecomeActiveNotification
                                                      object:nil
                                                       queue:nil
                                                  usingBlock:^(NSNotification *n) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
          NSURL *dir = RBValidationDirectory();
          BOOL enabled = dir != nil &&
              [NSFileManager.defaultManager fileExistsAtPath:
                [dir URLByAppendingPathComponent:@"enable-notification-diagnostics"].path];
          atomic_store_explicit(&RBDiagnosticsActive, enabled, memory_order_relaxed);
        });
      }];
    }
  });
  return atomic_load_explicit(&RBDiagnosticsActive, memory_order_relaxed);
}
@interface RBTaskTiming : NSObject {
  atomic_bool _removed;
}
- (BOOL)claimRemoval;
@end
@implementation RBTaskTiming
- (BOOL)claimRemoval {
  return !atomic_exchange(&_removed, true);
}
- (void)observeValueForKeyPath:(NSString *)path ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  if (context != RBTaskTimingContext) {
    [super observeValueForKeyPath:path ofObject:object change:change context:context];
    return;
  }
  NSURLSessionTask *task = object;
  if (task.state != NSURLSessionTaskStateCompleted) return;
  if (![self claimRemoval]) return;
  NSInteger status = [task.response isKindOfClass:NSHTTPURLResponse.class]
      ? ((NSHTTPURLResponse *)task.response).statusCode : 0;
  RBDiagnosticsEvent(@"network.taskComplete", @{@"path":task.originalRequest.URL.path ?: @"", @"status":@(status), @"error":@(task.error.code)});
  [task removeObserver:self forKeyPath:@"state" context:RBTaskTimingContext];
  objc_setAssociatedObject(task, RBTaskTimingContext, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
@end
void RBDiagnosticsObserveTask(NSURLSessionTask *task) {
  if (!RBValidateCaptureEnv() || !task || task.state == NSURLSessionTaskStateCompleted) return;
  RBTaskTiming *observer = [RBTaskTiming new];
  objc_setAssociatedObject(task, RBTaskTimingContext, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [task addObserver:observer forKeyPath:@"state" options:NSKeyValueObservingOptionNew context:RBTaskTimingContext];
  if (task.state == NSURLSessionTaskStateCompleted && [observer claimRemoval]) {
    [task removeObserver:observer forKeyPath:@"state" context:RBTaskTimingContext];
    objc_setAssociatedObject(task, RBTaskTimingContext, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}
static IMP RBOriginalNetworkComplete, RBOriginalSplashReady;
typedef void (^RBRCTFatalHandler)(NSError *);
static RBRCTFatalHandler RBPreviousFatalHandler;
static IMP RBOriginalReportFatalException;
static IMP RBOriginalReportSoftException;
static IMP RBOriginalReportException;
static IMP RBOriginalReportFatal;
static IMP RBOriginalReportSoft;
static void RBReportFatal(id self, SEL selector, NSString *message, NSArray *stack,
                          double exceptionId, NSString *extraDataAsJSON) {
  RBDiagnosticsEvent(@"javascript.fatal", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[],
    @"exceptionId": @(exceptionId),
    @"extraDataAsJSON": extraDataAsJSON ?: @""
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double, NSString *))RBOriginalReportFatal)(
      self, selector, message, stack, exceptionId, extraDataAsJSON);
}
static void RBReportSoft(id self, SEL selector, NSString *message, NSArray *stack,
                         double exceptionId, NSString *extraDataAsJSON) {
  RBDiagnosticsEvent(@"javascript.soft", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[],
    @"exceptionId": @(exceptionId),
    @"extraDataAsJSON": extraDataAsJSON ?: @""
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double, NSString *))RBOriginalReportSoft)(
      self, selector, message, stack, exceptionId, extraDataAsJSON);
}
static void RBFatal(id self, SEL selector, NSString *message, NSArray *stack, double exceptionId) {
  RBDiagnosticsEvent(@"javascript.fatal", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[]
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double))RBOriginalReportFatalException)(
      self, selector, message, stack, exceptionId);
}
static void RBSoft(id self, SEL selector, NSString *message, NSArray *stack, double exceptionId) {
  RBDiagnosticsEvent(@"javascript.soft", @{
    @"message": message ?: @"",
    @"stack": stack ?: @[]
  });
  ((void (*)(id, SEL, NSString *, NSArray *, double))RBOriginalReportSoftException)(
      self, selector, message, stack, exceptionId);
}
static void RBReport(id self, SEL selector, void *data) {
  RBDiagnosticsEvent(@"javascript.exception", @{});
  ((void (*)(id, SEL, void *))RBOriginalReportException)(self, selector, data);
}
static void RBSplashReady(id self, SEL selector) {
  RBDiagnosticsEvent(@"splash.appReady", @{});
  ((void (*)(id,SEL))RBOriginalSplashReady)(self,selector);
}
static void RBNetworkComplete(id self, SEL selector, NSURLSession *session, NSURLSessionTask *task, NSError *error) {
  NSInteger status = [task.response isKindOfClass:NSHTTPURLResponse.class]
      ? ((NSHTTPURLResponse *)task.response).statusCode : 0;
  RBDiagnosticsEvent(@"network.complete", @{@"path":task.originalRequest.URL.path ?: @"", @"status":@(status), @"error":@(error.code)});
  ((void (*)(id,SEL,id,id,id))RBOriginalNetworkComplete)(self,selector,session,task,error);
}
static BOOL RBContainsReadyLabel(UIView *view, NSString *label) {
  if (view.hidden || view.alpha < .01) return NO;
  NSString *value = [view isKindOfClass:UILabel.class] ? ((UILabel *)view).text : view.accessibilityLabel;
  if ([value containsString:label]) return YES;
  for (UIView *child in view.subviews) if (RBContainsReadyLabel(child, label)) return YES;
  return NO;
}
void RBDiagnosticsEvent(NSString *event, NSDictionary *values) {
  if (!RBDiagnosticsEnabled()) return;
  NSURL *directory = RBValidationDirectory();
  if (!directory) return;
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
  if (RBValidateCaptureEnv())
    RBLoadedBundle = @{@"requested":RBBundleDescription(requested), @"loaded":RBBundleDescription(loaded)};
}
static void *RBResolveReactSymbol(const char *symbolName) {
  void *sym = dlsym(RTLD_DEFAULT, symbolName);
  if (sym) return sym;
  const char *classImage = class_getImageName(NSClassFromString(@"RCTExceptionsManager"));
  if (classImage) {
    void *image = dlopen(classImage, RTLD_LAZY | RTLD_NOLOAD);
    if (image) {
      sym = dlsym(image, symbolName);
      dlclose(image);
      if (sym) return sym;
    }
  }
  for (uint32_t i = 0; i < _dyld_image_count(); i++) {
    const char *path = _dyld_get_image_name(i);
    if (!path || !strstr(path, "/React.framework/React")) continue;
    void *image = dlopen(path, RTLD_LAZY | RTLD_NOLOAD);
    if (image) {
      sym = dlsym(image, symbolName);
      dlclose(image);
      if (sym) return sym;
    }
  }
  return NULL;
}
__attribute__((constructor)) static void RBInstallDiagnostics(void) {
  if (!RBValidateCaptureEnv())
    return;
  typedef void (*RBSetFatalHandler)(RBRCTFatalHandler);
  typedef RBRCTFatalHandler (*RBGetFatalHandler)(void);
  RBSetFatalHandler setFatalHandler =
      (RBSetFatalHandler)RBResolveReactSymbol("RCTSetFatalHandler");
  RBGetFatalHandler getFatalHandler =
      (RBGetFatalHandler)RBResolveReactSymbol("RCTGetFatalHandler");
  if (setFatalHandler) {
    RBPreviousFatalHandler = getFatalHandler ? getFatalHandler() : nil;
    setFatalHandler(^(NSError *error) {
      RBDiagnosticsEvent(@"native.fatal", @{
        @"domain": error.domain ?: @"",
        @"code": @(error.code),
        @"reason": error.localizedDescription ?: @""
      });
      if (RBPreviousFatalHandler) {
        RBPreviousFatalHandler(error);
      } else {
        // Match React Native's default fatal handler by raising an NSException
        // instead of swallowing the fatal error during validation runs.
        [NSException raise:@"RCTFatalException"
                    format:@"Unhandled React Native fatal error: %@",
                           error.localizedDescription ?: @"(unknown)"];
      }
    });
  }
  Class exceptions = NSClassFromString(@"RCTExceptionsManager");
  Method fatalWithExtra = class_getInstanceMethod(
      exceptions, NSSelectorFromString(@"reportFatal:stack:exceptionId:extraDataAsJSON:"));
  Method softWithExtra = class_getInstanceMethod(
      exceptions, NSSelectorFromString(@"reportSoft:stack:exceptionId:extraDataAsJSON:"));
  Method fatal = class_getInstanceMethod(
      exceptions, @selector(reportFatalException:stack:exceptionId:));
  Method soft = class_getInstanceMethod(
      exceptions, @selector(reportSoftException:stack:exceptionId:));
  Method report = class_getInstanceMethod(exceptions, @selector(reportException:));
  if (fatalWithExtra)
    RBOriginalReportFatal = method_setImplementation(fatalWithExtra, (IMP)RBReportFatal);
  if (softWithExtra)
    RBOriginalReportSoft = method_setImplementation(softWithExtra, (IMP)RBReportSoft);
  if (fatal) RBOriginalReportFatalException = method_setImplementation(fatal, (IMP)RBFatal);
  if (soft) RBOriginalReportSoftException = method_setImplementation(soft, (IMP)RBSoft);
  if (report) RBOriginalReportException = method_setImplementation(report, (IMP)RBReport);
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
