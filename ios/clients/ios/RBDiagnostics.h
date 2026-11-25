#import <Foundation/Foundation.h>
FOUNDATION_EXPORT BOOL RBDiagnosticsEnabled(void);
FOUNDATION_EXPORT void RBDiagnosticsRecordBundle(NSURL *requested, NSURL *loaded);
FOUNDATION_EXPORT void RBDiagnosticsEvent(NSString *event, NSDictionary *values);
FOUNDATION_EXPORT void RBDiagnosticsObserveTask(NSURLSessionTask *task);
