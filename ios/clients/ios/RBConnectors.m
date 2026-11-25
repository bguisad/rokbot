#import "RBConnectors.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBPrivacy.h"
#import "RBSpeech.h"
#import "RBVoice.h"
#import "RBAppIntents.h"
#import "RBSharing.h"
#import "RBDiagnostics.h"
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
    @"ListPublicGrokBotMarketplaceListings",
    @"ListUserCanvases", @"GetCanvasMetadata", @"GetCanvasPayload",
    @"SetCanvasVisibility", @"SetPageAddress", @"GetCanvasShareAccess",
    @"UpdateCanvasShareAccess", @"RefreshCanvasSources"
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
// Self-hosted Hosts do not have Cursor enterprise team policies or cloud
// Background Composer preferences. In iOS 1.26+, Auto-review checks both RPCs
// via PrReviewPreferencesService to see whether a team admin enforces it;
// failing them locks the toggle with "Couldn't check your team's settings."
// Mirror Desktop's empty local response (`{}`) when paired to a local Host.
static NSData *RBLocalPreferenceResponse(NSURLRequest *request) {
  if (![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *path = request.URL.path;
  if ([path isEqual:@"/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam"] ||
      [path isEqual:@"/aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings"]) {
    static NSData *emptyJson;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ emptyJson = [@"{}" dataUsingEncoding:NSUTF8StringEncoding]; });
    return emptyJson;
  }
  return nil;
}
@interface RBConnectorProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(atomic,assign) BOOL cancelled;
@end
@implementation RBConnectorProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return RBConnection.shared.deviceToken.length &&
    (RBConnectorMethod(request) != nil || RBLocalPreferenceResponse(request) != nil);
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  NSData *localBody = RBLocalPreferenceResponse(self.request);
  if (localBody) {
    RBDiagnosticsEvent(@"local-rpc.handled", @{@"path": self.request.URL.path ?: @""});
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL
      statusCode:200 HTTPVersion:@"HTTP/1.1"
      headerFields:@{@"Content-Type": @"application/json",
                     @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)localBody.length]}];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [self.client URLProtocol:self didLoadData:localBody];
    [self.client URLProtocolDidFinishLoading:self];
    return;
  }
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
  NSString *serverURL = RBConnection.shared.serverURL;
  NSString *deviceToken = RBConnection.shared.deviceToken;
  NSString *method = RBConnectorMethod(self.request);
  if (!serverURL.length || !deviceToken.length || !method.length) {
    [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"RokBotConnectors" code:401 userInfo:nil]];
    return;
  }
  NSString *path = [@"/local/mobile-rpc/" stringByAppendingString:method];
  NSURL *targetURL = [NSURL URLWithString:[serverURL stringByAppendingString:path]];
  if (!targetURL) {
    [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"RokBotConnectors" code:400 userInfo:nil]];
    return;
  }
  NSMutableURLRequest *request = [self.request mutableCopy];
  request.URL = targetURL;
  request.HTTPBody = body ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
  request.allHTTPHeaderFields = @{ @"Content-Type": @"application/json", @"Accept": @"application/json",
    @"Authorization": [@"Bearer " stringByAppendingString:deviceToken] };
  request.timeoutInterval = 30;
  self.task = [RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]];
      return;
    }
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
static IMP RBDefaultConfig, RBEphemeralConfig, RBSessionWithConfig, RBSessionWithConfigDelegate;
static NSURLSessionConfiguration *RBAddProtocol(NSURLSessionConfiguration *config) {
  if (!config || config.identifier.length > 0) return config;
  NSMutableArray *classes = [config.protocolClasses mutableCopy] ?: [NSMutableArray new];
  if (![classes containsObject:RBConnectorProtocol.class]) [classes insertObject:RBConnectorProtocol.class atIndex:0];
  if (![classes containsObject:RBPrivacyProtocolClass()]) [classes insertObject:RBPrivacyProtocolClass() atIndex:0];
  if (![classes containsObject:RBSpeechProtocolClass()]) [classes insertObject:RBSpeechProtocolClass() atIndex:0];
  if (![classes containsObject:RBVoiceProtocolClass()]) [classes insertObject:RBVoiceProtocolClass() atIndex:0];
  if (![classes containsObject:RBAppIntentsProtocolClass()]) [classes insertObject:RBAppIntentsProtocolClass() atIndex:0];
  if (![classes containsObject:RBSharingProtocolClass()]) [classes insertObject:RBSharingProtocolClass() atIndex:0];
  config.protocolClasses = classes; return config;
}
static id RBDefault(id self, SEL selector) { return RBAddProtocol(((id(*)(id,SEL))RBDefaultConfig)(self,selector)); }
static id RBEphemeral(id self, SEL selector) { return RBAddProtocol(((id(*)(id,SEL))RBEphemeralConfig)(self,selector)); }
// Swizzle NSURLSession factory methods instead of replacing RN's process-wide
// RCTSetCustomNSURLSessionConfigurationProvider, so any custom configuration
// provider installed by the app keeps its headers, caching, and protocols while
// our local NSURLProtocols stay prepended on a copy of the configuration.
// Background session configurations (non-empty identifier) run out-of-process and
// do not support custom NSURLProtocol subclasses, so pass them through untouched.
static id RBSession(id self, SEL selector, NSURLSessionConfiguration *config) {
  NSURLSessionConfiguration *patched = (config && config.identifier.length == 0) ? RBAddProtocol([config copy]) : config;
  return ((id(*)(id,SEL,id))RBSessionWithConfig)(self, selector, patched);
}
static id RBSessionDelegate(id self, SEL selector, NSURLSessionConfiguration *config, id delegate, NSOperationQueue *queue) {
  NSURLSessionConfiguration *patched = (config && config.identifier.length == 0) ? RBAddProtocol([config copy]) : config;
  return ((id(*)(id,SEL,id,id,id))RBSessionWithConfigDelegate)(self, selector, patched, delegate, queue);
}
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
    Method c=class_getClassMethod(NSURLSession.class,@selector(sessionWithConfiguration:));
    Method d=class_getClassMethod(NSURLSession.class,@selector(sessionWithConfiguration:delegate:delegateQueue:));
    RBDefaultConfig=method_setImplementation(a,(IMP)RBDefault);
    RBEphemeralConfig=method_setImplementation(b,(IMP)RBEphemeral);
    if (c) RBSessionWithConfig=method_setImplementation(c,(IMP)RBSession);
    if (d) RBSessionWithConfigDelegate=method_setImplementation(d,(IMP)RBSessionDelegate);
  });
}
