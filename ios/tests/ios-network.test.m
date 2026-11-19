// Native lifecycle tests. Go and Keychain are isolated; local sockets are real.
#define SecItemDelete RBTestDelete
#define SecItemUpdate RBTestUpdate
#define SecItemAdd RBTestAdd
#define SecItemCopyMatching RBTestRead
#import "../clients/ios/RBNetwork.m"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static NSData *stored;
static NSMutableDictionary *handles;
static int starts, stops, identityCalls, nextHandle;
static BOOL failStart, pauseStart;
static dispatch_semaphore_t entered, proceed;
#define CHECK(value) do { if (!(value)) { fprintf(stderr,"line %d: %s\n",__LINE__,#value); exit(1); } } while (0)
OSStatus RBTestDelete(CFDictionaryRef query) { stored=nil; return errSecSuccess; }
OSStatus RBTestUpdate(CFDictionaryRef query, CFDictionaryRef values) {
  stored = ((__bridge NSDictionary *)values)[(__bridge id)kSecValueData]; return errSecSuccess;
}
OSStatus RBTestAdd(CFDictionaryRef query, CFTypeRef *result) { return errSecSuccess; }
OSStatus RBTestRead(CFDictionaryRef query, CFTypeRef *result) {
  if (!stored) return errSecItemNotFound;
  *result=CFBridgingRetain(stored); return errSecSuccess;
}
NSString *RBL(NSString *zh, NSString *en) { return en; }
void RBDiagnosticsEvent(NSString *event, NSDictionary *value) {}
static char *encode(NSDictionary *value) {
  return strdup([[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil]
    encoding:NSUTF8StringEncoding].UTF8String);
}
char *RBTailcatIdentity(void) { identityCalls++; return encode(@{@"private":@"new-test-identity"}); }
char *RBTailcatStart(const char *raw) {
  starts++;
  if (pauseStart) { dispatch_semaphore_signal(entered); dispatch_semaphore_wait(proceed,DISPATCH_TIME_FOREVER); }
  if (failStart) return encode(@{@"error":@"test startup failure"});
  NSDictionary *config=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  int fd=socket(AF_INET,SOCK_STREAM,0);
  struct sockaddr_in address={0}; address.sin_family=AF_INET;
  address.sin_addr.s_addr=htonl(INADDR_LOOPBACK); address.sin_port=htons([config[@"localPort"] unsignedShortValue]);
  CHECK(bind(fd,(struct sockaddr *)&address,sizeof(address))==0); CHECK(listen(fd,16)==0);
  socklen_t length=sizeof(address); CHECK(getsockname(fd,(struct sockaddr *)&address,&length)==0);
  int handle=++nextHandle;
  NSMutableDictionary *state=[@{@"fd":@(fd),@"listening":@YES,@"state":@"connecting",
    @"localURL":[NSString stringWithFormat:@"http://127.0.0.1:%hu",ntohs(address.sin_port)]} mutableCopy];
  handles[@(handle)]=state;
  return encode(@{@"handle":@(handle),@"status":state});
}
char *RBTailcatStatus(int handle) { return encode(handles[@(handle)] ?: @{@"state":@"disabled"}); }
void RBTailcatStop(int handle) {
  NSMutableDictionary *state=handles[@(handle)];
  if (state) { if ([state[@"listening"] boolValue]) close([state[@"fd"] intValue]); [handles removeObjectForKey:@(handle)]; stops++; }
}
void RBTailcatFree(char *value) { free(value); }
static void saveNetwork(void) {
  stored=[NSJSONSerialization dataWithJSONObject:@{@"enabled":@YES,@"address":@"tailcat://connect/test",
    @"identity":@{@"private":@"saved-test-identity"}} options:0 error:nil];
}
int main(void) { @autoreleasepool {
  handles=[NSMutableDictionary new]; saveNetwork();
  NSURL *url=[NSURL URLWithString:RBNetworkRestore(nil)];
  CHECK(url.port.intValue>0); CHECK(starts==0); CHECK(RBReservedSocket>=0);
  dispatch_apply(20,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^(size_t index){CHECK(RBNetworkEnsureReadyForURL(url));});
  CHECK(starts==1); CHECK(RBReservedSocket==-1); CHECK(![RBNetworkStatus()[@"healthy"] boolValue]);
  CHECK([RBNetworkRestore(nil) isEqual:url.absoluteString]); CHECK(starts==1); CHECK(handles.count==1);
  NSMutableDictionary *state=handles[@(RBActiveTunnel)];
  state[@"state"]=@"ready"; CHECK([RBNetworkStatus()[@"healthy"] boolValue]);
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(RBPeerWasReady);
  state[@"error"]=@"Destination connection failed"; CHECK(![RBNetworkStatus()[@"healthy"] boolValue]);
  [state removeObjectForKey:@"error"];
  close([state[@"fd"] intValue]); state[@"listening"]=@NO;
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(starts==2); CHECK(stops==1);
  CHECK([handles[@(RBActiveTunnel)][@"localURL"] isEqual:url.absoluteString]);
  CHECK(identityCalls==0);
  puts("PASS: lazy start, 20 concurrent requests, peer health and same-port listener recovery");

  int beforePeerRecovery = starts;
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(starts == beforePeerRecovery);
  RBPeerUnhealthySince = CFAbsoluteTimeGetCurrent() - RBPeerRecoveryGrace - 1;
  dispatch_apply(20,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^(size_t index){
    CHECK(RBNetworkEnsureReadyForURL(url));
  });
  CHECK(starts == beforePeerRecovery + 1); CHECK(handles.count == 1);
  CHECK([handles[@(RBActiveTunnel)][@"localURL"] isEqual:url.absoluteString]);
  CHECK(identityCalls == 0);
  state = handles[@(RBActiveTunnel)]; state[@"state"] = @"ready";
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(RBPeerUnhealthySince == 0);
  state[@"state"] = @"connecting";
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(starts == beforePeerRecovery + 1);
  CHECK(RBPeerUnhealthySince > 0);
  state[@"state"] = @"ready"; state[@"error"] = @"Destination connection failed";
  RBPeerUnhealthySince = CFAbsoluteTimeGetCurrent() - RBPeerRecoveryGrace - 1;
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(starts == beforePeerRecovery + 2);
  CHECK(handles.count == 1); CHECK(identityCalls == 0);
  puts("PASS: stale peer recovery, transient grace period, single concurrent rebuild and retained identity/port");

  RBNetworkClear(); CHECK(!RBPeerWasReady); saveNetwork(); url=[NSURL URLWithString:RBNetworkRestore(nil)];
  CHECK(RBNetworkEnsureReadyForURL(url)); int coldStarts = starts;
  RBPeerUnhealthySince = CFAbsoluteTimeGetCurrent() - RBPeerRecoveryGrace - 1;
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(starts == coldStarts);
  RBPeerUnhealthySince = CFAbsoluteTimeGetCurrent() - RBPeerInitialGrace - 1;
  CHECK(RBNetworkEnsureReadyForURL(url)); CHECK(starts == coldStarts + 1);
  puts("PASS: cold handshakes have a longer bounded grace period");

  RBNetworkClear(); CHECK(handles.count==0); saveNetwork();
  url=[NSURL URLWithString:RBNetworkRestore(nil)];
  entered=dispatch_semaphore_create(0); proceed=dispatch_semaphore_create(0); pauseStart=YES;
  dispatch_group_t group=dispatch_group_create();
  dispatch_group_async(group,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{CHECK(RBNetworkEnsureReadyForURL(url));});
  CHECK(dispatch_semaphore_wait(entered,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))==0);
  dispatch_group_async(group,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{RBNetworkClear();});
  dispatch_semaphore_signal(proceed);
  CHECK(dispatch_group_wait(group,dispatch_time(DISPATCH_TIME_NOW,2*NSEC_PER_SEC))==0);
  CHECK(!RBNetworkEnabled()); CHECK(RBActiveTunnel==0); CHECK(handles.count==0); pauseStart=NO;
  puts("PASS: disconnect cannot leave a restarted or untracked tunnel");

  saveNetwork(); url=[NSURL URLWithString:RBNetworkRestore(nil)];
  failStart=YES; int before=starts;
  for (int i=0;i<20;i++) CHECK(!RBNetworkEnsureReadyForURL(url));
  CHECK(starts==before+1);
  CHECK(RBNetworkPrepare(@"tailcat://invalid",YES,nil)==nil);
  RBNetworkClear(); failStart=NO;
  CHECK(RBNetworkEnsureReadyForURL([NSURL URLWithString:@"https://example.com/"]));
  NSString *direct=RBNetworkPrepare(@"https://example.com",NO,nil);
  CHECK([direct isEqual:@"https://example.com"]); CHECK(RBNetworkCommit()); CHECK(!RBNetworkEnabled());
  CHECK(RBNetworkPrepare(@"javascript:alert(1)",NO,nil)==nil); CHECK([RBNetworkAddress() isEqual:direct]);
  RBNetworkClear(); CHECK(handles.count==0);
  puts("PASS: bounded failure retries, direct mode and invalid-edit rollback");
  return 0;
} }
