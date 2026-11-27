#import "RBLocalize.h"
#import "RBPush.h"
#import "RBConnection.h"
#import "RBDeviceIdentity.h"
#import "RBHTTP.h"
#import "RBDiagnostics.h"
#import "RBSuggestions.h"
#import <Security/Security.h>
#import <UserNotifications/UserNotifications.h>
#import <dlfcn.h>
#import <objc/runtime.h>

static NSString *RBPushAsString(id value) {
  return [value isKindOfClass:NSString.class] ? (NSString *)value : nil;
}

static NSDictionary *RBPushAsDict(id value) {
  return [value isKindOfClass:NSDictionary.class] ? (NSDictionary *)value : nil;
}

static BOOL RBPushBoolValue(id value, BOOL fallback) {
  if ([value isKindOfClass:NSNumber.class])
    return [(NSNumber *)value boolValue];
  if ([value isKindOfClass:NSString.class])
    return [(NSString *)value boolValue];
  return fallback;
}

static NSString *RBAPNsToken;
static NSString *RBRegistrationError;
static BOOL RBAuthorizing;
static BOOL RBAuthorizationAttempted;
static BOOL RBPromptVisible;
static IMP RBOriginalRegistered;
static IMP RBOriginalFailed;
static Class RBInstalledDelegate;
static NSDictionary *RBDevicePushState;
static NSString *RBDevicePushStateIdentity;
static char RBOriginalSwitchTargets;
static char RBHiddenPushEntryKey;
static NSString *RBPushStateKey(void) {
  return [@"RokBotLocal.pushState." stringByAppendingString:
    [NSUserDefaults.standardUserDefaults stringForKey:@"RokBotLocal.deviceId"] ?: @"unpaired"];
}
static void RBPushDiagnostic(NSString *event, NSDictionary *values) {
  static BOOL capture;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    capture = getenv("ROKBOT_VALIDATE_CAPTURE") != NULL ||
              getenv("GROKBOT_VALIDATE_CAPTURE") != NULL;
  });
  if (!capture) return;
  NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"HostValidation"];
  [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSMutableDictionary *report = [values mutableCopy]; report[@"event"] = event;
  [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil]
      writeToURL:[dir URLByAppendingPathComponent:[@"push-" stringByAppendingFormat:@"%@.json",event]] atomically:YES];
}
static NSString *RBAuthName(UNAuthorizationStatus value) {
  switch (value) {
  case UNAuthorizationStatusDenied: return @"denied";
  case UNAuthorizationStatusAuthorized: return @"authorized";
  case UNAuthorizationStatusProvisional: return @"provisional";
  case UNAuthorizationStatusEphemeral: return @"ephemeral";
  default: return @"notDetermined";
  }
}
static NSString *RBReadPushEnvironment(void) {
  // Query the running process's actual code-signing entitlement, not its profile
  // and not the separate user-notification authorization setting.
  typedef CFTypeRef (*Create)(CFAllocatorRef);
  typedef CFTypeRef (*Copy)(CFTypeRef, CFStringRef, CFErrorRef *);
  Create create = (Create)dlsym(RTLD_DEFAULT, "SecTaskCreateFromSelf");
  Copy copy = (Copy)dlsym(RTLD_DEFAULT, "SecTaskCopyValueForEntitlement");
  if (!create || !copy) return nil;
  CFTypeRef task = create(kCFAllocatorDefault);
  if (!task) return nil;
  id value = CFBridgingRelease(copy(task, CFSTR("aps-environment"), NULL));
  CFRelease(task);
  return [value isEqual:@"development"] || [value isEqual:@"production"] ? value : nil;
}
NSString *RBPushEnvironment(void) {
  static NSString *environment;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ environment = RBReadPushEnvironment(); });
  return environment;
}
static UIViewController *RBPushTop(void) {
  UIViewController *top;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow) top = w.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}
