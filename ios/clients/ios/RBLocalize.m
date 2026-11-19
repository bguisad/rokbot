#import <UIKit/UIKit.h>
#import "RBLocalize.h"
static NSString *RBLocaleKey = @"RokBotLocal.interfaceLanguage";
BOOL RBIsChinese(void) {
  NSString *language = [NSUserDefaults.standardUserDefaults stringForKey:RBLocaleKey];
  if (!language.length) language = NSLocale.preferredLanguages.firstObject;
  return [language.lowercaseString hasPrefix:@"zh"];
}
NSString *RBL(NSString *chinese, NSString *english) { return RBIsChinese() ? chinese : english; }
void RBObserveAppLanguage(NSString *label) {
  // These labels are emitted by the original Lingui settings/account controls.
  // Observe their resolved language, so an in-app override wins over iOS locale.
  NSString *language = nil;
  if ([@[@"账户", @"调试", @"用量", @"语言", @"连接服务端"] containsObject:label]) language = @"zh";
  if ([@[@"Account", @"Debug", @"Usage", @"Language", @"Connect to Host"] containsObject:label]) language = @"en";
  if (language && ![language isEqual:[NSUserDefaults.standardUserDefaults stringForKey:RBLocaleKey]])
    [NSUserDefaults.standardUserDefaults setObject:language forKey:RBLocaleKey];
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
