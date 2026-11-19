#import "RBConnectors.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBPrivacy.h"
#import "RBSpeech.h"
#import "RBVoice.h"
#import "RBAppIntents.h"
#import "RBSharing.h"
#import <objc/runtime.h>

static NSSet *RBConnectorMethods(void) {
  static NSSet *methods; static dispatch_once_t once;
  dispatch_once(&once, ^{ methods = [NSSet setWithArray:@[
    @"ListMarketplacePlugins", @"ListPrivateMarketplacePlugins", @"ListMarketplaces", @"GetEffectiveUserPlugins",
    @"GetAvailableMcpServers", @"ListSandMcpTools", @"ValidateMcpOAuthTokens",
    @"InstallUserPlugin", @"UninstallUserPlugin", @"UpdateUserPlugin", @"UpdateUserPluginVariables",
    @"UpdateUserPluginInstall",
    @"RenameMcpOAuthAccount", @"DeleteMcpOAuthAccount", @"CheckHttpMcpStatus",
    @"CompleteMcpOAuth", @"GetPluginDetails", @"GetTeamPluginPopularity",
    @"GetGrokBotMcpToolPermissions", @"SetGrokBotMcpToolPermissions",
    @"ListPublicGrokBotMarketplaceListings"
  ]]; }); return methods;
}
static NSString *RBConnectorMethod(NSURLRequest *request) {
  if (![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *path = request.URL.path;
  for (NSString *prefix in @[@"/aiserver.v1.DashboardService/", @"/aiserver.v1.GrokBotService/"]) {
    NSRange service = [path rangeOfString:prefix];
    if (service.location != NSNotFound) {
      NSString *method = [path substringFromIndex:NSMaxRange(service)];
      return [RBConnectorMethods() containsObject:method] ? method : nil;
    }
  }
  return nil;
}
@interface RBConnectorProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(nonatomic,assign) BOOL cancelled;
@end
@implementation RBConnectorProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return RBConnection.shared.deviceToken.length && RBConnectorMethod(request) != nil;
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *collected = [NSMutableData new];
    uint8_t buffer[8192]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (collected.length + (NSUInteger)count > 1024 * 1024) {
        [stream close];
        [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"RokBotConnectors" code:413 userInfo:@{NSLocalizedDescriptionKey: @"Request body is too large."}]];
        return;
      }
      [collected appendBytes:buffer length:(NSUInteger)count];
    }
    [stream close];
    if (count < 0) {
      [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"RokBotConnectors" code:400 userInfo:@{NSLocalizedDescriptionKey: @"Could not read request body."}]];
      return;
    }
    body = collected;
  }
  NSString *method = RBConnectorMethod(self.request);
  NSString *path = [@"/local/mobile-rpc/" stringByAppendingString:method];
  NSMutableURLRequest *request = [self.request mutableCopy];
  request.URL = [NSURL URLWithString:[RBConnection.shared.serverURL stringByAppendingString:path]];
  request.HTTPBody = body ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
  request.allHTTPHeaderFields = @{ @"Content-Type": @"application/json", @"Accept": @"application/json",
    @"Authorization": [@"Bearer " stringByAppendingString:RBConnection.shared.deviceToken] };
  request.timeoutInterval = 30;
  self.task = [RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    NSHTTPURLResponse *originalURLResponse = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:http.statusCode HTTPVersion:@"HTTP/1.1" headerFields:http.allHeaderFields];
    [self.client URLProtocol:self didReceiveResponse:originalURLResponse cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
static IMP RBDefaultConfig, RBEphemeralConfig;
static NSURLSessionConfiguration *RBAddProtocol(NSURLSessionConfiguration *config) {
  NSMutableArray *classes = [config.protocolClasses mutableCopy] ?: [NSMutableArray new];
  if (![classes containsObject:RBConnectorProtocol.class]) [classes insertObject:RBConnectorProtocol.class atIndex:0];
  if (![classes containsObject:RBPrivacyProtocolClass()]) [classes insertObject:RBPrivacyProtocolClass() atIndex:0];
  if (![classes containsObject:RBSpeechProtocolClass()]) [classes insertObject:RBSpeechProtocolClass() atIndex:0];
  if (![classes containsObject:RBVoiceProtocolClass()]) [classes insertObject:RBVoiceProtocolClass() atIndex:0];
  if (![classes containsObject:RBAppIntentsProtocolClass()]) [classes insertObject:RBAppIntentsProtocolClass() atIndex:0];
  if (![classes containsObject:RBSharingProtocolClass()]) [classes insertObject:RBSharingProtocolClass() atIndex:0];
  config.protocolClasses = classes; return config;
}
static id RBDefault(id self,SEL selector) { return RBAddProtocol(((id(*)(id,SEL))RBDefaultConfig)(self,selector)); }
static id RBEphemeral(id self,SEL selector) { return RBAddProtocol(((id(*)(id,SEL))RBEphemeralConfig)(self,selector)); }
void RBInstallConnectorTransport(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [NSURLProtocol registerClass:RBConnectorProtocol.class];
    [NSURLProtocol registerClass:RBPrivacyProtocolClass()];
    [NSURLProtocol registerClass:RBSpeechProtocolClass()];
    [NSURLProtocol registerClass:RBVoiceProtocolClass()];
    [NSURLProtocol registerClass:RBAppIntentsProtocolClass()];
    [NSURLProtocol registerClass:RBSharingProtocolClass()];
    Method a=class_getClassMethod(NSURLSessionConfiguration.class,@selector(defaultSessionConfiguration));
    Method b=class_getClassMethod(NSURLSessionConfiguration.class,@selector(ephemeralSessionConfiguration));
    RBDefaultConfig=method_setImplementation(a,(IMP)RBDefault);
    RBEphemeralConfig=method_setImplementation(b,(IMP)RBEphemeral);
  });
}
