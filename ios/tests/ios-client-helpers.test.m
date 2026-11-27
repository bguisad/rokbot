// Unit tests for pure-Foundation/Security iOS client helpers (compiled on macOS clang).
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>

// Mock Keychain functions before importing RBDeviceIdentity.m so we verify exact
// kSecAttrService / kSecAttrAccount / kSecAttrAccessible semantics in isolation.
static NSMutableDictionary<NSString *, NSMutableDictionary *> *RBTestKeychain;
static NSMutableDictionary<NSString *, id> *RBTestLastAccessible;

#define SecItemDelete RBHelperTestSecDelete
#define SecItemUpdate RBHelperTestSecUpdate
#define SecItemAdd RBHelperTestSecAdd
#define SecItemCopyMatching RBHelperTestSecCopyMatching

static NSString *RBTestKeyForQuery(CFDictionaryRef query) {
  NSDictionary *q = (__bridge NSDictionary *)query;
  NSString *svc = q[(__bridge id)kSecAttrService] ?: @"";
  NSString *acc = q[(__bridge id)kSecAttrAccount] ?: @"";
  return [NSString stringWithFormat:@"%@\n%@", svc, acc];
}

OSStatus RBHelperTestSecDelete(CFDictionaryRef query) {
  NSString *key = RBTestKeyForQuery(query);
  if (!RBTestKeychain[key])
    return errSecItemNotFound;
  [RBTestKeychain removeObjectForKey:key];
  return errSecSuccess;
}

OSStatus RBHelperTestSecUpdate(CFDictionaryRef query, CFDictionaryRef values) {
  NSString *key = RBTestKeyForQuery(query);
  NSDictionary *attrs = (__bridge NSDictionary *)values;
  if (!RBTestKeychain[key])
    return errSecItemNotFound;
  NSData *data = attrs[(__bridge id)kSecValueData];
  if (data)
    RBTestKeychain[key][@"data"] = data;
  if (attrs[(__bridge id)kSecAttrAccessible])
    RBTestLastAccessible[key] = attrs[(__bridge id)kSecAttrAccessible];
  return errSecSuccess;
}

OSStatus RBHelperTestSecAdd(CFDictionaryRef query, CFTypeRef *result) {
  NSDictionary *q = (__bridge NSDictionary *)query;
  NSString *key = RBTestKeyForQuery(query);
  if (RBTestKeychain[key])
    return errSecDuplicateItem;
  RBTestKeychain[key] = [@{ @"data" : q[(__bridge id)kSecValueData] ?: [NSData data] } mutableCopy];
  if (q[(__bridge id)kSecAttrAccessible])
    RBTestLastAccessible[key] = q[(__bridge id)kSecAttrAccessible];
  return errSecSuccess;
}

OSStatus RBHelperTestSecCopyMatching(CFDictionaryRef query, CFTypeRef *result) {
  NSString *key = RBTestKeyForQuery(query);
  NSDictionary *entry = RBTestKeychain[key];
  if (!entry)
    return errSecItemNotFound;
  if (result)
    *result = CFBridgingRetain(entry[@"data"]);
  return errSecSuccess;
}

#import "../clients/ios/RBDeviceIdentity.m"
#import "../clients/ios/RBModels.m"
#import "../clients/ios/RBUpdater.m"
#import "../clients/ios/RBSuggestions.m"
#import "../clients/ios/RBGroupCreate.m"

