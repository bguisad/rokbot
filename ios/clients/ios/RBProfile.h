#import <UIKit/UIKit.h>
void RBRefreshProfile(void);
void RBRestoreProfileCache(void);
void RBClearProfileCache(void);
void RBShowProfile(void);
NSString *RBProfileName(void);
NSString *RBProfileHostName(void);
UIImage *RBProfileAvatar(void);
BOOL RBReplaceProfileView(UIView *view);
void RBResetProfileView(UIView *view);
