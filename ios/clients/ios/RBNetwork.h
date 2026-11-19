#import <Foundation/Foundation.h>
FOUNDATION_EXPORT NSString *RBNetworkAddress(void);
FOUNDATION_EXPORT BOOL RBNetworkEnabled(void);
FOUNDATION_EXPORT NSString *RBNetworkRestore(NSString *fallback);
FOUNDATION_EXPORT NSString *RBNetworkPrepare(NSString *address, BOOL enabled, NSError **error);
FOUNDATION_EXPORT BOOL RBNetworkCommit(void);
FOUNDATION_EXPORT void RBNetworkRollback(void);
FOUNDATION_EXPORT void RBNetworkClear(void);
FOUNDATION_EXPORT NSDictionary *RBNetworkStatus(void);
FOUNDATION_EXPORT BOOL RBNetworkEnsureReadyForURL(NSURL *url);