static void RBDeviceRequest(NSString *method, NSDictionary *body,
                            void (^done)(NSDictionary *, NSError *)) {
  NSString *base = RBConnection.shared.serverURL, *token = RBConnection.shared.deviceToken;
  NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:@"/local/device"]] : nil;
  if (!url || !token.length) {
    if (done) {
      NSError *err = [NSError errorWithDomain:@"RokBotDevice" code:401 userInfo:nil];
      dispatch_async(dispatch_get_main_queue(), ^{ done(nil, err); });
    }
    return;
  }
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url];
  r.HTTPMethod = method; r.timeoutInterval = 15;
  [r setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[RBHTTPSession() dataTaskWithRequest:r completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSDictionary *dict = RBPushAsDict(value);
    NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                           ? ((NSHTTPURLResponse *)response).statusCode
                           : 0;
    if (!error && (status < 200 || status >= 300 || !dict))
      error = [NSError errorWithDomain:@"RokBotDevice" code:status userInfo:nil];
    NSString *respErr = RBPushAsString(dict[@"error"]) ?: @"";
    RBPushDiagnostic(@"request", @{@"method":method,@"status":@(status),@"errorDomain":error.domain ?: @"",@"errorCode":@(error.code),@"responseError":respErr});
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![base isEqual:RBConnection.shared.serverURL] || ![token isEqual:RBConnection.shared.deviceToken]) {
        if (done) done(nil, [NSError errorWithDomain:@"RokBotDevice" code:NSURLErrorCancelled userInfo:nil]);
        return;
      }
      NSDictionary *push = RBPushAsDict(dict[@"push"]);
      if (!error && push) {
        // Persist only display state, never push tokens, URLs, or JSON nulls.
        NSString *provider = RBPushAsString(push[@"provider"]);
        NSString *authorization = RBPushAsString(push[@"authorization"]);
        NSDictionary *nextState = @{@"provider":provider.length ? provider : @"none",
                              @"configured":RBPushBoolValue(push[@"configured"], NO) ? @YES : @NO,
                              @"enabled":RBPushBoolValue(push[@"enabled"], NO) ? @YES : @NO,
                              @"authorization":authorization.length ? authorization : @"notDetermined"};
        NSString *key = RBPushStateKey();
        if (![key isEqualToString:RBDevicePushStateIdentity] || ![nextState isEqualToDictionary:RBDevicePushState]) {
          RBDevicePushState = nextState;
          RBDevicePushStateIdentity = key;
          [NSUserDefaults.standardUserDefaults setObject:RBDevicePushState forKey:key];
          [NSNotificationCenter.defaultCenter postNotificationName:@"RokBotPushStateChanged" object:nil];
        }
      }
      if (done) done(dict, error);
    });
  }] resume];
}
static void RBReportDevice(UNNotificationSettings *settings) {
  NSString *environment = RBPushEnvironment();
  RBPushDiagnostic(@"registration", @{@"environment":environment ?: (id)NSNull.null,@"authorization":RBAuthName(settings.authorizationStatus),@"tokenPresent":@(RBAPNsToken.length > 0),@"registrationError":RBRegistrationError ?: @""});
  NSMutableDictionary *body = [@{
    @"name": UIDevice.currentDevice.name ?: @"",
    @"kind": UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad ? @"ipad" : @"iphone",
    @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
    @"clientDeviceId": RBClientDeviceId(),
    @"appVersion": [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
    // Objective-C comparison expressions box as NSNumber(int), which JSON
    // encodes as 0/1. The Host correctly requires a JSON boolean here.
    @"apnsCapable": environment ? @YES : @NO,
    @"apnsEnvironment": environment ?: NSNull.null,
    @"authorization": RBAuthName(settings.authorizationStatus)
  } mutableCopy];
  if (environment && RBAPNsToken.length)
    body[@"push"] = @{ @"provider": @"apns", @"token": RBAPNsToken, @"registrationError": NSNull.null };
  else if (RBRegistrationError)
    body[@"push"] = @{ @"registrationError": RBRegistrationError };
  else if (!environment)
    body[@"push"] = @{ @"registrationError": NSNull.null };
  RBDeviceRequest(@"PUT", body, nil);
}
void RBPushSetForeground(BOOL foreground) {
  if (!RBConnection.shared.deviceToken.length) return;
  __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
  void (^endTask)(void) = ^{
    void (^finish)(void) = ^{
      if (task != UIBackgroundTaskInvalid) {
        UIBackgroundTaskIdentifier current = task;
        task = UIBackgroundTaskInvalid;
        [UIApplication.sharedApplication endBackgroundTask:current];
      }
    };
    if ([NSThread isMainThread]) finish();
    else dispatch_async(dispatch_get_main_queue(), finish);
  };
  if (!foreground)
    task = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Host notification state"
                                                      expirationHandler:endTask];
  RBDeviceRequest(@"PUT", @{@"foreground":foreground ? @YES : @NO}, ^(NSDictionary *value, NSError *error) {
    RBDiagnosticsEvent(@"presence.report", @{@"foreground":foreground ? @YES : @NO, @"success":error ? @NO : @YES});
    endTask();
  });
}
static BOOL RBClaimNotification(NSString *identity) {
  NSString *base = RBConnection.shared.serverURL;
  if (!base.length || !identity.length) return NO;
  NSMutableDictionary *all = [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"RokBotLocal.notificationSeen"] mutableCopy] ?: [NSMutableDictionary new];
  NSMutableArray *seen = [all[base] mutableCopy] ?: [NSMutableArray new];
  if ([seen containsObject:identity]) return NO;
  [seen addObject:identity];
  while (seen.count > 256) [seen removeObjectAtIndex:0];
  all[base] = seen;
  [NSUserDefaults.standardUserDefaults setObject:all forKey:@"RokBotLocal.notificationSeen"];
  return YES;
}
void RBReceiveLocalNotification(NSDictionary *n) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSDictionary *dict = RBPushAsDict(n);
    if (!dict) return;
    NSString *identity = RBPushAsString(dict[@"notificationId"]) ?: RBPushAsString(dict[@"id"]);
    if (!identity.length || !RBClaimNotification(identity)) return;
    // The original PushPayload.foregroundBehavior suppresses task-completion
    // banners. Conversation state continues through the existing Gateway stream.
    // Keep receipts/deduplication without adding a separate completion UI.
    RBDiagnosticsEvent(@"notification.foregroundReceipt", @{ @"agentId": RBPushAsString(dict[@"agentId"]) ?: @"" });
    // A finished task means a new reply for that bot: refresh its suggestions (no-op for other bots' UI).
    RBSuggestionsNoteReply(RBPushAsString(dict[@"agentId"]));
  });
}
@interface RBPushDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> original;
@end
@implementation RBPushDelegate
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector { return self.original; }
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)n
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))done {
  NSDictionary *payload = n.request.content.userInfo;
  if ([payload[@"notificationId"] isKindOfClass:NSString.class]) {
    RBDiagnosticsEvent(@"notification.foreground", @{@"agentId":payload[@"agentId"] ?: @""});
    RBReceiveLocalNotification(payload); done(UNNotificationPresentationOptionNone); return;
  }
  if ([self.original respondsToSelector:_cmd])
    [self.original userNotificationCenter:center willPresentNotification:n withCompletionHandler:done];
  else done(UNNotificationPresentationOptionNone);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))done {
  NSDictionary *p = response.notification.request.content.userInfo;
  if ([p[@"notificationId"] isKindOfClass:NSString.class]) {
    RBDiagnosticsEvent(@"notification.response", @{@"agentId":p[@"agentId"] ?: @"", @"action":response.actionIdentifier ?: @""});
    RBClaimNotification(p[@"notificationId"]);
    RBOpenAgent(p[@"agentId"]); done(); return;
  }
  if ([self.original respondsToSelector:_cmd])
    [self.original userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:done];
  else done();
}
@end
static RBPushDelegate *RBNotificationDelegate;
static IMP RBOriginalSetNotificationDelegate;
static void RBSetNotificationDelegate(id self, SEL cmd, id<UNUserNotificationCenterDelegate> delegate) {
  if (!RBNotificationDelegate) RBNotificationDelegate = [RBPushDelegate new];
  if (delegate != RBNotificationDelegate) RBNotificationDelegate.original = delegate;
  ((void (*)(id,SEL,id))RBOriginalSetNotificationDelegate)(self,cmd,RBNotificationDelegate);
}
__attribute__((constructor)) static void RBObserveNotificationDelegate(void) {
  // iOS may deliver a cold-start response before didBecomeActive/registration.
  // Wrap the first delegate assignment, while preserving unrelated notifications.
  Method method = class_getInstanceMethod(UNUserNotificationCenter.class, @selector(setDelegate:));
  if (method) RBOriginalSetNotificationDelegate = method_setImplementation(method,(IMP)RBSetNotificationDelegate);
}
static void RBRegistered(id self, SEL cmd, UIApplication *app, NSData *token) {
  if (!RBConnection.shared.deviceToken.length) {
    if (RBOriginalRegistered) ((void (*)(id,SEL,id,id))RBOriginalRegistered)(self,cmd,app,token);
    return;
  }
  const unsigned char *bytes = token.bytes;
  NSMutableString *value = [NSMutableString stringWithCapacity:token.length * 2];
  for (NSUInteger i=0; i<token.length; i++) [value appendFormat:@"%02x",bytes[i]];
  RBAPNsToken = value; RBRegistrationError = nil;
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    dispatch_async(dispatch_get_main_queue(), ^{ RBReportDevice(s); });
  }];
}
static void RBFailed(id self, SEL cmd, UIApplication *app, NSError *error) {
  if (!RBConnection.shared.deviceToken.length) {
    if (RBOriginalFailed) ((void (*)(id,SEL,id,id))RBOriginalFailed)(self,cmd,app,error);
    return;
  }
  // The original app can request APNs even in a wildcard-signed Bark build.
  // That expected missing-entitlement error is unrelated to Bark delivery.
  if (!RBPushEnvironment()) { RBRegistrationError = nil; return; }
  RBRegistrationError = [NSString stringWithFormat:@"%@ (%ld)",error.domain,(long)error.code];
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    dispatch_async(dispatch_get_main_queue(), ^{ RBReportDevice(s); });
  }];
}
static IMP RBHook(Class cls, SEL selector, IMP replacement) {
  Method method = class_getInstanceMethod(cls, selector);
  IMP original = method ? method_getImplementation(method) : NULL;
  const char *types = method ? method_getTypeEncoding(method) : "v@:@@";
  class_replaceMethod(cls, selector, replacement, types); return original;
}
static void RBInstallPushDelegate(void) {
  Class cls = object_getClass(UIApplication.sharedApplication.delegate);
  if (cls && RBInstalledDelegate != cls) {
    RBOriginalRegistered = RBHook(cls, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:), (IMP)RBRegistered);
    RBOriginalFailed = RBHook(cls, @selector(application:didFailToRegisterForRemoteNotificationsWithError:), (IMP)RBFailed);
    RBInstalledDelegate = cls;
  }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  if (!RBNotificationDelegate) RBNotificationDelegate = [RBPushDelegate new];
  if (center.delegate != RBNotificationDelegate) {
    RBNotificationDelegate.original = center.delegate; center.delegate = RBNotificationDelegate;
  }
}
static NSString *RBPromptKey(void) {
  return [@"RokBotLocal.barkPrompt." stringByAppendingString:
    [NSUserDefaults.standardUserDefaults stringForKey:@"RokBotLocal.deviceId"] ?: @"unpaired"];
}
static void RBShowBark(void) {
  if (RBPromptVisible || !RBConnection.shared.deviceToken.length) return;
  UIViewController *top = RBPushTop();
  if (!top || [top isKindOfClass:UIAlertController.class] || top.beingDismissed) return;
  RBPromptVisible = YES;
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:RBL(@"接收通知", @"Notifications")
    message:RBL(@"粘贴 Bark 推送链接", @"Paste your Bark notification URL")
    preferredStyle:UIAlertControllerStyleAlert];
  [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
    field.placeholder = @"https://api.day.app/…"; field.keyboardType = UIKeyboardTypeURL;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.autocorrectionType = UITextAutocorrectionTypeNo; field.secureTextEntry = YES;
  }];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"稍后", @"Not now") style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) {
    RBPromptVisible = NO; [NSUserDefaults.standardUserDefaults setBool:YES forKey:RBPromptKey()];
  }]];
  __weak UIAlertController *weakAlert = alert;
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"保存", @"Save") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
    RBPromptVisible = NO;
    NSString *input = weakAlert.textFields.firstObject.text;
    RBDeviceRequest(@"PUT", @{ @"push": @{ @"provider": @"bark", @"barkUrl": input ?: @"" } }, ^(NSDictionary *value, NSError *error) {
      if (!error) { [NSUserDefaults.standardUserDefaults setBool:YES forKey:RBPromptKey()]; return; }
      if ([error.domain isEqualToString:@"RokBotDevice"] && error.code == NSURLErrorCancelled) return;
      UIAlertController *failed = [UIAlertController alertControllerWithTitle:RBL(@"未能保存", @"Could not save")
        message:RBL(@"请检查 Bark 链接和服务端连接。", @"Check the Bark URL and Host connection.") preferredStyle:UIAlertControllerStyleAlert];
      [failed addAction:[UIAlertAction actionWithTitle:RBL(@"重试", @"Retry") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { RBShowBark(); }]];
      [failed addAction:[UIAlertAction actionWithTitle:RBL(@"稍后", @"Not now") style:UIAlertActionStyleCancel handler:nil]];
      UIViewController *presenter = RBPushTop();
      if (presenter && ![presenter isKindOfClass:UIAlertController.class] && !presenter.beingDismissed)
        [presenter presentViewController:failed animated:YES completion:nil];
    });
  }]];
  [top presentViewController:alert animated:YES completion:nil];
}
void RBPushShowSettings(void) {
  if (!RBPushEnvironment()) { RBShowBark(); return; }
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:UIApplicationOpenSettingsURLString] options:@{} completionHandler:nil];
}
@interface RBPushEntry : UIButton
@property(nonatomic, weak) UISwitch *originalSwitch;
@property(nonatomic, strong) UILabel *stateLabel;
@property(nonatomic, strong) UIImageView *chevron;
@end
@implementation RBPushEntry
- (void)open { RBPushShowSettings(); }
+ (void)changed:(UISwitch *)control {
  if (!RBPushEnvironment()) { RBPushShowSettings(); return; }
  BOOL requested = control.on;
  control.enabled = NO;
  void (^save)(BOOL) = ^(BOOL enabled) {
    RBDeviceRequest(@"PUT", @{@"push":@{@"enabled":enabled ? @YES : @NO}}, ^(NSDictionary *value, NSError *error) {
      control.enabled = YES;
      if (error) control.on = !requested;
      if (enabled && !error) RBPushRefresh();
    });
  };
  if (!requested) { save(NO); return; }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert|UNAuthorizationOptionSound|UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
          dispatch_async(dispatch_get_main_queue(), ^{ control.on = granted; save(granted); });
        }];
      } else if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
        control.enabled = YES; control.on = NO; RBPushShowSettings();
      } else save(YES);
    });
  }];
}
@end
static UISwitch *RBNotificationSwitch(UIView *view) {
  UISwitch *control = [view isKindOfClass:UISwitch.class] ? (UISwitch *)view : nil;
  if (!control)
    for (UIView *child in view.subviews)
      if ([child isKindOfClass:UISwitch.class]) { control = (UISwitch *)child; break; }
  return control;
}
static void RBAssociateHiddenPushEntry(UISwitch *control, RBPushEntry *entry) {
  if (!control) return;
  if (!entry) {
    objc_setAssociatedObject(control, &RBHiddenPushEntryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return;
  }
  NSHashTable<RBPushEntry *> *box = objc_getAssociatedObject(control, &RBHiddenPushEntryKey);
  if (box && box.anyObject == entry) return;
  box = [NSHashTable weakObjectsHashTable];
  [box addObject:entry];
  objc_setAssociatedObject(control, &RBHiddenPushEntryKey, box, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
void RBResetPushView(UIView *view) {
  UISwitch *control = RBNotificationSwitch(view);
  NSMapTable *targets = control ? objc_getAssociatedObject(control, &RBOriginalSwitchTargets) : nil;
  if (targets) {
    [control removeTarget:RBPushEntry.class action:@selector(changed:) forControlEvents:UIControlEventValueChanged];
    for (id target in targets)
      for (NSString *action in [targets objectForKey:target])
        [control addTarget:target action:NSSelectorFromString(action) forControlEvents:UIControlEventValueChanged];
    objc_setAssociatedObject(control, &RBOriginalSwitchTargets, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  NSHashTable<RBPushEntry *> *hiddenBox = control ? objc_getAssociatedObject(control, &RBHiddenPushEntryKey) : nil;
  if (hiddenBox) {
    RBPushEntry *linked = hiddenBox.anyObject;
    objc_setAssociatedObject(control, &RBHiddenPushEntryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (control.hidden) control.hidden = NO;
    if ([linked isKindOfClass:RBPushEntry.class] && linked.originalSwitch == control) {
      linked.originalSwitch = nil;
      [linked removeFromSuperview];
    }
  }
  RBPushEntry *entry = (RBPushEntry *)[view viewWithTag:731990];
  if ([entry isKindOfClass:RBPushEntry.class]) {
    UISwitch *orig = entry.originalSwitch;
    if (orig) {
      objc_setAssociatedObject(orig, &RBHiddenPushEntryKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (orig.hidden) orig.hidden = NO;
      entry.originalSwitch = nil;
    }
    [entry removeFromSuperview];
  }
}
BOOL RBReplacePushView(UIView *view) {
  if (!RBConnection.shared.isPaired) return NO;
  UISwitch *control = RBNotificationSwitch(view);
  static NSSet<NSString *> *switchLabels;
  static NSSet<NSString *> *authorizedStates;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    switchLabels = [NSSet setWithArray:@[@"通知", @"Notifications"]];
    authorizedStates = [NSSet setWithArray:@[@"authorized", @"provisional", @"ephemeral"]];
  });
  if (!control || !control.accessibilityLabel.length || ![switchLabels containsObject:control.accessibilityLabel]) return NO;
  // Scope global push replacement to the App Settings screen so per-Bot
  // "Notifications" toggles inside Bot Settings keep their native behavior.
  // When the view temporarily leaves the window without a fresh cache hit,
  // leave any existing replacement untouched until it re-enters the window.
  RBSettingsContextState settingsState = RBGlobalSettingsContextState(view);
  if (settingsState != RBSettingsContextYes) {
    if (settingsState == RBSettingsContextNo &&
        (objc_getAssociatedObject(control, &RBOriginalSwitchTargets) != nil ||
         objc_getAssociatedObject(control, &RBHiddenPushEntryKey) != nil))
      RBResetPushView(view);
    return NO;
  }
  NSString *identity = RBPushStateKey();
  NSDictionary *state = [RBDevicePushStateIdentity isEqual:identity] ? RBDevicePushState :
    [NSUserDefaults.standardUserDefaults dictionaryForKey:identity];
  if (RBPushEnvironment()) {
    if (!objc_getAssociatedObject(control, &RBOriginalSwitchTargets)) {
      NSMapTable *targets = NSMapTable.weakToStrongObjectsMapTable;
      for (id target in control.allTargets) {
        NSArray *actions = [control actionsForTarget:target forControlEvent:UIControlEventValueChanged];
        if (actions.count) [targets setObject:actions forKey:target];
      }
      objc_setAssociatedObject(control, &RBOriginalSwitchTargets, targets, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      [control removeTarget:nil action:nil forControlEvents:UIControlEventValueChanged];
      [control addTarget:RBPushEntry.class action:@selector(changed:) forControlEvents:UIControlEventValueChanged];
      RBTrackModifiedView(view);
      RBTrackModifiedView(control);
    }
    if (state && control.enabled) {
      BOOL shouldBeOn = RBPushBoolValue(state[@"enabled"], NO) &&
          [authorizedStates containsObject:RBPushAsString(state[@"authorization"]) ?: @""];
      if (control.on != shouldBeOn) control.on = shouldBeOn;
    }
    return YES;
  }
  UIView *row = control.superview;
  while (row && row.bounds.size.width < 300) row = row.superview;
  if (!row || row.bounds.size.height < 40) return NO;
  // Fabric flattens all setting rows into one group. Derive this row from the
  // native switch's position, preserving Appearance/Language rows below it.
  CGRect switchRect = [control convertRect:control.bounds toView:row];
  CGFloat height = MAX(50, switchRect.size.height + 30);
  CGRect rowFrame = CGRectMake(0, MAX(0, CGRectGetMidY(switchRect) - height / 2), row.bounds.size.width, height);
  RBPushEntry *entry = (RBPushEntry *)[row viewWithTag:731990];
  if (!entry) {
    entry = [RBPushEntry buttonWithType:UIButtonTypeCustom];
    entry.tag = 731990; entry.originalSwitch = control;
    entry.frame = rowFrame;
    entry.autoresizingMask = UIViewAutoresizingFlexibleWidth;
    entry.stateLabel = [UILabel new]; entry.stateLabel.font = [UIFont systemFontOfSize:17];
    entry.stateLabel.textColor = UIColor.secondaryLabelColor; entry.stateLabel.textAlignment = NSTextAlignmentRight;
    entry.chevron = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"chevron.right"]];
    entry.chevron.tintColor = UIColor.tertiaryLabelColor;
    [entry addSubview:entry.stateLabel]; [entry addSubview:entry.chevron];
    [entry addTarget:entry action:@selector(open) forControlEvents:UIControlEventTouchUpInside];
    if (!row.userInteractionEnabled) row.userInteractionEnabled = YES;
    [row addSubview:entry];
  } else {
    if (entry.originalSwitch != control) {
      UISwitch *previous = entry.originalSwitch;
      if (previous) {
        RBAssociateHiddenPushEntry(previous, nil);
        if (previous.hidden) previous.hidden = NO;
      }
      entry.originalSwitch = control;
    }
    if (!CGRectEqualToRect(entry.frame, rowFrame)) entry.frame = rowFrame;
  }
  RBAssociateHiddenPushEntry(control, entry);
  RBTrackModifiedView(row);
  RBTrackModifiedView(view);
  RBTrackModifiedView(control);
  if (!control.hidden) control.hidden = YES;
  if (entry.layer.zPosition != 1000) entry.layer.zPosition = 1000;
  if (row.subviews.lastObject != entry) [row bringSubviewToFront:entry];
  BOOL configured = [RBPushAsString(state[@"provider"]) isEqualToString:@"bark"] &&
                    RBPushBoolValue(state[@"configured"], NO);
  NSString *stateText = configured ? RBL(@"Bark 已配置", @"Bark configured") : RBL(@"Bark 未配置", @"Bark not configured");
  if (![entry.stateLabel.text isEqualToString:stateText]) entry.stateLabel.text = stateText;
  CGRect labelFrame = CGRectMake(entry.bounds.size.width - 204, (entry.bounds.size.height - 22) / 2, 160, 22);
  if (!CGRectEqualToRect(entry.stateLabel.frame, labelFrame)) entry.stateLabel.frame = labelFrame;
  CGRect chevronFrame = CGRectMake(entry.bounds.size.width - 34, (entry.bounds.size.height - 16) / 2, 10, 16);
  if (!CGRectEqualToRect(entry.chevron.frame, chevronFrame)) entry.chevron.frame = chevronFrame;
  NSString *entryLabel = [RBL(@"通知，", @"Notifications, ") stringByAppendingString:stateText];
  if (![entry.accessibilityLabel isEqualToString:entryLabel]) entry.accessibilityLabel = entryLabel;
  return YES;
}
void RBPushRefresh(void) {
  if (!RBConnection.shared.deviceToken.length) return;
  RBInstallPushDelegate();
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    dispatch_async(dispatch_get_main_queue(), ^{
      RBReportDevice(s);
      if (RBPushEnvironment()) {
        if (s.authorizationStatus == UNAuthorizationStatusNotDetermined && !RBAuthorizing && !RBAuthorizationAttempted) {
          RBAuthorizing = YES; RBAuthorizationAttempted = YES;
          [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert|UNAuthorizationOptionSound|UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
              RBAuthorizing = NO;
              if (error) RBRegistrationError = [NSString stringWithFormat:@"%@ (%ld)",error.domain,(long)error.code];
              RBPushRefresh();
            });
          }];
        } else [UIApplication.sharedApplication registerForRemoteNotifications];
      } else if (![NSUserDefaults.standardUserDefaults boolForKey:RBPromptKey()]) {
        RBDeviceRequest(@"GET", nil, ^(NSDictionary *value, NSError *error) {
          if (error) return;
          NSDictionary *push = RBPushAsDict(RBPushAsDict(value)[@"push"]);
          if (RBPushBoolValue(push[@"configured"], NO))
            [NSUserDefaults.standardUserDefaults setBool:YES forKey:RBPromptKey()];
          else RBShowBark();
        });
      }
    });
  }];
}
