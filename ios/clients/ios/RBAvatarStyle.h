#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSNotificationName const RBAvatarStyleDidChangeNotification;

NSString *RBAvatarCurrentStyle(void);
void RBSetAvatarStyle(NSString *styleId);

/// Inspects an RNSVGSvgView node and installs/updates a custom RokBot dynamic avatar overlay on its
/// superview when it matches an official pele GrokBotMark fluid orb; restores official when disabled.
void RBUpdateAvatarView(UIView *svgView);

/// Resets any RokBot avatar overlay/alpha override attached to a recycled superview.
void RBResetAvatarSuperview(UIView *superview);

/// Opens the native Bot avatar style picker from a presenter (Connection settings).
void RBShowAvatarStyleFrom(UIViewController *presenter);

NS_ASSUME_NONNULL_END
