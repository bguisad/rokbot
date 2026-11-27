#import "RBHostAPI.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBLocalize.h"

NSString *RBHostPathSegment(NSString *value) {
  NSMutableCharacterSet *allowed = [NSCharacterSet.alphanumericCharacterSet mutableCopy];
  [allowed addCharactersInString:@"-_.~"];
  return [value stringByAddingPercentEncodingWithAllowedCharacters:allowed] ?: @"";
}

NSString *RBHostErrorMessage(id json, NSError *error, NSInteger status) {
  if ([json isKindOfClass:NSDictionary.class]) {
    for (NSString *key in @[@"error", @"message"]) {
      id value = json[key];
      if ([value isKindOfClass:NSString.class] && [value length]) return value;
      if ([value isKindOfClass:NSDictionary.class] && [value[@"message"] isKindOfClass:NSString.class])
        return value[@"message"];
    }
  }
  if (error.localizedDescription.length) return error.localizedDescription;
  if (status == 401 || status == 403) return RBL(@"Host 拒绝了请求，请重新配对。", @"The Host rejected the request. Pair again.");
  if (status > 0) return [NSString stringWithFormat:RBL(@"Host 返回 %ld。", @"The Host returned %ld."), (long)status];
  return RBL(@"无法连接 Host。", @"Could not reach the Host.");
}

NSURLSessionDataTask *RBHostRequest(NSString *method, NSString *path, id body, NSTimeInterval timeout,
                                    RBHostCompletion completion) {
  NSString *base = RBConnection.shared.serverURL;
  NSString *token = RBConnection.shared.deviceToken;
  NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:path]] : nil;
  if (!url || !token.length) {
    if (completion)
      dispatch_async(dispatch_get_main_queue(), ^{
        completion(0, nil, [NSError errorWithDomain:@"RokBotHost" code:401 userInfo:@{
          NSLocalizedDescriptionKey : RBL(@"请先连接 Host。", @"Connect to Host first.")
        }]);
      });
    return nil;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = method;
  request.timeoutInterval = timeout;
  [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  [request setValue:@"1" forHTTPHeaderField:@"x-rokbot-foreground"];
  if (body) {
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  NSURLSessionDataTask *task = [RBHTTPSession()
      dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          id json = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                                 ? ((NSHTTPURLResponse *)response).statusCode : 0;
          if (completion) dispatch_async(dispatch_get_main_queue(), ^{ completion(status, json, error); });
        }];
  [task resume];
  return task;
}
