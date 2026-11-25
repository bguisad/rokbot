#import "RBAppIntents.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"
#import <Security/Security.h>

static NSString *RBAppIntentDefaultAccessGroup(void) {
  NSString *identifier = NSBundle.mainBundle.bundleIdentifier;
  NSString *prefix = [NSBundle.mainBundle objectForInfoDictionaryKey:@"AppIdentifierPrefix"];
  NSArray *groups = [NSBundle.mainBundle objectForInfoDictionaryKey:@"SandKeychainAccessGroups"];
  NSString *shared = [groups isKindOfClass:NSArray.class] ? groups.firstObject : nil;
  if (!prefix.length) prefix = [shared componentsSeparatedByString:@"."].firstObject;
  if (prefix.length && identifier.length)
    return [prefix stringByAppendingFormat:@".%@", identifier];
  return nil;
}

static NSString *RBAppIntentSharedAccessGroup(void) {
  NSArray *groups = [NSBundle.mainBundle objectForInfoDictionaryKey:@"SandKeychainAccessGroups"];
  NSString *identifier = NSBundle.mainBundle.bundleIdentifier.lowercaseString;
  NSString *suffix = [@"." stringByAppendingFormat:@"%@.shared", identifier];
  for (NSString *group in [groups isKindOfClass:NSArray.class] ? groups : @[]) {
    if ([group.lowercaseString hasSuffix:suffix]) return group;
  }
  return nil;
}

static OSStatus RBWriteAppIntentCredential(
    NSString *service, NSString *account, NSString *group, NSData *data) {
  if (!data.length) return errSecParam;
  NSMutableDictionary *query = [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: service,
    (__bridge id)kSecAttrAccount: account
  } mutableCopy];
  if (group.length) query[(__bridge id)kSecAttrAccessGroup] = group;
  NSMutableDictionary *attributes = [@{
    (__bridge id)kSecValueData: data,
    (__bridge id)kSecAttrGeneric: [account dataUsingEncoding:NSUTF8StringEncoding],
    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  } mutableCopy];
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query,
                                  (__bridge CFDictionaryRef)attributes);
  if (status == errSecItemNotFound) {
    NSMutableDictionary *item = query;
    [item addEntriesFromDictionary:attributes];
    status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  }
  return status;
}

static OSStatus RBReadAppIntentCredential(
    NSString *service, NSString *account, NSString *group, NSUInteger *length) {
  NSMutableDictionary *query = [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: service,
    (__bridge id)kSecAttrAccount: account,
    (__bridge id)kSecReturnData: @YES,
    (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne
  } mutableCopy];
  if (group.length) query[(__bridge id)kSecAttrAccessGroup] = group;
  CFTypeRef value = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &value);
  if (status == errSecSuccess && value) {
    *length = [(__bridge NSData *)value length];
    CFRelease(value);
  } else {
    *length = 0;
  }
  return status;
}

static void RBDeleteAppIntentCredential(
    NSString *service, NSString *account, NSString *group) {
  NSMutableDictionary *query = [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: service,
    (__bridge id)kSecAttrAccount: account
  } mutableCopy];
  if (group.length) query[(__bridge id)kSecAttrAccessGroup] = group;
  SecItemDelete((__bridge CFDictionaryRef)query);
}

static NSString *const RBSyncLock = @"RokBot.AppIntentsSync";
static BOOL RBHasSyncedCredentials;
static BOOL RBLastSyncedPaired;
static NSString *RBLastSyncedServerURL;

