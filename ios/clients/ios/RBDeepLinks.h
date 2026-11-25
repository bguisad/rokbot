#import <Foundation/Foundation.h>

FOUNDATION_EXPORT NSURL *RBChatURL(NSString *agentId);
FOUNDATION_EXPORT NSURL *RBNormalizeLocalURL(NSURL *url);
FOUNDATION_EXPORT BOOL RBShouldBlockExternalURL(NSURL *url);
FOUNDATION_EXPORT void RBInstallDeepLinks(void);
