#import "RBDeepLinks.h"
#import "RBDiagnostics.h"
#import <objc/message.h>
#import <objc/runtime.h>

static IMP RBOriginalLinkURL;
static IMP RBOriginalInitialURL;
static IMP RBOriginalStartObserving;
static IMP RBOriginalStopObserving;
static BOOL RBObserving;
static BOOL RBHasBeenActive;
static NSURL *RBPendingNotificationURL;
static NSURL *RBInitialNotificationURL;

static void RBDeliverURL(NSURL *url) {
  RBDiagnosticsEvent(@"link.deliver", @{@"url":url.absoluteString ?: @""});
  Class linking = NSClassFromString(@"RCTLinkingManager");
  SEL selector = sel_registerName("application:openURL:options:");
  if ([linking respondsToSelector:selector]) {
    id application = ((id (*)(id, SEL))objc_msgSend)(
        NSClassFromString(@"UIApplication"), sel_registerName("sharedApplication"));
    ((BOOL (*)(id, SEL, id, id, id))objc_msgSend)(linking, selector, application, url, @{});
  }
}

NSURL *RBChatURL(NSString *agentId) {
  if (![agentId isKindOfClass:NSString.class] || !agentId.length || agentId.length > 128 ||
      [agentId rangeOfCharacterFromSet:
                   [[NSCharacterSet characterSetWithCharactersInString:
                       @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"]
                       invertedSet]].location != NSNotFound)
    return nil;
  // The original GrokBotLinks parser accepts app/v1/chat?id=, not chat/<id>.
  return [NSURL URLWithString:[@"grokbot://app/v1/chat?id=" stringByAppendingString:agentId]];
}

NSURL *RBNormalizeLocalURL(NSURL *url) {
  NSString *scheme = url.scheme.lowercaseString;
  if ([@[@"rblocal", @"gblocal", @"rblocal-ios", @"gblocal-ios"] containsObject:scheme]) {
    NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    components.scheme = ([@[@"rblocal", @"gblocal"] containsObject:scheme]) ? @"grokbot" : @"sand-mobile";
    return components.URL ?: url;
  }
  if (![@[@"rokbot-local", @"grokbot-local"] containsObject:scheme] ||
      ![@[@"agent", @"chat"] containsObject:url.host.lowercaseString] ||
      url.user || url.password || url.port || url.query || url.fragment)
    return url;
  NSArray<NSString *> *parts = url.pathComponents;
  if (parts.count != 2 || ![parts[0] isEqual:@"/"])
    return url;
  return RBChatURL(parts[1]) ?: url;
}

static BOOL RBLinkURL(id self, SEL cmd, id application, NSURL *url, NSDictionary *options) {
  return ((BOOL (*)(id, SEL, id, id, id))RBOriginalLinkURL)(
      self, cmd, application, RBNormalizeLocalURL(url), options);
}

static void RBInitialURL(id self, SEL cmd, void (^resolve)(id), id reject) {
  void (^normalized)(id) = ^(id value) {
    @synchronized (NSClassFromString(@"RCTLinkingManager")) {
      if (RBInitialNotificationURL) {
        // The app has multiple initial-URL consumers, including its chat router
        // after account initialization. Match launchOptions' stable URL semantics.
        value = RBInitialNotificationURL.absoluteString;
      } else if (RBPendingNotificationURL) {
        value = RBPendingNotificationURL.absoluteString;
        RBPendingNotificationURL = nil;
      }
    }
    if ([value isKindOfClass:NSString.class])
      value = RBNormalizeLocalURL([NSURL URLWithString:value]).absoluteString ?: value;
    RBDiagnosticsEvent(@"link.initial", @{@"url":[value isKindOfClass:NSString.class] ? value : @""});
    resolve(value);
  };
  ((void (*)(id, SEL, id, id))RBOriginalInitialURL)(self, cmd, normalized, reject);
}

static void RBStartObserving(id self, SEL cmd) {
  ((void (*)(id, SEL))RBOriginalStartObserving)(self, cmd);
  NSURL *pending;
  @synchronized (NSClassFromString(@"RCTLinkingManager")) {
    RBObserving = YES;
    pending = RBPendingNotificationURL;
    RBPendingNotificationURL = nil;
  }
  if (pending) RBDeliverURL(pending);
  RBDiagnosticsEvent(@"link.observing", @{@"pending":pending ? @YES : @NO});
}

static void RBStopObserving(id self, SEL cmd) {
  RBDiagnosticsEvent(@"link.stop", @{});
  @synchronized (NSClassFromString(@"RCTLinkingManager")) {
    RBObserving = NO;
    if (RBHasBeenActive) RBInitialNotificationURL = nil;
  }
  ((void (*)(id, SEL))RBOriginalStopObserving)(self, cmd);
}

void RBInstallDeepLinks(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // Use notification names so the routing unit is also testable with Foundation.
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserverForName:@"UIApplicationDidBecomeActiveNotification" object:nil queue:nil usingBlock:^(NSNotification *n) {
      @synchronized (NSClassFromString(@"RCTLinkingManager")) { RBHasBeenActive = YES; }
      RBDiagnosticsEvent(@"application.active", @{});
    }];
    [center addObserverForName:@"UIApplicationDidEnterBackgroundNotification" object:nil queue:nil usingBlock:^(NSNotification *n) {
      @synchronized (NSClassFromString(@"RCTLinkingManager")) { RBInitialNotificationURL = nil; }
      RBDiagnosticsEvent(@"application.background", @{});
    }];
  });
  Class linking = NSClassFromString(@"RCTLinkingManager");
  if (!RBOriginalLinkURL) {
    Method method = class_getClassMethod(linking, sel_registerName("application:openURL:options:"));
    if (method) RBOriginalLinkURL = method_setImplementation(method, (IMP)RBLinkURL);
  }
  if (!RBOriginalInitialURL) {
    Method method = class_getInstanceMethod(linking, sel_registerName("getInitialURL:reject:"));
    if (method) RBOriginalInitialURL = method_setImplementation(method, (IMP)RBInitialURL);
  }
  if (!RBOriginalStartObserving) {
    Method method = class_getInstanceMethod(linking, sel_registerName("startObserving"));
    if (method) RBOriginalStartObserving = method_setImplementation(method, (IMP)RBStartObserving);
  }
  if (!RBOriginalStopObserving) {
    Method method = class_getInstanceMethod(linking, sel_registerName("stopObserving"));
    if (method) RBOriginalStopObserving = method_setImplementation(method, (IMP)RBStopObserving);
  }
}

void RBOpenAgent(NSString *agentId) {
  NSURL *url = RBChatURL(agentId);
  if (!url) return;
  RBDiagnosticsEvent(@"notification.open", @{@"agentId":agentId, @"observing":RBObserving ? @YES : @NO, @"hasBeenActive":RBHasBeenActive ? @YES : @NO});
  @synchronized (NSClassFromString(@"RCTLinkingManager")) {
    if (!RBHasBeenActive) {
      RBInitialNotificationURL = url;
      if (!RBObserving) return;
    }
    if (!RBObserving) {
      RBPendingNotificationURL = url;
      return;
    }
  }
  RBDeliverURL(url);
}