// The original Swift App Intents and the React Native TokenStore use different
// SecureStore services. Keep both copies aligned with the local Host session;
// the transport owns the real device authentication.
void RBSyncAppIntentCredentials(void) {
  RBConnection *connection = RBConnection.shared;
  NSString *serverURL = connection.serverURL;
  NSString *deviceToken = connection.deviceToken;
  BOOL paired = serverURL.length > 0 && deviceToken.length > 0;
  @synchronized (RBSyncLock) {
    if (RBHasSyncedCredentials && RBLastSyncedPaired == paired &&
        (!paired || [RBLastSyncedServerURL isEqualToString:serverURL])) {
      return;
    }
    NSString *defaultGroup = RBAppIntentDefaultAccessGroup();
    NSString *sharedGroup = RBAppIntentSharedAccessGroup();
    if (!paired) {
      RBDeleteAppIntentCredential(@"x.money.agent-connection-code:no-auth",
                                  @"grok-bot", defaultGroup);
      RBDeleteAppIntentCredential(@"x.money.agent-connection-code:no-auth",
                                  @"grok-bot", sharedGroup);
      RBDeleteAppIntentCredential(@"x.money.agent-connection-code:no-auth",
                                  @"grok-bot", nil);
      RBDeleteAppIntentCredential(@"app:no-auth",
                                  @"sand.cursor-tokens", defaultGroup);
      RBDeleteAppIntentCredential(@"app:no-auth",
                                  @"sand.cursor-tokens", sharedGroup);
      RBDeleteAppIntentCredential(@"app:no-auth",
                                  @"sand.cursor-tokens", nil);
      RBHasSyncedCredentials = YES;
      RBLastSyncedPaired = NO;
      RBLastSyncedServerURL = nil;
      return;
    }
    NSString *(^base64url)(NSDictionary *) = ^NSString *(NSDictionary *value) {
      NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
      NSString *encoded = [json base64EncodedStringWithOptions:0] ?: @"";
      return [[[encoded stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
        stringByReplacingOccurrencesOfString:@"/" withString:@"_"] stringByReplacingOccurrencesOfString:@"=" withString:@""];
    };
    NSDictionary *claims = @{
      @"sub": @"rokbot-local",
      @"email": @"local@workspace.invalid",
      @"type": @"sand_mobile",
      @"iat": @0,
      @"exp": @4070908800LL
    };
    NSString *marker = [NSString stringWithFormat:@"%@.%@.local",
      base64url(@{@"alg":@"none",@"typ":@"JWT"}), base64url(claims)];
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{
      @"accessToken": marker,
      @"refreshToken": marker,
      @"backendUrl": serverURL
    } options:0 error:nil];
    if (!data.length) return;
    OSStatus tokenStoreStatus = RBWriteAppIntentCredential(
        @"app:no-auth", @"sand.cursor-tokens", defaultGroup, data);
    OSStatus appIntentStatus = RBWriteAppIntentCredential(
        @"x.money.agent-connection-code:no-auth", @"grok-bot", sharedGroup, data);
    if (tokenStoreStatus == errSecSuccess && appIntentStatus == errSecSuccess) {
      RBHasSyncedCredentials = YES;
      RBLastSyncedPaired = YES;
      RBLastSyncedServerURL = [serverURL copy];
    }
    if (RBDiagnosticsEnabled()) {
      NSUInteger tokenStoreLength = 0;
      NSUInteger appIntentLength = 0;
      NSUInteger ungroupedTokenStoreLength = 0;
      NSUInteger sharedTokenStoreLength = 0;
      OSStatus tokenStoreReadStatus = RBReadAppIntentCredential(
          @"app:no-auth", @"sand.cursor-tokens", defaultGroup, &tokenStoreLength);
      OSStatus appIntentReadStatus = RBReadAppIntentCredential(
          @"x.money.agent-connection-code:no-auth", @"grok-bot",
          sharedGroup, &appIntentLength);
      OSStatus ungroupedTokenStoreReadStatus = RBReadAppIntentCredential(
          @"app:no-auth", @"sand.cursor-tokens", nil, &ungroupedTokenStoreLength);
      OSStatus sharedTokenStoreReadStatus = RBReadAppIntentCredential(
          @"app:no-auth", @"sand.cursor-tokens", sharedGroup, &sharedTokenStoreLength);
      RBDiagnosticsEvent(@"app-intents.credentials", @{
        @"tokenStoreStatus": @(tokenStoreStatus),
        @"appIntentStatus": @(appIntentStatus),
        @"tokenStoreReadStatus": @(tokenStoreReadStatus),
        @"appIntentReadStatus": @(appIntentReadStatus),
        @"tokenStoreLength": @(tokenStoreLength),
        @"appIntentLength": @(appIntentLength),
        @"ungroupedTokenStoreReadStatus": @(ungroupedTokenStoreReadStatus),
        @"ungroupedTokenStoreLength": @(ungroupedTokenStoreLength),
        @"sharedTokenStoreReadStatus": @(sharedTokenStoreReadStatus),
        @"sharedTokenStoreLength": @(sharedTokenStoreLength)
      });
    }
  }
}

