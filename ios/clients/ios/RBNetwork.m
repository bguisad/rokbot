#import "RBNetwork.h"
#import "RBLocalize.h"
#import "RBDiagnostics.h"
#import <Security/Security.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>

extern char *RBTailcatIdentity(void);
extern char *RBTailcatStart(const char *config);
extern char *RBTailcatStatus(int handle);
extern void RBTailcatStop(int handle);
extern void RBTailcatFree(char *text);

static int RBActiveTunnel, RBPendingTunnel, RBReservedSocket = -1;
static uint16_t RBActivePort, RBPendingPort;
static CFAbsoluteTime RBLastAttempt;
static CFAbsoluteTime RBPeerUnhealthySince;
static const CFTimeInterval RBPeerRecoveryGrace = 20;
static const CFTimeInterval RBPeerInitialGrace = 45;
static BOOL RBPeerWasReady;
static unsigned RBStartFailures;
static NSDictionary *RBActiveNetwork, *RBPendingNetwork;
static char RBNetworkQueueKey;
static dispatch_queue_t RBNetworkQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("dev.rokbot.network", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(queue, &RBNetworkQueueKey, &RBNetworkQueueKey, NULL);
  });
  return queue;
}
static void RBNetworkSync(dispatch_block_t block) {
  if (dispatch_get_specific(&RBNetworkQueueKey)) block();
  else dispatch_sync(RBNetworkQueue(), block);
}
static void RBNetworkReleaseSocket(void) {
  if (RBReservedSocket >= 0) close(RBReservedSocket);
  RBReservedSocket = -1;
}
static uint16_t RBNetworkPort(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return 0;
  NSURLComponents *url = [NSURLComponents componentsWithString:value];
  NSInteger port = url.port.integerValue;
  return [url.host isEqual:@"127.0.0.1"] && port > 0 && port <= UINT16_MAX ? (uint16_t)port : 0;
}
static void RBNetworkDropPending(void) {
  if (RBPendingTunnel) RBTailcatStop(RBPendingTunnel);
  RBPendingTunnel = 0; RBPendingPort = 0; RBPendingNetwork = nil;
}
static NSDictionary *RBNetworkQuery(void) {
  return @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:[@"rokbot.network." stringByAppendingString:NSBundle.mainBundle.bundleIdentifier],
    (__bridge id)kSecAttrAccount:@"tailcat"};
}
static NSDictionary *RBNetworkRead(void) {
  NSMutableDictionary *query = [RBNetworkQuery() mutableCopy]; query[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef data = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &data) != errSecSuccess) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:CFBridgingRelease(data) options:0 error:nil];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}
