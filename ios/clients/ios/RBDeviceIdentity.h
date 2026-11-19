#import <Foundation/Foundation.h>

FOUNDATION_EXPORT BOOL RBIsValidClientDeviceId(NSString *candidate);
FOUNDATION_EXPORT NSString *RBClientDeviceIdForBundleIdentifier(NSString *bundleId,
                                                                NSUserDefaults *defaults);
FOUNDATION_EXPORT NSString *RBClientDeviceId(void);
