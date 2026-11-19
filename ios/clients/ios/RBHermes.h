#import <Foundation/Foundation.h>
@interface RBHermes : NSObject
+ (NSData *)gatewayData:(NSString *)url
                  token:(NSString *)token
              resources:(NSURL *)resources
                  error:(NSError **)error;
+ (NSURL *)writeGateway:(NSString *)url
                  token:(NSString *)token
              resources:(NSURL *)resources
                  error:(NSError **)error;
@end