static BOOL RBNetworkWrite(NSDictionary *value) {
  NSDictionary *attrs = @{(__bridge id)kSecValueData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil],
    (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly};
  OSStatus result = SecItemUpdate((__bridge CFDictionaryRef)RBNetworkQuery(), (__bridge CFDictionaryRef)attrs);
  if (result == errSecItemNotFound) { NSMutableDictionary *q = [RBNetworkQuery() mutableCopy]; [q addEntriesFromDictionary:attrs]; result = SecItemAdd((__bridge CFDictionaryRef)q, NULL); }
  return result == errSecSuccess;
}
static NSDictionary *RBNetworkResult(char *raw) {
  if (!raw) return nil;
  NSData *data = [[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding]; RBTailcatFree(raw);
  id result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [result isKindOfClass:NSDictionary.class] ? result : nil;
}
NSString *RBNetworkAddress(void) {
  __block NSString *address; RBNetworkSync(^{ address = RBActiveNetwork[@"address"] ?: @""; }); return address;
}
BOOL RBNetworkEnabled(void) {
  __block BOOL enabled; RBNetworkSync(^{ enabled = [RBActiveNetwork[@"enabled"] boolValue]; }); return enabled;
}
BOOL RBNetworkEnsureReadyForURL(NSURL *url) {
  __block BOOL ready = YES;
  RBNetworkSync(^{
    if (![RBActiveNetwork[@"enabled"] boolValue] || ![url.host isEqual:@"127.0.0.1"] ||
        url.port.integerValue != RBActivePort) return;
    NSDictionary *status = RBActiveTunnel ? RBNetworkResult(RBTailcatStatus(RBActiveTunnel)) : nil;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    BOOL listening = [status[@"listening"] boolValue];
    if (listening) {
      if ([status[@"state"] isEqual:@"ready"] && ![status[@"error"] length]) {
        RBPeerUnhealthySince = 0; RBPeerWasReady = YES;
        return;
      }
      // Keep short outages and initial handshakes on the existing client. A
      // suspended client can retain its listener while its peer stack is stale.
      if (!RBPeerUnhealthySince || now < RBPeerUnhealthySince) RBPeerUnhealthySince = now;
      CFTimeInterval grace = RBPeerWasReady ? RBPeerRecoveryGrace : RBPeerInitialGrace;
      if (now - RBPeerUnhealthySince < grace) return;
    }
    ready = NO;
    double backoff = MIN(10.0, 0.5 * (1u << MIN(RBStartFailures, 4u)));
    if (RBStartFailures && now >= RBLastAttempt && now - RBLastAttempt < backoff) return;
    RBLastAttempt = now;
    int old = RBActiveTunnel; RBActiveTunnel = 0;
    if (old) RBTailcatStop(old); // Releases the local listener before asynchronous peer cleanup.
    RBNetworkReleaseSocket();
    NSDictionary *config = @{@"mode":@"forward", @"link":RBActiveNetwork[@"address"],
      @"identity":RBActiveNetwork[@"identity"], @"localPort":@(RBActivePort)};
    NSData *data = [NSJSONSerialization dataWithJSONObject:config options:0 error:nil];
    NSString *raw = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSDictionary *result = RBNetworkResult(RBTailcatStart(raw.UTF8String));
    int handle = [result[@"handle"] intValue];
    ready = handle && [result[@"status"][@"listening"] boolValue] &&
      RBNetworkPort(result[@"status"][@"localURL"]) == RBActivePort;
    if (ready) { RBActiveTunnel = handle; RBStartFailures = 0; RBPeerUnhealthySince = now; }
    else { if (handle) RBTailcatStop(handle); RBStartFailures = MIN(RBStartFailures + 1, 8u); }
    RBDiagnosticsEvent(old ? @"connection.tunnel.restart" : @"connection.tunnel.start",
      @{@"port":@(RBActivePort), @"success":@(ready),
        @"reason":listening ? @"peer-unreachable" : @"listener-unavailable"});
  });
  return ready;
}
NSDictionary *RBNetworkStatus(void) {
  __block NSDictionary *status;
  RBNetworkSync(^{
    if (![RBActiveNetwork[@"enabled"] boolValue]) { status = @{@"state":@"direct", @"healthy":@YES}; return; }
    NSDictionary *value = RBActiveTunnel ? RBNetworkResult(RBTailcatStatus(RBActiveTunnel)) : nil;
    NSMutableDictionary *result = [(value ?: @{@"state":@"connecting"}) mutableCopy];
    result[@"healthy"] = @([value[@"listening"] boolValue] && [value[@"state"] isEqual:@"ready"] &&
      ![value[@"error"] length]);
    status = result;
  });
  return status;
}
void RBNetworkRollback(void) { RBNetworkSync(^{ RBNetworkDropPending(); }); }
NSString *RBNetworkPrepare(NSString *address, BOOL enabled, NSError **error) {
  __block NSString *prepared;
  RBNetworkSync(^{
    RBNetworkDropPending();
    NSString *input = [address stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableDictionary *record = [@{@"address":input ?: @"", @"enabled":@(enabled)} mutableCopy];
    if (!enabled) {
      NSURLComponents *url = [NSURLComponents componentsWithString:input];
      if (!([url.scheme isEqual:@"http"] || [url.scheme isEqual:@"https"]) || !url.host.length ||
          url.user || url.password || url.query || url.fragment || (url.path.length && ![url.path isEqual:@"/"])) return;
      url.path = @""; record[@"address"] = url.URL.absoluteString;
      RBPendingNetwork = record; prepared = record[@"address"]; return;
    }
    // Editing tests a separate tunnel while the active connection is still usable.
    NSDictionary *identity = RBActiveTunnel ? RBNetworkResult(RBTailcatIdentity())
      : (RBActiveNetwork[@"identity"] ?: RBNetworkRead()[@"identity"] ?: RBNetworkResult(RBTailcatIdentity()));
    if (!identity) return;
    record[@"identity"] = identity;
    NSDictionary *config = @{@"mode":@"forward", @"link":input ?: @"", @"identity":identity};
    NSString *raw = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:config options:0 error:nil] encoding:NSUTF8StringEncoding];
    NSDictionary *result = RBNetworkResult(RBTailcatStart(raw.UTF8String));
    int handle = [result[@"handle"] intValue];
    uint16_t port = RBNetworkPort(result[@"status"][@"localURL"]);
    if (!handle || !port || ![result[@"status"][@"listening"] boolValue]) { if (handle) RBTailcatStop(handle); return; }
    RBPendingTunnel = handle; RBPendingPort = port; RBPendingNetwork = record;
    prepared = result[@"status"][@"localURL"];
  });
  if (!prepared && error) *error = [NSError errorWithDomain:@"RokBotNetwork" code:1
    userInfo:@{NSLocalizedDescriptionKey:RBL(@"无法连接，请检查地址后重试。", @"Could not connect. Check the address and try again.")}];
  return prepared;
}
BOOL RBNetworkCommit(void) {
  __block BOOL committed = NO;
  RBNetworkSync(^{
    if (!RBPendingNetwork || !RBNetworkWrite(RBPendingNetwork)) return;
    int old = RBActiveTunnel;
    RBNetworkReleaseSocket();
    RBActiveTunnel = RBPendingTunnel; RBActivePort = RBPendingPort; RBActiveNetwork = RBPendingNetwork;
    RBPendingTunnel = 0; RBPendingPort = 0; RBPendingNetwork = nil;
    RBLastAttempt = 0; RBStartFailures = 0; RBPeerUnhealthySince = 0; RBPeerWasReady = NO;
    if (old) RBTailcatStop(old);
    committed = YES;
  });
  return committed;
}
NSString *RBNetworkRestore(NSString *fallback) {
  __block NSString *address;
  RBNetworkSync(^{
    if (RBActiveTunnel || RBReservedSocket >= 0) {
      address = [NSString stringWithFormat:@"http://127.0.0.1:%hu", RBActivePort]; return;
    }
    RBActiveNetwork = RBNetworkRead();
    if (![RBActiveNetwork[@"enabled"] boolValue]) { address = RBActiveNetwork[@"address"] ?: fallback; return; }
    // Constructor restore never enters Go. Hold the port until the first request
    // starts the listener after dyld has completed its initializers.
    RBNetworkReleaseSocket();
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in local = {0}; local.sin_family = AF_INET; local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (fd < 0 || bind(fd, (struct sockaddr *)&local, sizeof(local)) != 0) { if (fd >= 0) close(fd); return; }
    socklen_t size = sizeof(local);
    if (getsockname(fd, (struct sockaddr *)&local, &size) != 0) { close(fd); return; }
    RBReservedSocket = fd; RBActivePort = ntohs(local.sin_port);
    RBActiveTunnel = 0; RBLastAttempt = 0; RBStartFailures = 0; RBPeerUnhealthySince = 0; RBPeerWasReady = NO;
    address = [NSString stringWithFormat:@"http://127.0.0.1:%hu", RBActivePort];
  });
  return address;
}
void RBNetworkClear(void) {
  RBNetworkSync(^{
    RBNetworkDropPending();
    int old = RBActiveTunnel;
    RBActiveTunnel = 0; RBActivePort = 0; RBActiveNetwork = nil;
    RBLastAttempt = 0; RBStartFailures = 0; RBPeerUnhealthySince = 0; RBPeerWasReady = NO;
    RBNetworkReleaseSocket();
    SecItemDelete((__bridge CFDictionaryRef)RBNetworkQuery());
    if (old) RBTailcatStop(old);
  });
}
