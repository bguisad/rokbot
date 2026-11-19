#import "RBDeviceIdentity.h"
#import <Security/Security.h>

static NSString *const RBClientDeviceDefaultsKey = @"RokBotLocal.clientDeviceId";
static NSString *const RBClientDeviceAccount = @"client-device-id";

BOOL RBIsValidClientDeviceId(NSString *candidate) {
  if (![candidate isKindOfClass:NSString.class])
    return NO;
  NSUInteger length = candidate.length;
  if (length == 0 || length > 128)
    return NO;
  for (NSUInteger i = 0; i < length; i++) {
    unichar c = [candidate characterAtIndex:i];
    BOOL ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
              c == '.' || c == '_' || c == ':' || c == '@' || c == '-';
    if (!ok)
      return NO;
  }
  return YES;
}

static NSDictionary *RBClientDeviceKeychainQuery(NSString *bundleId) {
  NSString *effectiveBundle = bundleId.length ? bundleId : @"dev.rokbot.local";
  return @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : [@"dev.rokbot.local." stringByAppendingString:effectiveBundle],
    (__bridge id)kSecAttrAccount : RBClientDeviceAccount
  };
}

static NSString *RBReadClientDeviceIdFromKeychain(NSString *bundleId) {
  NSMutableDictionary *query = [RBClientDeviceKeychainQuery(bundleId) mutableCopy];
  query[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef result = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &result) != errSecSuccess)
    return nil;
  NSData *data = CFBridgingRelease(result);
  if (![data isKindOfClass:NSData.class])
    return nil;
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static BOOL RBWriteClientDeviceIdToKeychain(NSString *bundleId, NSString *deviceId) {
  NSData *data = [deviceId dataUsingEncoding:NSUTF8StringEncoding];
  if (!data.length)
    return NO;
  NSDictionary *query = RBClientDeviceKeychainQuery(bundleId);
  NSDictionary *attrs = @{
    (__bridge id)kSecValueData : data,
    (__bridge id)kSecAttrAccessible : (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  };
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attrs);
  if (status == errSecItemNotFound) {
    NSMutableDictionary *item = [query mutableCopy];
    [item addEntriesFromDictionary:attrs];
    status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  }
  return status == errSecSuccess;
}

static NSLock *RBDeviceIdentityLock(void) {
  static NSLock *lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [NSLock new];
  });
  return lock;
}

NSString *RBClientDeviceIdForBundleIdentifier(NSString *bundleId, NSUserDefaults *defaults) {
  NSUserDefaults *store = defaults ?: NSUserDefaults.standardUserDefaults;
  NSLock *lock = RBDeviceIdentityLock();
  [lock lock];
  @try {
    NSString *keychainId = RBReadClientDeviceIdFromKeychain(bundleId);
    if (RBIsValidClientDeviceId(keychainId)) {
      NSString *existingDefault = [store stringForKey:RBClientDeviceDefaultsKey];
      if (![existingDefault isEqualToString:keychainId])
        [store setObject:keychainId forKey:RBClientDeviceDefaultsKey];
      return keychainId;
    }
    NSString *defaultsId = [store stringForKey:RBClientDeviceDefaultsKey];
    if (RBIsValidClientDeviceId(defaultsId)) {
      RBWriteClientDeviceIdToKeychain(bundleId, defaultsId);
      return defaultsId;
    }
    NSString *hex = [[NSUUID.UUID.UUIDString stringByReplacingOccurrencesOfString:@"-" withString:@""]
        lowercaseString];
    NSString *generated = [@"ios-" stringByAppendingString:hex];
    RBWriteClientDeviceIdToKeychain(bundleId, generated);
    [store setObject:generated forKey:RBClientDeviceDefaultsKey];
    return generated;
  } @finally {
    [lock unlock];
  }
}

NSString *RBClientDeviceId(void) {
  return RBClientDeviceIdForBundleIdentifier(NSBundle.mainBundle.bundleIdentifier,
                                             NSUserDefaults.standardUserDefaults);
}
