#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^RBHostCompletion)(NSInteger status, id _Nullable json, NSError *_Nullable error);

// Authenticated JSON request against the paired Host (device Bearer token).
// The completion always runs on the main queue. Returns nil when not paired.
FOUNDATION_EXPORT NSURLSessionDataTask *_Nullable RBHostRequest(NSString *method,
                                                                NSString *path,
                                                                id _Nullable body,
                                                                NSTimeInterval timeout,
                                                                RBHostCompletion _Nullable completion);
// Extracts a user-facing message from a Host error body ({error|message}) or NSError.
FOUNDATION_EXPORT NSString *RBHostErrorMessage(id _Nullable json, NSError *_Nullable error, NSInteger status);
// Percent-encodes a single path segment (phrase IDs).
FOUNDATION_EXPORT NSString *RBHostPathSegment(NSString *value);

NS_ASSUME_NONNULL_END
