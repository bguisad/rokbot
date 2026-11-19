#import "RBHTTP.h"
@interface RBNoRedirect : NSObject <NSURLSessionTaskDelegate>
@end
@implementation RBNoRedirect
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
@end
NSURLSession *RBHTTPSession(void) {
  static NSURLSession *session;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
    config.HTTPShouldSetCookies = NO;
    session = [NSURLSession sessionWithConfiguration:config
                                            delegate:[RBNoRedirect new]
                                       delegateQueue:nil];
  });
  return session;
}
