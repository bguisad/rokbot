#import "RBNetwork.h"
#import "RBLocalize.h"
#import "RBDiagnostics.h"
#import <Security/Security.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>
#include <stdatomic.h>
#include <string.h>

extern char *RBTailcatIdentity(void);
extern char *RBTailcatStart(const char *config);
extern char *RBTailcatStatus(int handle);
extern void RBTailcatStop(int handle);
extern void RBTailcatFree(char *text);

static int RBActiveTunnel, RBPendingTunnel, RBReservedSocket = -1;
static uint16_t RBActivePort, RBPendingPort;
static atomic_bool RBActiveEnabledAtomic;
static _Atomic(uint16_t) RBActivePortAtomic;
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
    (__bridge id)kSecAttrService:[@"rokbot.network." stringByAppendingString:NSBundle.mainBundle.bundleIdentifier ?: @""],
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
  NSData *data = value ? [NSJSONSerialization dataWithJSONObject:value options:0 error:nil] : nil;
  if (!data) return NO;
  NSDictionary *attrs = @{(__bridge id)kSecValueData:data,
    (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly};
  OSStatus result = SecItemUpdate((__bridge CFDictionaryRef)RBNetworkQuery(), (__bridge CFDictionaryRef)attrs);
  if (result == errSecItemNotFound) { NSMutableDictionary *q = [RBNetworkQuery() mutableCopy]; [q addEntriesFromDictionary:attrs]; result = SecItemAdd((__bridge CFDictionaryRef)q, NULL); }
  return result == errSecSuccess;
}
static NSDictionary *RBNetworkResult(char *raw) {
  if (!raw) return nil;
  id result = nil;
  if (raw[0] != '\0') {
    NSData *data = [NSData dataWithBytes:raw length:strlen(raw)];
    result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  }
  RBTailcatFree(raw);
  return [result isKindOfClass:NSDictionary.class] ? result : nil;
}
NSString *RBNetworkAddress(void) {
  __block NSString *address; RBNetworkSync(^{ address = RBActiveNetwork[@"address"] ?: @""; }); return address;
}
BOOL RBNetworkEnabled(void) {
  return atomic_load_explicit(&RBActiveEnabledAtomic, memory_order_acquire);
}
BOOL RBNetworkEnsureReadyForURL(NSURL *url) {
  if (!atomic_load_explicit(&RBActiveEnabledAtomic, memory_order_acquire)) return YES;
  uint16_t activePort = atomic_load_explicit(&RBActivePortAtomic, memory_order_acquire);
  if (!activePort || ![url.host isEqualToString:@"127.0.0.1"] || url.port.integerValue != activePort) return YES;
  __block BOOL ready = YES;
  RBNetworkSync(^{
    if (![RBActiveNetwork[@"enabled"] boolValue] || ![url.host isEqual:@"127.0.0.1"] ||
        url.port.integerValue != RBActivePort) return;
    NSDictionary *status = RBActiveTunnel ? RBNetworkResult(RBTailcatStatus(RBActiveTunnel)) : nil;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    BOOL listening = [status[@"listening"] boolValue];
    BOOL hasError = [status[@"error"] isKindOfClass:NSString.class] && [status[@"error"] length] > 0;
    if (listening) {
      if ([status[@"state"] isEqual:@"ready"] && !hasError) {
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
    NSString *link = [RBActiveNetwork[@"address"] isKindOfClass:NSString.class] ? RBActiveNetwork[@"address"] : nil;
    id identity = RBActiveNetwork[@"identity"];
    if (!link.length || !identity) {
      RBStartFailures = MIN(RBStartFailures + 1, 8u);
      return;
    }
    NSDictionary *config = @{@"mode":@"forward", @"link":link,
      @"identity":identity, @"localPort":@(RBActivePort)};
    NSData *data = [NSJSONSerialization dataWithJSONObject:config options:0 error:nil];
    NSString *raw = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    NSDictionary *result = raw ? RBNetworkResult(RBTailcatStart(raw.UTF8String)) : nil;
    int handle = [result[@"handle"] intValue];
    NSDictionary *resultStatus = [result[@"status"] isKindOfClass:NSDictionary.class] ? result[@"status"] : nil;
    ready = handle && [resultStatus[@"listening"] boolValue] &&
      RBNetworkPort(resultStatus[@"localURL"]) == RBActivePort;
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
    BOOL hasError = [value[@"error"] isKindOfClass:NSString.class] && [value[@"error"] length] > 0;
    result[@"healthy"] = @([value[@"listening"] boolValue] && [value[@"state"] isEqual:@"ready"] && !hasError);
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
    NSData *configData = [NSJSONSerialization dataWithJSONObject:config options:0 error:nil];
    NSString *raw = configData ? [[NSString alloc] initWithData:configData encoding:NSUTF8StringEncoding] : nil;
    if (!raw) return;
    NSDictionary *result = RBNetworkResult(RBTailcatStart(raw.UTF8String));
    int handle = [result[@"handle"] intValue];
    NSDictionary *resultStatus = [result[@"status"] isKindOfClass:NSDictionary.class] ? result[@"status"] : nil;
    uint16_t port = RBNetworkPort(resultStatus[@"localURL"]);
    if (!handle || !port || ![resultStatus[@"listening"] boolValue]) { if (handle) RBTailcatStop(handle); return; }
    RBPendingTunnel = handle; RBPendingPort = port; RBPendingNetwork = record;
    prepared = resultStatus[@"localURL"];
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
    atomic_store_explicit(&RBActivePortAtomic, RBActivePort, memory_order_release);
    atomic_store_explicit(&RBActiveEnabledAtomic, [RBActiveNetwork[@"enabled"] boolValue], memory_order_release);
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
    BOOL enabled = [RBActiveNetwork[@"enabled"] boolValue];
    if (!enabled) {
      RBActivePort = 0;
      atomic_store_explicit(&RBActivePortAtomic, 0, memory_order_release);
      atomic_store_explicit(&RBActiveEnabledAtomic, false, memory_order_release);
      address = RBActiveNetwork[@"address"] ?: fallback;
      return;
    }
    // Constructor restore never enters Go. Hold the port until the first request
    // starts the listener after dyld has completed its initializers.
    RBNetworkReleaseSocket();
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in local = {0}; local.sin_family = AF_INET; local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (fd < 0 || bind(fd, (struct sockaddr *)&local, sizeof(local)) != 0) {
      if (fd >= 0) close(fd);
      RBActivePort = 0;
      atomic_store_explicit(&RBActivePortAtomic, 0, memory_order_release);
      atomic_store_explicit(&RBActiveEnabledAtomic, false, memory_order_release);
      return;
    }
    socklen_t size = sizeof(local);
    if (getsockname(fd, (struct sockaddr *)&local, &size) != 0) {
      close(fd);
      RBActivePort = 0;
      atomic_store_explicit(&RBActivePortAtomic, 0, memory_order_release);
      atomic_store_explicit(&RBActiveEnabledAtomic, false, memory_order_release);
      return;
    }
    RBReservedSocket = fd; RBActivePort = ntohs(local.sin_port);
    atomic_store_explicit(&RBActivePortAtomic, RBActivePort, memory_order_release);
    atomic_store_explicit(&RBActiveEnabledAtomic, true, memory_order_release);
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
    atomic_store_explicit(&RBActivePortAtomic, 0, memory_order_release);
    atomic_store_explicit(&RBActiveEnabledAtomic, false, memory_order_release);
    RBLastAttempt = 0; RBStartFailures = 0; RBPeerUnhealthySince = 0; RBPeerWasReady = NO;
    RBNetworkReleaseSocket();
    SecItemDelete((__bridge CFDictionaryRef)RBNetworkQuery());
    if (old) RBTailcatStop(old);
  });
}