#define CHECK(cond)                                                                                \
  do {                                                                                             \
    if (!(cond)) {                                                                                 \
      fprintf(stderr, "CHECK failed at line %d: %s\n", __LINE__, #cond);                           \
      exit(1);                                                                                     \
    }                                                                                              \
  } while (0)

static void testDeviceIdentity(void) {
  RBTestKeychain = [NSMutableDictionary dictionary];
  RBTestLastAccessible = [NSMutableDictionary dictionary];

  NSString *suiteA = [@"dev.rokbot.test.a." stringByAppendingString:NSUUID.UUID.UUIDString];
  NSString *suiteB = [@"dev.rokbot.test.b." stringByAppendingString:NSUUID.UUID.UUIDString];
  NSUserDefaults *defaultsA = [[NSUserDefaults alloc] initWithSuiteName:suiteA];
  NSUserDefaults *defaultsB = [[NSUserDefaults alloc] initWithSuiteName:suiteB];

  // Validation checks
  CHECK(!RBIsValidClientDeviceId(nil));
  CHECK(!RBIsValidClientDeviceId(@""));
  CHECK(!RBIsValidClientDeviceId(@"ios invalid space"));
  CHECK(!RBIsValidClientDeviceId(@"ios/slash"));
  CHECK(!RBIsValidClientDeviceId([@"" stringByPaddingToLength:129 withString:@"a" startingAtIndex:0]));
  CHECK(RBIsValidClientDeviceId(@"ios-0123456789abcdef0123456789abcdef"));

  // Generate & persist
  NSString *idA1 = RBClientDeviceIdForBundleIdentifier(@"dev.rokbot.local", defaultsA);
  CHECK(idA1.length == 36);
  CHECK([idA1 hasPrefix:@"ios-"]);
  CHECK(RBIsValidClientDeviceId(idA1));
  CHECK([[defaultsA stringForKey:@"RokBotLocal.clientDeviceId"] isEqualToString:idA1]);

  NSString *kcKeyA = @"dev.rokbot.local.dev.rokbot.local\nclient-device-id";
  CHECK(RBTestKeychain[kcKeyA] != nil);
  CHECK([RBTestLastAccessible[kcKeyA]
      isEqual:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]);

  // Simulated disconnect (removes device-token and RokBotLocal.deviceId, NOT client-device-id)
  [defaultsA setObject:@"srv-device-1" forKey:@"RokBotLocal.deviceId"];
  RBTestKeychain[@"dev.rokbot.local.dev.rokbot.local\ndevice-token"] =
      [@{ @"data" : [@"tok" dataUsingEncoding:NSUTF8StringEncoding] } mutableCopy];
  [defaultsA removeObjectForKey:@"RokBotLocal.deviceId"];
  [RBTestKeychain removeObjectForKey:@"dev.rokbot.local.dev.rokbot.local\ndevice-token"];
  NSString *idA2 = RBClientDeviceIdForBundleIdentifier(@"dev.rokbot.local", defaultsA);
  CHECK([idA2 isEqualToString:idA1]);

  // UserDefaults wiped -> restored from Keychain and re-mirrored
  [defaultsA removeObjectForKey:@"RokBotLocal.clientDeviceId"];
  NSString *idA3 = RBClientDeviceIdForBundleIdentifier(@"dev.rokbot.local", defaultsA);
  CHECK([idA3 isEqualToString:idA1]);
  CHECK([[defaultsA stringForKey:@"RokBotLocal.clientDeviceId"] isEqualToString:idA1]);

  // Keychain wiped -> restored from UserDefaults and backfilled to Keychain
  [RBTestKeychain removeObjectForKey:kcKeyA];
  NSString *idA4 = RBClientDeviceIdForBundleIdentifier(@"dev.rokbot.local", defaultsA);
  CHECK([idA4 isEqualToString:idA1]);
  CHECK(RBTestKeychain[kcKeyA] != nil);

  // Separate bundleId stays isolated
  NSString *idB1 = RBClientDeviceIdForBundleIdentifier(@"dev.rokbot.beta", defaultsB);
  CHECK(RBIsValidClientDeviceId(idB1));
  CHECK(![idB1 isEqualToString:idA1]);
  CHECK(RBTestKeychain[@"dev.rokbot.local.dev.rokbot.beta\nclient-device-id"] != nil);

  [defaultsA removePersistentDomainForName:suiteA];
  [defaultsB removePersistentDomainForName:suiteB];
  puts("PASS: RBDeviceIdentity format, Keychain/Defaults persistence, disconnect survival & bundleId isolation");
}

static void testModelsHelpers(void) {
  // Dual-shape config & reload extraction
  NSDictionary *nested = @{
    @"ok" : @YES,
    @"config" : @{
      @"providers" : @[ @{ @"id" : @"p1" } ],
      @"profiles" : @[ @{ @"id" : @"m1" } ],
      @"defaultRoute" : @{ @"profileId" : @"m1", @"effort" : @"default", @"fallbacks" : @[] },
      @"botRoutes" : @{ @"bot-1" : @{ @"profileId" : @"m1", @"effort" : @"high", @"fallbacks" : @[] } }
    },
    @"reload" : @{ @"revision" : @"rev-1", @"status" : @"waiting" }
  };
  CHECK([RBModelsExtractRoutingConfig(nested)[@"providers"] count] == 1);
  CHECK([RBModelsExtractReloadState(nested)[@"status"] isEqualToString:@"waiting"]);

  NSDictionary *flat = @{
    @"providers" : @[ @{ @"id" : @"p2" } ],
    @"profiles" : @[ @{ @"id" : @"m2" } ],
    @"defaultRoute" : @{ @"profileId" : @"m2" },
    @"botRoutes" : @{},
    @"reload" : @{ @"status" : @"applied" }
  };
  CHECK([RBModelsExtractRoutingConfig(flat)[@"providers"][0][@"id"] isEqualToString:@"p2"]);
  CHECK([RBModelsExtractReloadState(flat)[@"status"] isEqualToString:@"applied"]);

  // needsModel & canConfigureModel parsing
  BOOL canConfigure = NO;
  CHECK(RBModelsParseNeedsModel(@{ @"needsModel" : @YES, @"canConfigureModel" : @NO }, &canConfigure));
  CHECK(!canConfigure);
  CHECK(!RBModelsParseNeedsModel(@{ @"needsModel" : @NO }, &canConfigure));
  CHECK(canConfigure); // Defaults YES when omitted

  // Payload building: preserves empty apiKey for existing hasApiKey==YES provider & preserves botRoutes
  NSDictionary *existingProv = @{
    @"id" : @"openai-main",
    @"name" : @"OpenAI",
    @"apiFormat" : @"openai",
    @"baseUrl" : @"https://api.openai.com/v1/",
    @"hasApiKey" : @YES
  };
  NSDictionary *newProvNoKey = @{
    @"id" : @"anthropic-new",
    @"name" : @"Anthropic",
    @"apiFormat" : @"anthropic",
    @"baseUrl" : @"https://api.anthropic.com",
    @"hasApiKey" : @NO
  };
  NSArray *profiles = @[ @{
    @"id" : @"gpt4o",
    @"name" : @"GPT-4o",
    @"providerId" : @"openai-main",
    @"model" : @"gpt-4o",
    @"efforts" : @[ @"low", @"high" ],
    @"contextWindowTokens" : @128000,
    @"summaryThresholdTokens" : @96000
  } ];
  NSDictionary *defRoute = @{ @"profileId" : @"gpt4o", @"effort" : @"high", @"fallbacks" : @[] };
  NSDictionary *botRoutes = @{ @"agent-alpha" : @{ @"profileId" : @"gpt4o", @"effort" : @"low", @"fallbacks" : @[] } };

  NSString *err = nil;
  NSDictionary *okPayload = RBModelsBuildSavePayload(
      @[ existingProv ], profiles, defRoute, botRoutes, @{}, NO, &err);
  CHECK(okPayload != nil);
  CHECK(err == nil);
  CHECK([okPayload[@"version"] isEqual:@1]);
  CHECK([okPayload[@"providers"][0][@"apiKey"] isEqualToString:@""]);
  CHECK([okPayload[@"providers"][0][@"baseUrl"] isEqualToString:@"https://api.openai.com/v1"]);
  CHECK([okPayload[@"botRoutes"][@"agent-alpha"][@"effort"] isEqualToString:@"low"]);
  CHECK(okPayload[@"migrateLegacyRouting"] == nil);

  // New provider without API key must fail validation
  NSDictionary *missingKeyPayload = RBModelsBuildSavePayload(
      @[ existingProv, newProvNoKey ], profiles, defRoute, botRoutes, @{}, NO, &err);
  CHECK(missingKeyPayload == nil);
  CHECK(err.length > 0);

  // Supplying pending key + migrateLegacyRouting succeeds
  NSDictionary *pendingPayload = RBModelsBuildSavePayload(
      @[ existingProv, newProvNoKey ], profiles, defRoute, botRoutes,
      @{ @"anthropic-new" : @"sk-ant-test-123" }, YES, &err);
  CHECK(pendingPayload != nil);
  CHECK([pendingPayload[@"providers"][1][@"apiKey"] isEqualToString:@"sk-ant-test-123"]);
  CHECK([pendingPayload[@"migrateLegacyRouting"] isEqual:@YES]);

  CHECK([RBModelsDefaultBaseURLForFormat(@"anthropic") isEqualToString:@"https://api.anthropic.com"]);
  CHECK([RBModelsDefaultBaseURLForFormat(@"openai-responses") isEqualToString:@"https://api.openai.com/v1"]);
  CHECK([RBModelsNormalizeIdCandidate(@"My Provider!", @"provider") isEqualToString:@"my-provider"]);

  // NSNull / malformed type coercion resilience (must never throw NSInvalidArgumentException)
  CHECK(!RBModelsParseNeedsModel((id)NSNull.null, &canConfigure));
  CHECK(canConfigure);
  CHECK(!RBModelsParseNeedsModel(@{ @"needsModel" : NSNull.null, @"canConfigureModel" : NSNull.null }, &canConfigure));
  CHECK(canConfigure);
  CHECK(RBModelsParseNeedsModel(@{ @"needsModel" : NSNull.null, @"configured" : @NO }, &canConfigure));
  CHECK(!RBModelsParseNeedsModel(@{ @"configured" : NSNull.null }, &canConfigure));
  CHECK([RBModelsExtractRoutingConfig((id)NSNull.null) count] == 0);
  CHECK([RBModelsExtractReloadState(@{ @"reload" : NSNull.null, @"config" : NSNull.null }) count] == 0);
  NSString *normNull = RBModelsNormalizeIdCandidate((id)NSNull.null, (id)NSNull.null);
  CHECK([normNull hasPrefix:@"item-"]);

  NSDictionary *nullProvNoKey = @{
    @"id" : @"null-prov",
    @"name" : @"Null Prov",
    @"apiFormat" : @"openai",
    @"baseUrl" : @"https://api.openai.com/v1",
    @"hasApiKey" : NSNull.null
  };
  CHECK(RBModelsBuildSavePayload(@[ nullProvNoKey ], profiles, defRoute, botRoutes, @{}, NO, &err) == nil);
  CHECK(err.length > 0);

  NSDictionary *nullProvWithKey = @{
    @"id" : @"openai-main",
    @"name" : @"OpenAI",
    @"apiFormat" : @"openai",
    @"baseUrl" : @"https://api.openai.com/v1",
    @"hasApiKey" : NSNull.null,
    @"apiKey" : @"sk-null-test"
  };
  NSArray *nullProfiles = @[ @{
    @"id" : @"gpt4o",
    @"name" : @"GPT-4o",
    @"providerId" : @"openai-main",
    @"model" : @"gpt-4o",
    @"efforts" : NSNull.null,
    @"contextWindowTokens" : NSNull.null,
    @"summaryThresholdTokens" : NSNull.null
  } ];
  NSDictionary *nullRoute = @{
    @"profileId" : @"gpt4o",
    @"effort" : NSNull.null,
    @"fallbacks" : @[ NSNull.null, @{ @"profileId" : NSNull.null } ]
  };
  NSDictionary *nullSafePayload = RBModelsBuildSavePayload(
      @[ nullProvWithKey ], nullProfiles, nullRoute, (id)NSNull.null, (id)NSNull.null, NO, &err);
  CHECK(nullSafePayload != nil && err == nil);
  CHECK([nullSafePayload[@"profiles"][0][@"contextWindowTokens"] isEqual:@0]);
  CHECK([nullSafePayload[@"profiles"][0][@"summaryThresholdTokens"] isEqual:@0]);
  CHECK([nullSafePayload[@"botRoutes"] count] == 0);
  puts("PASS: RBModels dual-shape parsing, key preservation, validation & botRoutes preservation");
}

static void testUpdaterHelpers(void) {
  // Version & build comparison
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.1", @"23152", @"1.16.0", @"23152") == NSOrderedDescending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0", @"23153", @"1.16.0", @"23152") == NSOrderedDescending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0", @"23152", @"1.16.0", @"23152") == NSOrderedSame);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.15.9", @"99999", @"1.16.0", @"23152") == NSOrderedAscending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.2", @"10", @"1.2.0", @"10") == NSOrderedSame);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.10.0", @"1", @"1.2.0", @"1") == NSOrderedDescending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0-beta", @"23152", @"1.16.0", @"23152") == NSOrderedAscending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0", @"23152", @"1.16.0-beta", @"23152") == NSOrderedDescending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0-beta", nil, @"1.16.0", nil) == NSOrderedAscending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0-beta.2", @"23152", @"1.16.0-beta.1", @"23152") == NSOrderedDescending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0-beta", @"23153", @"1.16.0", @"23152") == NSOrderedDescending);
  CHECK(RBUpdaterCompareVersionAndBuild(@"1.16.0+build1", @"23152", @"1.16.0", @"23152") == NSOrderedSame);

  // Strict RFC 3986 query percent encoding
  NSString *enc = RBUpdaterPercentEncodeQueryValue(@"https://bot.example/updates/ios/tok/manifest.plist?a=1&b=2+3");
  CHECK([enc isEqualToString:@"https%3A%2F%2Fbot.example%2Fupdates%2Fios%2Ftok%2Fmanifest.plist%3Fa%3D1%26b%3D2%2B3"]);

  // URL builders
  NSURL *itms = RBUpdaterBuildItmsServicesURL(@"/updates/ios/tok/manifest.plist?v=1&x=2", @"https://bot.example:8443");
  CHECK([itms.absoluteString isEqualToString:
      @"itms-services://?action=download-manifest&url=https%3A%2F%2Fbot.example%3A8443%2Fupdates%2Fios%2Ftok%2Fmanifest.plist%3Fv%3D1%26x%3D2"]);
  NSURL *itmsPre = RBUpdaterBuildItmsServicesURL(@"itms-services://?action=download-manifest&url=https%3A%2F%2Fcdn.example%2Fm.plist", @"https://bot.example");
  CHECK([itmsPre.scheme isEqualToString:@"itms-services"]);

  NSURL *alt = RBUpdaterBuildSourceSchemeURL(@"altstore", @"/updates/ios/tok/altstore.json", @"https://bot.example");
  CHECK([alt.absoluteString isEqualToString:
      @"altstore://source?url=https%3A%2F%2Fbot.example%2Fupdates%2Fios%2Ftok%2Faltstore.json"]);
  NSURL *side = RBUpdaterBuildSourceSchemeURL(@"sidestore", @"/updates/ios/tok/altstore.json", @"https://bot.example");
  CHECK([side.absoluteString isEqualToString:
      @"sidestore://source?url=https%3A%2F%2Fbot.example%2Fupdates%2Fios%2Ftok%2Faltstore.json"]);

  // Sandbox/itms reachability checks
  NSString *warn = nil;
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"http://127.0.0.1:41234/updates/ios/tok/manifest.plist"], &warn));
  CHECK(warn.length > 0);
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://127.0.0.1:8443/updates/ios/tok/manifest.plist"], &warn));
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://localhost./updates/ios/tok/manifest.plist"], &warn));
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://sub.localhost/updates/ios/tok/manifest.plist"], &warn));
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://0.0.0.0:8443/updates/ios/tok/manifest.plist"], &warn));
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://127.0.0.2:8443/updates/ios/tok/manifest.plist"], &warn));
  CHECK(!RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://[::ffff:127.0.0.1]:8443/updates/ios/tok/manifest.plist"], &warn));
  CHECK(RBUpdaterIsItmsURLReachableOutsideSandbox(
      [NSURL URLWithString:@"https://127.example.com/updates/ios/tok/manifest.plist"], &warn));
  CHECK(RBUpdaterIsItmsURLReachableOutsideSandbox(itms, &warn));
  CHECK(warn == nil);

  // Origin check for Bearer auth
  CHECK(RBUpdaterShouldAttachBearerAuth(
      [NSURL URLWithString:@"https://bot.example:443/local/updates/files/ios/app.ipa"],
      @"https://bot.example"));
  CHECK(!RBUpdaterShouldAttachBearerAuth(
      [NSURL URLWithString:@"https://evil.example/local/updates/files/ios/app.ipa"],
      @"https://bot.example"));

  // Manifest parsing & bundleId mismatch
  NSString *manifestErr = nil;
  NSDictionary *parsed = RBUpdaterParseManifest(@{
    @"schema" : @"rokbot-ios-update/v1",
    @"latest" : @{
      @"version" : @"1.16.0",
      @"build" : @"23153",
      @"bundleId" : @"dev.other.app",
      @"sha256" : @"AABBCC",
      @"size" : @1024,
      @"releaseNotes" : @"Bug fixes",
      @"installMethods" : @{
        @"itmsServicesUrl" : @"/updates/ios/tok/manifest.plist",
        @"altStoreSourceUrl" : @"/updates/ios/tok/altstore.json",
        @"ipaDownloadUrl" : @"/local/updates/files/ios/app.ipa"
      }
    }
  }, @"dev.rokbot.local", &manifestErr);
  CHECK(parsed != nil);
  CHECK(manifestErr == nil);
  CHECK([parsed[@"bundleIdMismatch"] boolValue]);
  CHECK([parsed[@"sha256"] isEqualToString:@"aabbcc"]);
  CHECK(RBUpdaterParseManifest(@{ @"schema" : @"bad/v1", @"latest" : @{} }, @"dev.rokbot.local", &manifestErr) == nil);
  CHECK(manifestErr.length > 0);

  // Multi-chunk streaming SHA-256 verification (> 64 KiB)
  NSString *tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"rb-updater-test-%@.bin", NSUUID.UUID.UUIDString]];
  NSMutableData *blob = [NSMutableData dataWithLength:150000];
  memset(blob.mutableBytes, 'R', blob.length);
  CHECK([blob writeToFile:tmpPath atomically:YES]);
  NSURL *tmpURL = [NSURL fileURLWithPath:tmpPath];
  NSError *shaErr = nil;
  NSString *digest = RBUpdaterFileSHA256(tmpURL, &shaErr);
  CHECK(digest.length == 64 && shaErr == nil);
  CHECK(RBUpdaterVerifyFileSHA256(tmpURL, digest, 150000, &shaErr));
  CHECK(!RBUpdaterVerifyFileSHA256(tmpURL, digest, 149999, &shaErr));
  CHECK(!RBUpdaterVerifyFileSHA256(tmpURL, @"0000", 150000, &shaErr));
  [NSFileManager.defaultManager removeItemAtURL:tmpURL error:nil];

  // 0-byte file with empty expectedHash and expectedSize == 0 must NOT pass
  NSString *emptyPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"rb-updater-empty-%@.bin", NSUUID.UUID.UUIDString]];
  CHECK([[NSData data] writeToFile:emptyPath atomically:YES]);
  NSURL *emptyURL = [NSURL fileURLWithPath:emptyPath];
  shaErr = nil;
  CHECK(!RBUpdaterVerifyFileSHA256(emptyURL, @"", 0, &shaErr));
  CHECK(shaErr != nil);
  CHECK(!RBUpdaterVerifyFileSHA256(emptyURL, nil, 0, &shaErr));
  CHECK(RBUpdaterVerifyFileSHA256(
      emptyURL, @"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 0, &shaErr));
  [NSFileManager.defaultManager removeItemAtURL:emptyURL error:nil];

  // NSNull resilience in RBUpdaterParseManifest
  NSDictionary *nullManifest = RBUpdaterParseManifest(@{
    @"schema" : @"rokbot-ios-update/v1",
    @"latest" : @{
      @"version" : @"1.16.0",
      @"build" : NSNull.null,
      @"bundleId" : NSNull.null,
      @"sha256" : NSNull.null,
      @"size" : NSNull.null,
      @"releaseNotes" : NSNull.null,
      @"installMethods" : NSNull.null
    }
  }, @"dev.rokbot.local", &manifestErr);
  CHECK(nullManifest != nil && manifestErr == nil);
  CHECK([nullManifest[@"size"] isEqual:@0]);

  puts("PASS: RBUpdater version/build compare, RFC 3986 URLs, manifest parsing & chunked SHA-256");
}

static void testScenarioRouteHelpers(void) {
  NSArray *profiles = @[ @{ @"id" : @"opus", @"efforts" : @[ @"low", @"high" ] }, @{ @"id" : @"haiku", @"efforts" : @[] } ];
  CHECK(RBModelsScenarioKeys().count == 6);
  CHECK([RBModelsScenarioKeys() containsObject:@"suggestions"] && [RBModelsScenarioKeys() containsObject:@"automation"]);
  NSDictionary *clean = RBModelsCleanScenarioRoutes(@{
    @"suggestions" : @{ @"profileId" : @"haiku", @"effort" : @"max" },
    @"memoryExtraction" : @{ @"profileId" : @"opus", @"effort" : @"high" },
    @"autoReview" : @{ @"profileId" : @"deleted" },
    @"subagent" : @{ @"profileId" : @"" },
    @"unknownScenario" : @{ @"profileId" : @"opus" },
  }, profiles);
  CHECK(clean.count == 2);
  CHECK([clean[@"suggestions"][@"effort"] isEqualToString:@"default"]);
  CHECK([clean[@"memoryExtraction"][@"effort"] isEqualToString:@"high"]);
  CHECK(clean[@"unknownScenario"] == nil && clean[@"autoReview"] == nil);
  NSDictionary *payload = RBModelsAttachRoutingExtras(@{ @"version" : @1 }, @{}, nil, profiles);
  CHECK([payload[@"scenarioRoutes"] isKindOfClass:NSDictionary.class] && [payload[@"scenarioRoutes"] count] == 0);
  CHECK(payload[@"adaptiveRouting"] == nil);
  NSDictionary *adaptive = @{ @"enabled" : @YES, @"tiers" : @{} };
  payload = RBModelsAttachRoutingExtras(@{ @"version" : @1 }, clean, adaptive, profiles);
  CHECK([payload[@"adaptiveRouting"] isEqual:adaptive] && [payload[@"scenarioRoutes"] count] == 2);
  NSArray *named = @[ @{ @"id" : @"opus", @"name" : @"Claude Opus", @"model" : @"claude-opus-5-5" } ];
  CHECK([RBModelsRouteSummary(nil, named, YES) isEqualToString:@"跟随默认"]);
  CHECK([RBModelsRouteSummary(@{ @"profileId" : @"opus", @"effort" : @"low" }, named, NO) isEqualToString:@"Claude Opus · claude-opus-5-5 (low)"]);
  puts("PASS: RBModels scenario routes cleaning, scenarioRoutes always sent, adaptive passthrough & route summary");
}

static void testSuggestionsHelpers(void) {
  NSDictionary *defaults = RBSuggestionsParseSettings(nil);
  CHECK([defaults[@"enabled"] boolValue] && [defaults[@"aiEnabled"] boolValue] && [defaults[@"quickPhrases"] count] == 0);
  NSDictionary *parsed = RBSuggestionsParseSettings(@{ @"enabled" : @NO, @"aiEnabled" : @NO,
    @"quickPhrases" : @[ @{ @"id" : @"p_1", @"text" : @" 继续 " }, @"总结一下", NSNull.null, @{ @"text" : @"null" } ] });
  CHECK(![parsed[@"enabled"] boolValue] && ![parsed[@"aiEnabled"] boolValue]);
  CHECK([parsed[@"quickPhrases"] count] == 2 && [parsed[@"quickPhrases"][0][@"text"] isEqualToString:@"继续"]);
  // Only model output counts as AI suggestions; no static presets / fallbacks.
  CHECK(RBSuggestionsAIFromResponse(@{ @"source" : @"model-error", @"aiSuggestions" : @[ @"x" ] }).count == 0);
  CHECK(RBSuggestionsAIFromResponse(@{ @"source" : @"phrases-only", @"suggestions" : @[ @"继续" ] }).count == 0);
  NSArray *ai = RBSuggestionsAIFromResponse(@{ @"source" : @"model", @"aiSuggestions" : @[ @"a", @"b", @"c", @"d", @"e", @"" ] });
  CHECK(ai.count == 4);
  NSArray *items = RBSuggestionsMergeItems(@[ @{ @"text" : @"继续" }, @"Summarize" ], @[ @"summarize", @"列出失败的用例" ]);
  CHECK(items.count == 3);
  CHECK([items[0][@"type"] isEqualToString:@"phrase"] && [items[1][@"type"] isEqualToString:@"phrase"]);
  CHECK([items[2][@"type"] isEqualToString:@"ai"] && [items[2][@"text"] isEqualToString:@"列出失败的用例"]);
  CHECK(RBSuggestionsMergeItems(@[], @[]).count == 0);
  // Composer filter: Bot names such as "Research Analyst" must not look like a search box.
  CHECK(RBSuggestionsPlaceholderAllowed(@"Message Research Analyst"));
  CHECK(RBSuggestionsPlaceholderAllowed(@"给 Research Analyst 发消息"));
  CHECK(!RBSuggestionsPlaceholderAllowed(@"Search chats"));
  CHECK(!RBSuggestionsPlaceholderAllowed(@"搜索"));
  CHECK(!RBSuggestionsPlaceholderAllowed(@"Bot name"));
  NSDictionary *body = RBSuggestionsSendBody(@"bot-1", @" 继续 ", @"nonce-1");
  CHECK([body[@"agentId"] isEqualToString:@"bot-1"] && [body[@"prompt"] isEqualToString:@"继续"]);
  CHECK([body[@"clientNonce"] isEqualToString:@"nonce-1"] && [body[@"directAddressedAcceptance"] boolValue]);
  CHECK([RBSuggestionsSendBody(@"bot-1", @"x", nil)[@"clientNonce"] length] > 0);
  BOOL turn = NO;
  NSData *open = [@"{\"id\":\"bot_A-1\"}" dataUsingEncoding:NSUTF8StringEncoding];
  CHECK([RBSuggestionsAgentFromRequest(@"/api/openAgentWindowed", open, &turn) isEqualToString:@"bot_A-1"] && turn);
  NSData *tail = [@"{\"id\":\"bot-2\",\"limit\":12}" dataUsingEncoding:NSUTF8StringEncoding];
  CHECK([RBSuggestionsAgentFromRequest(@"/api/getAgentTranscriptTail", tail, &turn) isEqualToString:@"bot-2"] && !turn);
  NSData *send = [@"{\"agentId\":\"bot-3\",\"prompt\":\"hi\"}" dataUsingEncoding:NSUTF8StringEncoding];
  CHECK([RBSuggestionsAgentFromRequest(@"/api/sendPrompt", send, &turn) isEqualToString:@"bot-3"] && turn);
  CHECK(RBSuggestionsAgentFromRequest(@"/api/listAgents", send, &turn) == nil);
  CHECK(RBSuggestionsAgentFromRequest(@"/api/getAgent", [@"{\"id\":\"../etc\"}" dataUsingEncoding:NSUTF8StringEncoding], &turn) == nil);
  NSArray *phrases = @[ @{ @"id" : @"p_1", @"text" : @"继续" }, @{ @"id" : @"p_2", @"text" : @"总结" } ];
  CHECK(RBSuggestionsValidatePhrase(@"  ", phrases, nil, YES) != nil);
  CHECK([RBSuggestionsValidatePhrase(@"继续", phrases, nil, YES) isEqualToString:@"常用语不能重复"]);
  CHECK(RBSuggestionsValidatePhrase(@"继续", phrases, @"p_1", YES) == nil);
  CHECK(RBSuggestionsValidatePhrase([@"" stringByPaddingToLength:121 withString:@"字" startingAtIndex:0], phrases, nil, YES) != nil);
  CHECK(RBSuggestionsValidatePhrase([@"" stringByPaddingToLength:120 withString:@"字" startingAtIndex:0], phrases, nil, YES) == nil);
  CHECK([RBSuggestionsMovedIds(phrases, 1, -1) isEqualToArray:(@[ @"p_2", @"p_1" ])]);
  CHECK(RBSuggestionsMovedIds(phrases, 0, -1) == nil && RBSuggestionsMovedIds(phrases, 1, 1) == nil);
  puts("PASS: RBSuggestions settings parsing, model-only AI, merge order & de-dup, composer filter, click-to-send body, agent observation & phrase validation");
}

static void testGroupCreateHelpers(void) {
  CHECK(RBGroupMaxBots == 6 && RBGroupMaxNameLength == 72);
  CHECK([RBGroupNormalizeName(@"  A \n  B\tC ") isEqualToString:@"A B C"]);
  NSString *longName = [@"" stringByPaddingToLength:90 withString:@"x" startingAtIndex:0];
  CHECK(RBGroupNormalizeName(longName).length == 72);
  CHECK([RBGroupNormalizeForMatch(@"Ré-Search  Bot!") isEqualToString:@"re search bot"]);
  NSArray *bots = RBGroupEligibleBots(@[
    @{ @"id" : @"a", @"name" : @"Research Analyst", @"title" : @"资料" },
    @{ @"id" : @"b", @"name" : @"Design Reviewer", @"description" : @"UI review" },
    @{ @"id" : @"g", @"name" : @"Team", @"isGroup" : @YES },
    @{ @"id" : @"h", @"name" : @"Hidden", @"isHiddenFromSidebar" : @YES },
    @{ @"id" : @"a", @"name" : @"Duplicate" },
    @{ @"name" : @"No ID" },
  ]);
  CHECK(bots.count == 2 && [bots[1][@"subtitle"] isEqualToString:@"UI review"]);
  CHECK(RBGroupEligibleBots(@{ @"agents" : @[ @{ @"id" : @"x", @"name" : @"X" } ] }).count == 1);
  NSArray *ranked = RBGroupFilterCandidates(bots, @[], @"rev");
  CHECK(ranked.count == 1 && [ranked[0][@"id"] isEqualToString:@"b"]);
  CHECK(RBGroupFilterCandidates(bots, @[ RBGroupRecipientFromBot(bots[0]) ], @"").count == 1);
  CHECK(RBGroupFilterCandidates(bots, @[], @"ui").count == 1);
  CHECK(!RBGroupCanOfferNewBot(bots, @[], @"research analyst"));
  CHECK(RBGroupCanOfferNewBot(bots, @[], @"LaunchBot"));
  CHECK(!RBGroupCanOfferNewBot(bots, @[ RBGroupRecipientNewBot(@"LaunchBot") ], @"launchbot"));
  NSMutableArray *selected = [NSMutableArray array];
  CHECK(RBGroupCanAddRecipient(selected, RBGroupRecipientFromBot(bots[0])));
  [selected addObject:RBGroupRecipientFromBot(bots[0])];
  CHECK(!RBGroupCanAddRecipient(selected, RBGroupRecipientFromBot(bots[0])));
  CHECK(!RBGroupCanAddRecipient(selected, RBGroupRecipientNewBot(@"research analyst")));
  CHECK(!RBGroupCanAddRecipient(selected, RBGroupRecipientNewBot(@"   ")));
  for (int i = 0; i < 5; i++) [selected addObject:RBGroupRecipientNewBot([NSString stringWithFormat:@"Bot %d", i])];
  CHECK(selected.count == 6 && !RBGroupCanAddRecipient(selected, RBGroupRecipientNewBot(@"Seventh")));
  CHECK(!RBGroupCanOfferNewBot(bots, selected, @"Seventh") && RBGroupCanSubmit(selected, NO) && !RBGroupCanSubmit(selected, YES));
  CHECK(!RBGroupCanSubmit(@[], NO));
  NSArray *two = @[ RBGroupRecipientFromBot(bots[0]), RBGroupRecipientFromBot(bots[1]) ];
  NSArray *three = [two arrayByAddingObject:RBGroupRecipientNewBot(@"LaunchBot")];
  CHECK([RBGroupFormatList(@[ @"A", @"B", @"C" ], YES, NO) isEqualToString:@"A、B和C"]);
  CHECK([RBGroupFormatList(@[ @"A", @"B", @"C" ], NO, NO) isEqualToString:@"A, B, and C"]);
  CHECK([RBGroupComposerNames(two, YES) isEqualToString:@"Research Analyst和Design Reviewer"]);
  CHECK([RBGroupAutoName(two, nil, NO) isEqualToString:@"Research Analyst and Design Reviewer"]);
  CHECK([RBGroupAutoName(@[ two[0] ], @"Alex", YES) isEqualToString:@"Research Analyst、Alex"]);
  CHECK([RBGroupAutoName(three, @"Alex", NO) isEqualToString:@"Alex, Research Analyst, Design Reviewer, LaunchBot"]);
  CHECK([RBGroupCreatedId(@{ @"agent" : @{ @"id" : @"g-1" } }) isEqualToString:@"g-1"]);
  CHECK([RBGroupCreatedId(@{ @"id" : @"g-2" }) isEqualToString:@"g-2"] && RBGroupCreatedId(nil).length == 0);
  NSDictionary *body = RBGroupCreateBody(@" Team ", @[ @"a", @"a", @" b ", @"" ]);
  CHECK([body[@"name"] isEqualToString:@"Team"] && [body[@"description"] isEqualToString:@""]);
  CHECK([body[@"memberAgentIds"] isEqualToArray:(@[ @"a", @"b" ])]);
  CHECK(RBGroupIsNewChatLabel(@"新建对话") && RBGroupIsNewChatLabel(@" New chat ") && RBGroupIsNewChatLabel(@"New Bot"));
  CHECK(!RBGroupIsNewChatLabel(@"New group") && !RBGroupIsNewChatLabel(@"Library"));
  puts("PASS: RBGroupCreate Desktop rules (eligible Bots, ranking, inline new Bot, 6-Bot cap, auto name & 72-char cap, createGroup body)");
}

int main(void) {
  @autoreleasepool {
    testDeviceIdentity();
    testModelsHelpers();
    testUpdaterHelpers();
    testScenarioRouteHelpers();
    testSuggestionsHelpers();
    testGroupCreateHelpers();
  }
  return 0;
}
