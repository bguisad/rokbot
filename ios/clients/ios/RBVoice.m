#import "RBVoice.h"
#import "RBVoiceAudio.h"
#import "RBVoiceCredential.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"

@interface RBVoiceProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(nonatomic,assign) BOOL cancelled;
@end
@implementation RBVoiceProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.HTTPMethod isEqual:@"POST"] &&
    [request.URL.path isEqual:@"/aiserver.v1.GrokBotService/MintSandVoiceCallSecret"];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)fail:(NSString *)message code:(NSInteger)code {
  [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"RokBotVoice" code:code
    userInfo:@{NSLocalizedDescriptionKey:message}]];
}
- (void)startLoading {
  RBConnection *connection = RBConnection.shared;
  NSString *serverURL = connection.serverURL, *token = connection.deviceToken;
  if (!serverURL.length || !token.length) {
    [self fail:RBL(@"请先连接 Host。", @"Connect to Host first.") code:401]; return;
  }
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *bytes = [NSMutableData data]; uint8_t buffer[4096]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (bytes.length + count > 16384) { [stream close]; [self fail:@"Invalid voice request" code:400]; return; }
      [bytes appendBytes:buffer length:count];
    }
    [stream close];
    if (count < 0) { [self fail:@"Invalid voice request" code:400]; return; }
    body = bytes;
  }
  id input = body.length <= 16384 && body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
  NSString *agentId = [input isKindOfClass:NSDictionary.class] ? input[@"agentId"] : nil;
  if (![agentId isKindOfClass:NSString.class] || !agentId.length || agentId.length > 256) {
    [self fail:RBL(@"请选择 Bot。", @"Choose a Bot.") code:400]; return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:
    [serverURL stringByAppendingString:@"/local/voice/session"]]];
  request.HTTPMethod = @"POST"; request.timeoutInterval = 30;
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Accept":@"application/json",
    @"Authorization":[@"Bearer " stringByAppendingString:token]};
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"agentId":agentId,
    @"audioProcessing":RBVoiceAudioAvailable() ? @"native-aec3-buffered-v1" : @"legacy"} options:0 error:nil];
  RBDiagnosticsEvent(@"voice.session.request", @{});
  self.task = [RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    if (http.statusCode >= 200 && http.statusCode < 300) {
      id credential = data.length && data.length <= 16384 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if (!RBVoiceCredentialIsValid(credential, serverURL)) {
        [self fail:RBL(@"无法连接语音服务。", @"Could not connect to the voice service.") code:502]; return;
      }
    }
    RBDiagnosticsEvent(@"voice.session.response", @{@"status":@(http.statusCode)});
    NSHTTPURLResponse *original = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:http.statusCode
      HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type":@"application/json"}];
    [self.client URLProtocol:self didReceiveResponse:original cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
Class RBVoiceProtocolClass(void) { return RBVoiceProtocol.class; }
