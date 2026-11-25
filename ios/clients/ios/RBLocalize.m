#import <UIKit/UIKit.h>
#import "RBLocalize.h"
static NSString *const RBLocaleKey = @"RokBotLocal.interfaceLanguage";
static NSString *RBCachedLanguage;
static BOOL RBLanguageLoaded;
static BOOL RBCachedIsChinese;
static BOOL RBComputeIsChinese(NSString *language) {
  if (!language.length) language = NSLocale.preferredLanguages.firstObject;
  return [language.lowercaseString hasPrefix:@"zh"];
}
static void RBEnsureLanguageLoadedLocked(void) {
  if (RBLanguageLoaded) return;
  RBCachedLanguage = [NSUserDefaults.standardUserDefaults stringForKey:RBLocaleKey];
  RBCachedIsChinese = RBComputeIsChinese(RBCachedLanguage);
  RBLanguageLoaded = YES;
}
BOOL RBIsChinese(void) {
  @synchronized (RBLocaleKey) {
    RBEnsureLanguageLoadedLocked();
    return RBCachedIsChinese;
  }
}
NSString *RBL(NSString *chinese, NSString *english) { return RBIsChinese() ? chinese : english; }
void RBObserveAppLanguage(NSString *label) {
  if (!label.length || label.length > 32) return;
  static NSSet<NSString *> *zhLabels;
  static NSSet<NSString *> *enLabels;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    zhLabels = [NSSet setWithArray:@[
      @"账户", @"调试", @"用量", @"语言", @"连接服务端", @"退出登录", @"登出",
      @"通过 Apple 登录", @"透過 Apple 登入", @"用邮箱继续"
    ]];
    enLabels = [NSSet setWithArray:@[
      @"Account", @"Debug", @"Usage", @"Language", @"Connect to Host",
      @"Sign out", @"Sign in with Apple", @"Continue with email"
    ]];
  });
  // These labels are emitted by the original Lingui settings/account controls.
  // Observe their resolved language, so an in-app override wins over iOS locale.
  NSString *language = nil;
  if ([zhLabels containsObject:label]) language = @"zh";
  else if ([enLabels containsObject:label]) language = @"en";
  if (!language) return;
  BOOL changed = NO;
  @synchronized (RBLocaleKey) {
    RBEnsureLanguageLoadedLocked();
    if (![language isEqualToString:RBCachedLanguage]) {
      RBCachedLanguage = language;
      RBCachedIsChinese = [language isEqualToString:@"zh"];
      changed = YES;
    }
  }
  if (changed) [NSUserDefaults.standardUserDefaults setObject:language forKey:RBLocaleKey];
}
UIViewController *RBTopController(void) {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow) top = window.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}
void RBPresentController(UIViewController *controller) {
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:controller];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  if (@available(iOS 15.0, *)) {
    nav.sheetPresentationController.detents = @[UISheetPresentationControllerDetent.largeDetent];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
  }
  [RBTopController() presentViewController:nav animated:YES completion:nil];
}