void RBVerifyAppIntentCredentials(void) {
  RBConnection *connection = RBConnection.shared;
  NSString *serverURL = connection.serverURL;
  NSString *deviceToken = connection.deviceToken;
  BOOL paired = serverURL.length > 0 && deviceToken.length > 0;
  @synchronized (RBSyncLock) {
    if (paired && RBHasSyncedCredentials && RBLastSyncedPaired &&
        [RBLastSyncedServerURL isEqualToString:serverURL]) {
      NSString *defaultGroup = RBAppIntentDefaultAccessGroup();
      NSString *sharedGroup = RBAppIntentSharedAccessGroup();
      NSUInteger tokenLen = 0, intentLen = 0;
      OSStatus tokenRead = RBReadAppIntentCredential(
          @"app:no-auth", @"sand.cursor-tokens", defaultGroup, &tokenLen);
      OSStatus intentRead = RBReadAppIntentCredential(
          @"x.money.agent-connection-code:no-auth", @"grok-bot", sharedGroup, &intentLen);
      if (tokenRead != errSecSuccess || tokenLen == 0 ||
          intentRead != errSecSuccess || intentLen == 0) {
        RBHasSyncedCredentials = NO;
      }
    }
    RBSyncAppIntentCredentials();
  }
}

static NSString *RBIntentMethod(NSURLRequest *request) {
  if (![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *prefix = @"/aiserver.v1.GrokBotService/";
  if (![request.URL.path hasPrefix:prefix]) return nil;
  static NSSet<NSString *> *methods;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    methods = [NSSet setWithArray:@[@"ListGrokBotAgents", @"SendGrokBotUserMessage", @"GetGrokBotSendStatus"]];
  });
  NSString *method = [request.URL.path substringFromIndex:prefix.length];
  return [methods containsObject:method] ? method : nil;
}

@interface RBAppIntentsProtocol : NSURLProtocol
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(atomic, assign) BOOL cancelled;
@end

@implementation RBAppIntentsProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return RBIntentMethod(request) != nil; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)fail:(NSString *)message code:(NSInteger)code {
  [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"RokBotAppIntents"
    code:code userInfo:@{NSLocalizedDescriptionKey:message}]];
}
- (void)startLoading {
  RBConnection *connection = RBConnection.shared;
  NSString *serverURL = connection.serverURL;
  NSString *deviceToken = connection.deviceToken;
  if (!serverURL.length || !deviceToken.length) {
    [self fail:RBL(@"请先连接 Host。", @"Connect to Host first.") code:401];
    return;
  }
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *collected = [NSMutableData new];
    uint8_t buffer[8192]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (collected.length + count > 1024 * 1024) {
        [stream close]; [self fail:RBL(@"消息过长。", @"Message is too long.") code:413]; return;
      }
      [collected appendBytes:buffer length:count];
    }
    [stream close];
    if (count < 0) { [self fail:RBL(@"无法读取消息。", @"Could not read the message.") code:400]; return; }
    body = collected;
  }
  NSString *method = RBIntentMethod(self.request);
  NSURL *targetURL = method.length ? [NSURL URLWithString:
    [serverURL stringByAppendingFormat:@"/local/app-intents/%@", method]] : nil;
  if (!targetURL) {
    [self fail:RBL(@"无法连接 Host。", @"Could not connect to Host.") code:400];
    return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:targetURL];
  request.HTTPMethod = @"POST";
  request.HTTPBody = body ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Accept":@"application/json",
    @"Authorization":[@"Bearer " stringByAppendingString:deviceToken]};
  request.timeoutInterval = 30;
  if (RBDiagnosticsEnabled()) RBDiagnosticsEvent(@"app-intents.request", @{@"method":method});
  self.task = [RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    if (![response isKindOfClass:NSHTTPURLResponse.class]) {
      [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorBadServerResponse userInfo:nil]];
      return;
    }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    if (RBDiagnosticsEnabled()) RBDiagnosticsEvent(@"app-intents.response", @{@"method":method, @"status":@(http.statusCode)});
    NSHTTPURLResponse *original = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL
      statusCode:http.statusCode HTTPVersion:@"HTTP/1.1" headerFields:http.allHeaderFields];
    [self.client URLProtocol:self didReceiveResponse:original cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end

Class RBAppIntentsProtocolClass(void) { return RBAppIntentsProtocol.class; }
