#import <Foundation/Foundation.h>
@class UIViewController;
BOOL RBIsChinese(void);
NSString *RBL(NSString *chinese, NSString *english);
void RBObserveAppLanguage(NSString *label);
UIViewController *RBTopController(void);
void RBPresentController(UIViewController *controller);
