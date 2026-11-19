#import <Foundation/Foundation.h>
@interface RBNotifications : NSObject
+ (instancetype)shared;
- (void)start;
- (void)stop;
@end
