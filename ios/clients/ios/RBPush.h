#import <UIKit/UIKit.h>
void RBPushRefresh(void);
void RBPushShowSettings(void);
NSString *RBPushEnvironment(void);
void RBReceiveLocalNotification(NSDictionary *notification);
BOOL RBReplacePushView(UIView *view);
void RBResetPushView(UIView *view);
void RBPushSetForeground(BOOL foreground);
