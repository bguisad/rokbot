#import <UIKit/UIKit.h>
@interface RBConnection : NSObject
+ (instancetype)shared;
@property(nonatomic, readonly) NSString *serverURL;
@property(nonatomic, readonly) NSString *deviceToken;
@property(nonatomic, readonly, getter=isPaired) BOOL paired;
@property(nonatomic, readonly) NSURL *gatewayBundleURL;
@property(nonatomic, strong) NSURL *resourcesURL;
@property(nonatomic, copy) void (^didConnect)(void);
@property(nonatomic, copy) void (^didDisconnect)(void);
- (BOOL)restore:(NSError **)error;
- (void)show;
- (void)disconnect;
@end
FOUNDATION_EXPORT void RBReloadReactHost(void);
// Present the RokBot pairing page full-screen while no Host is paired.
// Returns NO when no window is ready yet so callers can retry.
FOUNDATION_EXPORT BOOL RBShowRequiredPairing(void);
FOUNDATION_EXPORT void RBOpenAgent(NSString *agentId);
FOUNDATION_EXPORT void RBTrackModifiedView(UIView *view);
FOUNDATION_EXPORT BOOL RBHasAncestorPluginTag(UIView *view, NSInteger tag);
FOUNDATION_EXPORT void RBRemoveDescendantPluginTag(UIView *view, NSInteger tag);
typedef NS_ENUM(NSInteger, RBSettingsContextState) {
  RBSettingsContextUnknown = 0,
  RBSettingsContextNo = 1,
  RBSettingsContextYes = 2,
};
FOUNDATION_EXPORT RBSettingsContextState RBGlobalSettingsContextState(UIView *view);
FOUNDATION_EXPORT BOOL RBIsGlobalSettingsContext(UIView *view);
