#import "RBUpdater.h"
#import <CommonCrypto/CommonDigest.h>
#import <TargetConditionals.h>
#import <arpa/inet.h>

static NSString *RBUpdaterTrimmed(id value) {
  if (![value isKindOfClass:NSString.class])
    return @"";
  return [(NSString *)value
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

NSString *RBUpdaterPercentEncodeQueryValue(NSString *value) {
  if (![value isKindOfClass:NSString.class] || !value.length)
    return @"";
  static NSCharacterSet *unreserved;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    unreserved = [NSCharacterSet
        characterSetWithCharactersInString:
            @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"];
  });
  return [value stringByAddingPercentEncodingWithAllowedCharacters:unreserved] ?: @"";
}

NSURL *RBUpdaterResolveURL(NSString *rawUrl, NSString *baseServerURL) {
  NSString *trimmed = RBUpdaterTrimmed(rawUrl);
  if (!trimmed.length)
    return nil;
  NSURL *direct = [NSURL URLWithString:trimmed];
  if (direct.scheme.length)
    return direct;
  NSString *base = RBUpdaterTrimmed(baseServerURL);
  if (!base.length)
    return nil;
  NSURL *baseURL = [NSURL URLWithString:base];
  if (!baseURL)
    return nil;
  return [NSURL URLWithString:trimmed relativeToURL:baseURL].absoluteURL;
}

NSURL *RBUpdaterBuildItmsServicesURL(NSString *rawUrl, NSString *baseServerURL) {
  NSString *trimmed = RBUpdaterTrimmed(rawUrl);
  if (!trimmed.length)
    return nil;
  if ([trimmed.lowercaseString hasPrefix:@"itms-services://"])
    return [NSURL URLWithString:trimmed];
  NSURL *resolved = RBUpdaterResolveURL(trimmed, baseServerURL);
  if (!resolved.absoluteString.length)
    return nil;
  NSString *encoded = RBUpdaterPercentEncodeQueryValue(resolved.absoluteString);
  return [NSURL
      URLWithString:[NSString stringWithFormat:@"itms-services://?action=download-manifest&url=%@",
                                               encoded]];
}

NSURL *RBUpdaterBuildSourceSchemeURL(NSString *scheme, NSString *rawUrl, NSString *baseServerURL) {
  NSString *cleanScheme = RBUpdaterTrimmed(scheme).lowercaseString;
  NSString *trimmed = RBUpdaterTrimmed(rawUrl);
  if (!cleanScheme.length || !trimmed.length)
    return nil;
  NSString *prefix = [cleanScheme stringByAppendingString:@"://"];
  if ([trimmed.lowercaseString hasPrefix:prefix])
    return [NSURL URLWithString:trimmed];
  NSURL *resolved = RBUpdaterResolveURL(trimmed, baseServerURL);
  if (!resolved.absoluteString.length)
    return nil;
  NSString *encoded = RBUpdaterPercentEncodeQueryValue(resolved.absoluteString);
  return [NSURL URLWithString:[NSString stringWithFormat:@"%@://source?url=%@", cleanScheme, encoded]];
}

static NSArray<NSNumber *> *RBUpdaterVersionSegments(NSString *version, NSString **prereleaseOut) {
  NSString *clean = RBUpdaterTrimmed(version);
  if ([clean.lowercaseString hasPrefix:@"v"])
    clean = [clean substringFromIndex:1];
  NSRange plus = [clean rangeOfString:@"+"];
  if (plus.location != NSNotFound)
    clean = [clean substringToIndex:plus.location];
  NSString *pre = @"";
  NSRange dash = [clean rangeOfString:@"-"];
  if (dash.location != NSNotFound) {
    pre = [clean substringFromIndex:dash.location + 1];
    clean = [clean substringToIndex:dash.location];
  }
  if (prereleaseOut)
    *prereleaseOut = pre;
  if (!clean.length)
    return @[];
  NSArray<NSString *> *parts = [clean componentsSeparatedByString:@"."];
  NSMutableArray<NSNumber *> *nums = [NSMutableArray arrayWithCapacity:parts.count];
  for (NSString *part in parts) {
    [nums addObject:@(MAX(0, part.integerValue))];
  }
  return nums;
}

static BOOL RBUpdaterIsDigitsOnly(NSString *s) {
  if (!s.length)
    return NO;
  for (NSUInteger i = 0; i < s.length; i++) {
    unichar c = [s characterAtIndex:i];
    if (c < '0' || c > '9')
      return NO;
  }
  return YES;
}

static NSComparisonResult RBUpdaterComparePrerelease(NSString *remotePre, NSString *localPre) {
  if (!remotePre.length && !localPre.length)
    return NSOrderedSame;
  if (!remotePre.length && localPre.length)
    return NSOrderedDescending;
  if (remotePre.length && !localPre.length)
    return NSOrderedAscending;
  NSArray<NSString *> *rParts = [remotePre componentsSeparatedByString:@"."];
  NSArray<NSString *> *lParts = [localPre componentsSeparatedByString:@"."];
  NSUInteger count = MIN(rParts.count, lParts.count);
  for (NSUInteger i = 0; i < count; i++) {
    NSString *rp = rParts[i];
    NSString *lp = lParts[i];
    if ([rp isEqualToString:lp])
      continue;
    BOOL rNum = RBUpdaterIsDigitsOnly(rp);
    BOOL lNum = RBUpdaterIsDigitsOnly(lp);
    if (rNum && lNum) {
      NSComparisonResult cmp = [rp compare:lp options:NSNumericSearch];
      if (cmp != NSOrderedSame)
        return cmp;
    } else if (rNum != lNum) {
      // SemVer 2.0.0: numeric identifiers have lower precedence than non-numeric.
      return rNum ? NSOrderedAscending : NSOrderedDescending;
    } else {
      NSComparisonResult cmp = [rp compare:lp options:NSLiteralSearch];
      if (cmp != NSOrderedSame)
        return cmp;
    }
  }
  if (rParts.count > lParts.count)
    return NSOrderedDescending;
  if (rParts.count < lParts.count)
    return NSOrderedAscending;
  return NSOrderedSame;
}

NSComparisonResult RBUpdaterCompareVersionAndBuild(NSString *remoteVersion,
                                                   NSString *remoteBuild,
                                                   NSString *localVersion,
                                                   NSString *localBuild) {
  NSString *rPre = @"";
  NSString *lPre = @"";
  NSArray<NSNumber *> *rSegs = RBUpdaterVersionSegments(remoteVersion, &rPre);
  NSArray<NSNumber *> *lSegs = RBUpdaterVersionSegments(localVersion, &lPre);
  NSUInteger count = MAX(rSegs.count, lSegs.count);
  for (NSUInteger i = 0; i < count; i++) {
    NSInteger rv = i < rSegs.count ? rSegs[i].integerValue : 0;
    NSInteger lv = i < lSegs.count ? lSegs[i].integerValue : 0;
    if (rv > lv)
      return NSOrderedDescending;
    if (rv < lv)
      return NSOrderedAscending;
  }
  NSString *rb = RBUpdaterTrimmed(remoteBuild);
  NSString *lb = RBUpdaterTrimmed(localBuild);
  if (rb.length && lb.length) {
    NSComparisonResult buildCmp = [rb compare:lb options:NSNumericSearch];
    if (buildCmp != NSOrderedSame)
      return buildCmp;
  }
  return RBUpdaterComparePrerelease(rPre, lPre);
}

NSDictionary *RBUpdaterParseManifest(NSDictionary *json,
                                     NSString *currentBundleId,
                                     NSString **errorMessage) {
  if (errorMessage)
    *errorMessage = nil;
  if (![json isKindOfClass:NSDictionary.class]) {
    if (errorMessage) *errorMessage = @"Invalid update manifest response.";
    return nil;
  }
  NSString *schema = RBUpdaterTrimmed(json[@"schema"]);
  if (!([schema isEqualToString:@"rokbot-ios-update/v1"] ||
        [schema isEqualToString:@"grokbot-ios-update/v1"])) {
    if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Unsupported iOS update schema: %@", schema];
    return nil;
  }
  NSDictionary *latest = json[@"latest"];
  if (![latest isKindOfClass:NSDictionary.class]) {
    if (errorMessage) *errorMessage = @"No iOS release published on Host.";
    return nil;
  }
  NSString *version = RBUpdaterTrimmed(latest[@"version"]);
  if (!version.length) {
    if (errorMessage) *errorMessage = @"Manifest is missing release version.";
    return nil;
  }
  NSString *build = @"";
  if ([latest[@"build"] isKindOfClass:NSString.class])
    build = RBUpdaterTrimmed(latest[@"build"]);
  else if ([latest[@"build"] isKindOfClass:NSNumber.class])
    build = [latest[@"build"] stringValue];

  NSString *bundleId = RBUpdaterTrimmed(latest[@"bundleId"]);
  NSString *currentId = RBUpdaterTrimmed(currentBundleId);
  BOOL bundleMismatch =
      (bundleId.length > 0 && currentId.length > 0 && ![bundleId isEqualToString:currentId]);

  NSString *sha256 = RBUpdaterTrimmed(latest[@"sha256"]).lowercaseString;
  uint64_t size = [latest[@"size"] isKindOfClass:NSNumber.class]
                      ? [latest[@"size"] unsignedLongLongValue]
                      : 0;
  NSString *releaseNotes =
      [latest[@"releaseNotes"] isKindOfClass:NSString.class] ? latest[@"releaseNotes"] : @"";
  NSDictionary *methods =
      [latest[@"installMethods"] isKindOfClass:NSDictionary.class] ? latest[@"installMethods"] : @{};

  NSString *itmsUrl = RBUpdaterTrimmed(methods[@"itmsServicesUrl"]);
  if (!itmsUrl.length)
    itmsUrl = RBUpdaterTrimmed(methods[@"manifestPlistUrl"]);
  NSString *altUrl = RBUpdaterTrimmed(methods[@"altStoreSourceUrl"]);
  NSString *ipaUrl = RBUpdaterTrimmed(methods[@"ipaDownloadUrl"]);
  if (!ipaUrl.length)
    ipaUrl = RBUpdaterTrimmed(latest[@"ipaUrl"]);

  if (errorMessage)
    *errorMessage = nil;
  return @{
    @"schema" : schema,
    @"version" : version,
    @"build" : build,
    @"bundleId" : bundleId,
    @"bundleIdMismatch" : @(bundleMismatch),
    @"sha256" : sha256,
    @"size" : @(size),
    @"releaseNotes" : releaseNotes,
    @"installMethods" : methods,
    @"itmsServicesUrl" : itmsUrl,
    @"altStoreSourceUrl" : altUrl,
    @"ipaDownloadUrl" : ipaUrl
  };
}

BOOL RBUpdaterIsItmsURLReachableOutsideSandbox(NSURL *manifestPlistURL, NSString **warningReason) {
  if (!manifestPlistURL) {
    if (warningReason)
      *warningReason = @"Missing manifest.plist URL.";
    return NO;
  }
  NSString *scheme = manifestPlistURL.scheme.lowercaseString;
  if ([scheme isEqualToString:@"itms-services"]) {
    NSURLComponents *comps = [NSURLComponents componentsWithURL:manifestPlistURL resolvingAgainstBaseURL:NO];
    for (NSURLQueryItem *item in comps.queryItems) {
      if ([item.name isEqualToString:@"url"] && item.value.length) {
        manifestPlistURL = [NSURL URLWithString:item.value];
        scheme = manifestPlistURL.scheme.lowercaseString;
        break;
      }
    }
  }
  if (![scheme isEqualToString:@"https"]) {
    if (warningReason)
      *warningReason = @"Apple itms-services requires trusted HTTPS (HTTP is rejected by itunesstored).";
    return NO;
  }
  NSString *host = manifestPlistURL.host.lowercaseString;
  while ([host hasSuffix:@"."])
    host = [host substringToIndex:host.length - 1];
  BOOL isLoopback = (!host.length || [host isEqualToString:@"localhost"] ||
                     [host hasSuffix:@".localhost"] || [host isEqualToString:@"0.0.0.0"] ||
                     [host isEqualToString:@"::1"] || [host isEqualToString:@"::ffff:127.0.0.1"]);
  if (!isLoopback) {
    struct in_addr v4;
    struct in6_addr v6;
    if (inet_pton(AF_INET, host.UTF8String, &v4) == 1) {
      uint32_t addr = ntohl(v4.s_addr);
      if ((addr >> 24) == 127 || addr == 0)
        isLoopback = YES;
    } else if (inet_pton(AF_INET6, host.UTF8String, &v6) == 1) {
      if (IN6_IS_ADDR_LOOPBACK(&v6) || IN6_IS_ADDR_UNSPECIFIED(&v6)) {
        isLoopback = YES;
      } else if (IN6_IS_ADDR_V4MAPPED(&v6)) {
        uint8_t a = v6.s6_addr[12];
        uint8_t b = v6.s6_addr[13];
        uint8_t c = v6.s6_addr[14];
        uint8_t d = v6.s6_addr[15];
        if (a == 127 || (a == 0 && b == 0 && c == 0 && d == 0))
          isLoopback = YES;
      }
    }
  }
  if (isLoopback) {
    if (warningReason)
      *warningReason = @"Apple itunesstored runs outside RokBot's sandbox and cannot reach Tailcat 127.0.0.1 loopback URLs.";
    return NO;
  }
  if (warningReason)
    *warningReason = nil;
  return YES;
}

static NSInteger RBUpdaterEffectivePort(NSURL *url) {
  if (url.port)
    return url.port.integerValue;
  NSString *scheme = url.scheme.lowercaseString;
  if ([scheme isEqualToString:@"https"])
    return 443;
  if ([scheme isEqualToString:@"http"])
    return 80;
  return -1;
}

BOOL RBUpdaterShouldAttachBearerAuth(NSURL *targetURL, NSString *baseServerURL) {
  if (!targetURL)
    return NO;
  NSString *cleanBase = RBUpdaterTrimmed(baseServerURL);
  if (!cleanBase.length)
    return NO;
  NSURL *baseURL = [NSURL URLWithString:cleanBase];
  if (!baseURL || !baseURL.scheme.length || !baseURL.host.length)
    return NO;
  BOOL sameScheme = [targetURL.scheme.lowercaseString isEqualToString:baseURL.scheme.lowercaseString];
  BOOL sameHost = [targetURL.host.lowercaseString isEqualToString:baseURL.host.lowercaseString];
  BOOL samePort = RBUpdaterEffectivePort(targetURL) == RBUpdaterEffectivePort(baseURL);
  return sameScheme && sameHost && samePort;
}

NSString *RBUpdaterFileSHA256(NSURL *fileURL, NSError **error) {
  if (!fileURL.isFileURL) {
    if (error)
      *error = [NSError errorWithDomain:@"RokBotUpdater"
                                   code:1
                               userInfo:@{NSLocalizedDescriptionKey : @"Invalid file URL."}];
    return nil;
  }
  NSInputStream *stream = [NSInputStream inputStreamWithURL:fileURL];
  if (!stream) {
    if (error)
      *error = [NSError errorWithDomain:@"RokBotUpdater"
                                   code:2
                               userInfo:@{NSLocalizedDescriptionKey : @"Unable to open file."}];
    return nil;
  }
  [stream open];
  CC_SHA256_CTX ctx;
  CC_SHA256_Init(&ctx);
  uint8_t buffer[65536];
  NSInteger readCount = 0;
  while ((readCount = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
    CC_SHA256_Update(&ctx, buffer, (CC_LONG)readCount);
  }
  NSError *streamError = stream.streamError;
  [stream close];
  if (readCount < 0 || streamError) {
    if (error)
      *error = streamError ?: [NSError errorWithDomain:@"RokBotUpdater"
                                                  code:3
                                              userInfo:@{NSLocalizedDescriptionKey : @"Failed reading file."}];
    return nil;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &ctx);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger i = 0; i < CC_SHA256_DIGEST_LENGTH; i++)
    [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

BOOL RBUpdaterVerifyFileSHA256(NSURL *fileURL,
                               NSString *expectedHex,
                               uint64_t expectedSize,
                               NSError **error) {
  NSDictionary *attrs = [NSFileManager.defaultManager attributesOfItemAtPath:fileURL.path error:error];
  if (!attrs)
    return NO;
  if (expectedSize > 0) {
    uint64_t actualSize = [attrs[NSFileSize] unsignedLongLongValue];
    if (actualSize != expectedSize) {
      if (error)
        *error = [NSError
            errorWithDomain:@"RokBotUpdater"
                       code:4
                   userInfo:@{
                     NSLocalizedDescriptionKey : [NSString
                         stringWithFormat:@"File size mismatch (expected %llu, got %llu).",
                                          expectedSize, actualSize]
                   }];
      return NO;
    }
  }
  NSString *cleanExpected = RBUpdaterTrimmed(expectedHex).lowercaseString;
  if (expectedSize == 0 && !cleanExpected.length) {
    if (error)
      *error = [NSError errorWithDomain:@"RokBotUpdater"
                                   code:6
                               userInfo:@{NSLocalizedDescriptionKey : @"Missing expected SHA-256 and file size."}];
    return NO;
  }
  if (cleanExpected.length) {
    NSString *actualHex = RBUpdaterFileSHA256(fileURL, error);
    if (!actualHex)
      return NO;
    if (![actualHex isEqualToString:cleanExpected]) {
      if (error)
        *error = [NSError errorWithDomain:@"RokBotUpdater"
                                     code:5
                                 userInfo:@{NSLocalizedDescriptionKey : @"SHA-256 verification failed."}];
      return NO;
    }
  }
  return YES;
}

#if TARGET_OS_IOS

#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBLocalize.h"
#import "RBNetwork.h"
#import <UIKit/UIKit.h>

static NSString *const RBLastUpdateCheckKey = @"RokBotLocal.lastUpdateCheckAt";
static NSString *const RBSkippedUpdateKey = @"RokBotLocal.skippedUpdateVersion";
static const NSTimeInterval RBBackgroundCheckCooldownSeconds = 6 * 3600;
static BOOL RBBackgroundCheckInFlight = NO;

static NSString *RBUpdaterLocalVersion(void) {
  NSString *v = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
  return [v isKindOfClass:NSString.class] && v.length ? v : @"0.0.0";
}

static NSString *RBUpdaterLocalBuild(void) {
  NSString *b = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleVersion"];
  return [b isKindOfClass:NSString.class] && b.length ? b : @"0";
}

void RBCheckUpdatesInBackgroundIfNeeded(void) {
  NSString *base = RBConnection.shared.serverURL;
  NSString *token = RBConnection.shared.deviceToken;
  if (!base.length || !token.length || RBBackgroundCheckInFlight)
    return;
  UIViewController *top = RBTopController();
  if (!top || top.presentedViewController != nil || [top isKindOfClass:UIAlertController.class])
    return;
  NSTimeInterval now = NSDate.date.timeIntervalSince1970;
  NSTimeInterval last = [NSUserDefaults.standardUserDefaults doubleForKey:RBLastUpdateCheckKey];
  if (last > 0 && (now - last) < RBBackgroundCheckCooldownSeconds)
    return;

  RBBackgroundCheckInFlight = YES;
  NSMutableURLRequest *req = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[base stringByAppendingString:@"/local/updates/ios.json"]]];
  req.timeoutInterval = 15;
  [req setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [req setValue:@"no-store" forHTTPHeaderField:@"Cache-Control"];
  [[RBHTTPSession()
      dataTaskWithRequest:req
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          NSDictionary *json =
              data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                                 ? ((NSHTTPURLResponse *)response).statusCode
                                 : 0;
          dispatch_async(dispatch_get_main_queue(), ^{
            RBBackgroundCheckInFlight = NO;
            if (error || status != 200 || ![json isKindOfClass:NSDictionary.class])
              return;
            [NSUserDefaults.standardUserDefaults setDouble:NSDate.date.timeIntervalSince1970
                                                    forKey:RBLastUpdateCheckKey];
            if (![base isEqualToString:RBConnection.shared.serverURL] ||
                ![token isEqualToString:RBConnection.shared.deviceToken])
              return;
            NSDictionary *parsed =
                RBUpdaterParseManifest(json, NSBundle.mainBundle.bundleIdentifier, nil);
            if (!parsed)
              return;
            NSComparisonResult cmp = RBUpdaterCompareVersionAndBuild(
                parsed[@"version"], parsed[@"build"], RBUpdaterLocalVersion(), RBUpdaterLocalBuild());
            if (cmp != NSOrderedDescending)
              return;
            NSString *tag = [NSString stringWithFormat:@"%@(%@)", parsed[@"version"], parsed[@"build"]];
            if ([[NSUserDefaults.standardUserDefaults stringForKey:RBSkippedUpdateKey]
                    isEqualToString:tag])
              return;
            UIViewController *currentTop = RBTopController();
            if (!currentTop || currentTop.presentedViewController != nil ||
                [currentTop isKindOfClass:UIAlertController.class])
              return;
            UIAlertController *alert = [UIAlertController
                alertControllerWithTitle:RBL(@"发现 RokBot iOS 更新", @"RokBot iOS Update Available")
                                 message:[NSString stringWithFormat:
                                                       RBL(@"新版本 %@ (%@) 已发布在 Host 上，是否查看更新？",
                                                           @"Version %@ (%@) is available on your Host."),
                                                       parsed[@"version"], parsed[@"build"]]
                          preferredStyle:UIAlertControllerStyleAlert];
            [alert addAction:[UIAlertAction actionWithTitle:RBL(@"查看更新", @"View Update")
                                                      style:UIAlertActionStyleDefault
                                                    handler:^(UIAlertAction *a) { RBShowUpdater(); }]];
            [alert addAction:[UIAlertAction actionWithTitle:RBL(@"跳过此版本", @"Skip This Version")
                                                      style:UIAlertActionStyleCancel
                                                    handler:^(UIAlertAction *a) {
                                                      [NSUserDefaults.standardUserDefaults
                                                          setObject:tag
                                                             forKey:RBSkippedUpdateKey];
                                                    }]];
            [currentTop presentViewController:alert animated:YES completion:nil];
          });
        }] resume];
}

@interface RBUpdaterController : UITableViewController <NSURLSessionDownloadDelegate>
@property(nonatomic, copy) NSDictionary *manifest;
@property(nonatomic, copy) NSString *statusMessage;
@property(nonatomic, assign) BOOL statusIsError;
@property(nonatomic, assign) BOOL loading;
@property(nonatomic, assign) BOOL downloading;
@property(nonatomic, assign) float downloadProgress;
@property(nonatomic, strong) NSURLSession *downloadSession;
@property(nonatomic, strong) NSURLSessionDownloadTask *downloadTask;
@property(nonatomic, strong) UIProgressView *progressView;
@end

@implementation RBUpdaterController

- (instancetype)init {
  return [super initWithStyle:UITableViewStyleInsetGrouped];
}

- (void)dealloc {
  [self cancelDownloadAndInvalidateSession];
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"应用更新", @"App Updates");
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  if (self.navigationController.viewControllers.firstObject == self) {
    self.navigationItem.leftBarButtonItem =
        [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                      target:self
                                                      action:@selector(closeTapped)];
  }
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemRefresh
                                                    target:self
                                                    action:@selector(checkForUpdates)];
  self.progressView = [[UIProgressView alloc] initWithProgressViewStyle:UIProgressViewStyleDefault];
  [self checkForUpdates];
}

- (void)viewDidDisappear:(BOOL)animated {
  [super viewDidDisappear:animated];
  if (self.isMovingFromParentViewController || self.isBeingDismissed) {
    [self cancelDownloadAndInvalidateSession];
  }
}

- (void)finishAndClearDownloadSession {
  [self.downloadSession finishTasksAndInvalidate];
  self.downloadSession = nil;
  self.downloadTask = nil;
}

- (void)cancelDownloadAndInvalidateSession {
  [self.downloadTask cancel];
  self.downloadTask = nil;
  [self.downloadSession invalidateAndCancel];
  self.downloadSession = nil;
  self.downloading = NO;
}

- (void)closeTapped {
  [self dismissViewControllerAnimated:YES completion:nil];
}

- (void)checkForUpdates {
  NSString *base = RBConnection.shared.serverURL;
  NSString *token = RBConnection.shared.deviceToken;
  if (!base.length || !token.length) {
    self.statusMessage = RBL(@"请先连接 Host。", @"Connect to Host first.");
    self.statusIsError = YES;
    [self.tableView reloadData];
    return;
  }
  self.loading = YES;
  self.statusMessage = RBL(@"正在检查更新…", @"Checking for updates…");
  self.statusIsError = NO;
  [self.tableView reloadData];

  NSMutableURLRequest *req = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[base stringByAppendingString:@"/local/updates/ios.json"]]];
  req.timeoutInterval = 20;
  [req setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [req setValue:@"no-store" forHTTPHeaderField:@"Cache-Control"];
  __weak typeof(self) weak = self;
  [[RBHTTPSession()
      dataTaskWithRequest:req
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          NSDictionary *json =
              data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                                 ? ((NSHTTPURLResponse *)response).statusCode
                                 : 0;
          dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strong = weak;
            if (!strong)
              return;
            strong.loading = NO;
            if (status == 404) {
              strong.manifest = nil;
              strong.statusMessage = RBL(@"Host 尚未发布 iOS 更新包。", @"No iOS update published on this Host.");
              strong.statusIsError = NO;
              [strong.tableView reloadData];
              return;
            }
            if (error || status < 200 || status >= 300 || !json) {
              strong.manifest = nil;
              strong.statusMessage = error.localizedDescription ?:
                  [NSString stringWithFormat:RBL(@"检查更新失败 (HTTP %ld)。", @"Update check failed (HTTP %ld)."), (long)status];
              strong.statusIsError = YES;
              [strong.tableView reloadData];
              return;
            }
            NSString *parseErr = nil;
            NSDictionary *parsed =
                RBUpdaterParseManifest(json, NSBundle.mainBundle.bundleIdentifier, &parseErr);
            if (!parsed) {
              strong.manifest = nil;
              strong.statusMessage = parseErr;
              strong.statusIsError = NO;
              [strong.tableView reloadData];
              return;
            }
            strong.manifest = parsed;
            NSComparisonResult cmp = RBUpdaterCompareVersionAndBuild(
                parsed[@"version"], parsed[@"build"], RBUpdaterLocalVersion(), RBUpdaterLocalBuild());
            if (cmp == NSOrderedDescending) {
              strong.statusMessage = RBL(@"有可用更新", @"Update available");
            } else {
              strong.statusMessage = RBL(@"当前已是最新版本", @"You are up to date");
            }
            strong.statusIsError = NO;
            [NSUserDefaults.standardUserDefaults setDouble:NSDate.date.timeIntervalSince1970
                                                    forKey:RBLastUpdateCheckKey];
            [strong.tableView reloadData];
          });
        }] resume];
}

- (void)openItmsServices {
  NSString *raw = self.manifest[@"itmsServicesUrl"];
  NSString *base = RBConnection.shared.serverURL;
  NSURL *itmsURL = RBUpdaterBuildItmsServicesURL(raw, base);
  if (!itmsURL) {
    [self showAlertTitle:RBL(@"不可用", @"Unavailable")
                 message:RBL(@"Host 未提供 itms-services manifest 地址。", @"Host did not provide an itms-services manifest URL.")];
    return;
  }
  NSString *warnReason = nil;
  if (!RBUpdaterIsItmsURLReachableOutsideSandbox(itmsURL, &warnReason)) {
    UIAlertController *alert = [UIAlertController
        alertControllerWithTitle:RBL(@"OTA 安装受限", @"OTA Install Limitation")
                         message:[NSString stringWithFormat:@"%@\n\n%@",
                                     warnReason,
                                     RBL(@"建议使用下方的“下载 IPA 并分享”通过 TrollStore / AltStore / 爱思等签名安装。",
                                         @"Use 'Download IPA & Share' below for Tailcat or self-signed setups.")]
                  preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:RBL(@"仍尝试打开", @"Try Anyway")
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *a) {
                                              [self openExternalURL:itmsURL failMessage:RBL(@"系统未能打开 OTA 安装请求。", @"iOS could not open the OTA install URL.")];
                                            }]];
    [alert addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
    return;
  }
  [self openExternalURL:itmsURL
            failMessage:RBL(@"无法触发 OTA 安装，请确认系统信任 Host 的 HTTPS 证书与签名描述文件。",
                            @"Could not start OTA install. Verify trusted HTTPS and provisioning profile.")];
}

- (void)openSourceScheme:(NSString *)scheme {
  NSString *raw = self.manifest[@"altStoreSourceUrl"];
  NSURL *target = RBUpdaterBuildSourceSchemeURL(scheme, raw, RBConnection.shared.serverURL);
  if (!target) {
    [self showAlertTitle:RBL(@"不可用", @"Unavailable")
                 message:RBL(@"Host 未提供 AltStore/SideStore 源地址。", @"Host did not provide an AltStore/SideStore source URL.")];
    return;
  }
  NSString *appName = [scheme isEqualToString:@"sidestore"] ? @"SideStore" : @"AltStore";
  [self openExternalURL:target
            failMessage:[NSString stringWithFormat:
                            RBL(@"未能打开 %@（可能未安装）。你可以使用“下载 IPA 并分享”手动导入。",
                                @"Could not open %@ (may not be installed). Use 'Download IPA & Share' instead."),
                            appName]];
}

- (void)openExternalURL:(NSURL *)url failMessage:(NSString *)failMessage {
  [UIApplication.sharedApplication openURL:url
                                   options:@{}
                         completionHandler:^(BOOL success) {
                           if (!success) {
                             dispatch_async(dispatch_get_main_queue(), ^{
                               [self showAlertTitle:RBL(@"无法打开", @"Cannot Open") message:failMessage];
                             });
                           }
                         }];
}

- (void)startIpaDownload {
  if (self.downloading)
    return;
  NSString *raw = self.manifest[@"ipaDownloadUrl"];
  NSString *base = RBConnection.shared.serverURL;
  NSURL *downloadURL = RBUpdaterResolveURL(raw, base);
  if (!downloadURL) {
    [self showAlertTitle:RBL(@"不可用", @"Unavailable")
                 message:RBL(@"Host 未提供 IPA 下载地址。", @"Host did not provide an IPA download URL.")];
    return;
  }
  if (!RBNetworkEnsureReadyForURL(downloadURL)) {
    [self showAlertTitle:RBL(@"网络未就绪", @"Network Not Ready")
                 message:RBL(@"Tailcat 隧道尚未就绪，请稍后再试。", @"Tailcat tunnel is not ready yet. Try again shortly.")];
    return;
  }
  [self cancelDownloadAndInvalidateSession];

  NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  config.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
  config.HTTPShouldSetCookies = NO;
  self.downloadSession = [NSURLSession sessionWithConfiguration:config
                                                       delegate:self
                                                  delegateQueue:NSOperationQueue.mainQueue];

  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:downloadURL];
  req.timeoutInterval = 300;
  NSString *token = RBConnection.shared.deviceToken;
  if (token.length && RBUpdaterShouldAttachBearerAuth(downloadURL, base)) {
    [req setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  }

  self.downloading = YES;
  self.downloadProgress = 0;
  self.progressView.progress = 0;
  self.statusMessage = RBL(@"正在下载 IPA 安装包…", @"Downloading IPA…");
  self.statusIsError = NO;
  [self.tableView reloadData];

  self.downloadTask = [self.downloadSession downloadTaskWithRequest:req];
  [self.downloadTask resume];
}

#pragma mark - NSURLSessionDownloadDelegate

- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}

- (void)URLSession:(NSURLSession *)session
                 downloadTask:(NSURLSessionDownloadTask *)downloadTask
                 didWriteData:(int64_t)bytesWritten
            totalBytesWritten:(int64_t)totalBytesWritten
    totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {
  if (totalBytesExpectedToWrite > 0) {
    self.downloadProgress = (float)totalBytesWritten / (float)totalBytesExpectedToWrite;
    self.progressView.progress = self.downloadProgress;
  }
}

- (void)URLSession:(NSURLSession *)session
                 downloadTask:(NSURLSessionDownloadTask *)downloadTask
    didFinishDownloadingToURL:(NSURL *)location {
  NSHTTPURLResponse *http = [downloadTask.response isKindOfClass:NSHTTPURLResponse.class]
                                ? (NSHTTPURLResponse *)downloadTask.response
                                : nil;
  if (http && (http.statusCode < 200 || http.statusCode >= 300)) {
    self.downloading = NO;
    self.statusMessage = [NSString stringWithFormat:RBL(@"下载失败 (HTTP %ld)。", @"Download failed (HTTP %ld)."),
                                                    (long)http.statusCode];
    self.statusIsError = YES;
    [self.tableView reloadData];
    if (session == self.downloadSession)
      [self finishAndClearDownloadSession];
    else
      [session finishTasksAndInvalidate];
    return;
  }

  uint64_t expectedSize = [self.manifest[@"size"] unsignedLongLongValue];
  NSString *expectedSha = self.manifest[@"sha256"];
  NSError *verifyErr = nil;
  if (!RBUpdaterVerifyFileSHA256(location, expectedSha, expectedSize, &verifyErr)) {
    self.downloading = NO;
    self.statusMessage = verifyErr.localizedDescription ?: RBL(@"IPA 校验失败。", @"IPA verification failed.");
    self.statusIsError = YES;
    [self.tableView reloadData];
    [self showAlertTitle:RBL(@"校验失败", @"Verification Failed") message:self.statusMessage];
    if (session == self.downloadSession)
      [self finishAndClearDownloadSession];
    else
      [session finishTasksAndInvalidate];
    return;
  }

  NSURL *caches = [NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                       inDomains:NSUserDomainMask].firstObject;
  NSURL *updatesDir = [caches URLByAppendingPathComponent:@"RokBotUpdates" isDirectory:YES];
  [NSFileManager.defaultManager createDirectoryAtURL:updatesDir
                         withIntermediateDirectories:YES
                                          attributes:nil
                                               error:nil];
  for (NSURL *old in [NSFileManager.defaultManager contentsOfDirectoryAtURL:updatesDir
                                                 includingPropertiesForKeys:nil
                                                                    options:0
                                                                      error:nil]) {
    [NSFileManager.defaultManager removeItemAtURL:old error:nil];
  }
  NSString *ver = [self.manifest[@"version"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  NSString *bld = [self.manifest[@"build"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  NSString *fileName = bld.length ? [NSString stringWithFormat:@"RokBot-%@-%@.ipa", ver, bld]
                                  : [NSString stringWithFormat:@"RokBot-%@.ipa", ver];
  NSURL *destURL = [updatesDir URLByAppendingPathComponent:fileName];
  NSError *moveErr = nil;
  if (![NSFileManager.defaultManager moveItemAtURL:location toURL:destURL error:&moveErr]) {
    self.downloading = NO;
    self.statusMessage = moveErr.localizedDescription ?: RBL(@"保存 IPA 失败。", @"Could not save IPA.");
    self.statusIsError = YES;
    [self.tableView reloadData];
    if (session == self.downloadSession)
      [self finishAndClearDownloadSession];
    else
      [session finishTasksAndInvalidate];
    return;
  }
  [NSFileManager.defaultManager
      setAttributes:@{ NSFileProtectionKey : NSFileProtectionCompleteUntilFirstUserAuthentication }
       ofItemAtPath:destURL.path
              error:nil];

  self.downloading = NO;
  self.downloadProgress = 1.0f;
  self.statusMessage = RBL(@"IPA 下载并校验完成，请选择安装工具。", @"IPA verified. Choose an app to install.");
  self.statusIsError = NO;
  [self.tableView reloadData];

  if (session == self.downloadSession)
    [self finishAndClearDownloadSession];
  else
    [session finishTasksAndInvalidate];

  UIActivityViewController *share =
      [[UIActivityViewController alloc] initWithActivityItems:@[ destURL ] applicationActivities:nil];
  share.popoverPresentationController.sourceView = self.view;
  share.popoverPresentationController.sourceRect =
      CGRectMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds), 1, 1);
  [self presentViewController:share animated:YES completion:nil];
}

- (void)URLSession:(NSURLSession *)session
                    task:(NSURLSessionTask *)task
    didCompleteWithError:(NSError *)error {
  if (session == self.downloadSession)
    [self finishAndClearDownloadSession];
  else
    [session finishTasksAndInvalidate];
  if (!error)
    return;
  self.downloading = NO;
  if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled)
    return;
  self.statusMessage = error.localizedDescription ?: RBL(@"下载失败。", @"Download failed.");
  self.statusIsError = YES;
  [self.tableView reloadData];
}

- (void)showAlertTitle:(NSString *)title message:(NSString *)message {
  UIAlertController *a = [UIAlertController alertControllerWithTitle:title
                                                             message:message
                                                      preferredStyle:UIAlertControllerStyleAlert];
  [a addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK") style:UIAlertActionStyleDefault handler:nil]];
  [self presentViewController:a animated:YES completion:nil];
}

#pragma mark - Table View

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
  return self.manifest ? 3 : 1;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  if (section == 0)
    return self.downloading ? 3 : 2;
  if (section == 1) {
    NSInteger rows = 3; // version, sha256, release notes
    if ([self.manifest[@"bundleIdMismatch"] boolValue])
      rows++;
    return rows;
  }
  return 4; // itms-services, AltStore, SideStore, Download IPA & Share
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  if (section == 0) return RBL(@"当前版本与状态", @"Current App & Status");
  if (section == 1) return RBL(@"Host 最新发布", @"Latest Host Release");
  return RBL(@"安装方式", @"Install Methods");
}

- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
  if (section == 2) {
    return RBL(@"受 iOS 沙盒与代码签名限制，App 无法静默自我替换。OTA 安装要求受信任的 HTTPS 地址（不支持 Tailcat 127.0.0.1），或选择下载并校验 IPA 后分享至 TrollStore / AltStore / SideStore。",
               @"iOS sandboxing prevents silent self-patching. itms-services requires trusted HTTPS (Tailcat 127.0.0.1 is unsupported by itunesstored); otherwise download & share the SHA-256 verified IPA.");
  }
  return nil;
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.section == 0) {
    if (indexPath.row == 0) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleValue1 reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      cell.textLabel.text = RBL(@"本地版本", @"Installed");
      cell.detailTextLabel.text = [NSString stringWithFormat:@"%@ (%@)", RBUpdaterLocalVersion(), RBUpdaterLocalBuild()];
      return cell;
    }
    if (indexPath.row == 1) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      cell.textLabel.text = self.statusMessage ?: @"";
      cell.textLabel.numberOfLines = 0;
      cell.textLabel.textColor = self.statusIsError ? UIColor.systemRedColor : UIColor.secondaryLabelColor;
      cell.textLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
      return cell;
    }
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
    cell.selectionStyle = UITableViewCellSelectionStyleNone;
    self.progressView.translatesAutoresizingMaskIntoConstraints = NO;
    [cell.contentView addSubview:self.progressView];
    [NSLayoutConstraint activateConstraints:@[
      [self.progressView.leadingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.leadingAnchor],
      [self.progressView.trailingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.trailingAnchor],
      [self.progressView.centerYAnchor constraintEqualToAnchor:cell.contentView.centerYAnchor],
      [cell.contentView.heightAnchor constraintGreaterThanOrEqualToConstant:44]
    ]];
    return cell;
  }

  if (indexPath.section == 1) {
    NSInteger row = indexPath.row;
    if (row == 0) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleValue1 reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      cell.textLabel.text = RBL(@"最新版本", @"Latest");
      uint64_t size = [self.manifest[@"size"] unsignedLongLongValue];
      NSString *sizeStr = size > 0
          ? [NSByteCountFormatter stringFromByteCount:(long long)size countStyle:NSByteCountFormatterCountStyleFile]
          : @"";
      NSString *verStr = [NSString stringWithFormat:@"%@ (%@)", self.manifest[@"version"], self.manifest[@"build"]];
      cell.detailTextLabel.text = sizeStr.length ? [NSString stringWithFormat:@"%@ · %@", verStr, sizeStr] : verStr;
      return cell;
    }
    if (row == 1) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      cell.textLabel.text = @"SHA-256";
      NSString *sha = self.manifest[@"sha256"];
      cell.detailTextLabel.text = [sha length] ? sha : RBL(@"未提供", @"Not provided");
      cell.detailTextLabel.numberOfLines = 0;
      cell.detailTextLabel.font = [UIFont monospacedSystemFontOfSize:11 weight:UIFontWeightRegular];
      cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
      return cell;
    }
    if (row == 2) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      cell.textLabel.text = RBL(@"更新说明", @"Release Notes");
      NSString *notes = self.manifest[@"releaseNotes"];
      cell.detailTextLabel.text = [notes length] ? notes : RBL(@"无", @"None");
      cell.detailTextLabel.numberOfLines = 0;
      cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
      return cell;
    }
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
    cell.selectionStyle = UITableViewCellSelectionStyleNone;
    cell.textLabel.text = [NSString stringWithFormat:
        RBL(@"警告：远端 Bundle ID (%@) 与当前应用 (%@) 不一致，无法覆盖安装。",
            @"Warning: Remote Bundle ID (%@) differs from installed (%@); in-place upgrade will fail."),
        self.manifest[@"bundleId"], NSBundle.mainBundle.bundleIdentifier ?: @""];
    cell.textLabel.numberOfLines = 0;
    cell.textLabel.textColor = UIColor.systemOrangeColor;
    cell.textLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    return cell;
  }

  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
  if (indexPath.row == 0) {
    cell.textLabel.text = RBL(@"OTA 一键安装 (itms-services)", @"OTA Install (itms-services)");
    cell.detailTextLabel.text = RBL(@"适用于受信任 HTTPS + Ad-Hoc/企业签名", @"Trusted HTTPS + Ad-Hoc/Enterprise profile");
    cell.textLabel.textColor = [self.manifest[@"itmsServicesUrl"] length] ? self.view.tintColor : UIColor.tertiaryLabelColor;
  } else if (indexPath.row == 1) {
    cell.textLabel.text = RBL(@"添加到 AltStore 更新源", @"Open in AltStore");
    cell.detailTextLabel.text = RBL(@"使用 AltStore 自动重签名安装", @"Re-sign and install with AltStore");
    cell.textLabel.textColor = [self.manifest[@"altStoreSourceUrl"] length] ? self.view.tintColor : UIColor.tertiaryLabelColor;
  } else if (indexPath.row == 2) {
    cell.textLabel.text = RBL(@"添加到 SideStore 更新源", @"Open in SideStore");
    cell.detailTextLabel.text = RBL(@"使用 SideStore 无电脑重签名安装", @"Re-sign and install with SideStore");
    cell.textLabel.textColor = [self.manifest[@"altStoreSourceUrl"] length] ? self.view.tintColor : UIColor.tertiaryLabelColor;
  } else {
    cell.textLabel.text = self.downloading ? RBL(@"正在下载 IPA…", @"Downloading IPA…")
                                           : RBL(@"下载 IPA 并分享 (TrollStore / 文件)", @"Download IPA & Share (TrollStore / Files)");
    cell.detailTextLabel.text = RBL(@"支持 Tailcat 与鉴权端点，完成 SHA-256 校验", @"Works over Tailcat with Bearer auth + SHA-256 check");
    cell.textLabel.textColor = [self.manifest[@"ipaDownloadUrl"] length] ? self.view.tintColor : UIColor.tertiaryLabelColor;
  }
  cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
  return cell;
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  if (indexPath.section != 2)
    return;
  if (indexPath.row == 0)
    [self openItmsServices];
  else if (indexPath.row == 1)
    [self openSourceScheme:@"altstore"];
  else if (indexPath.row == 2)
    [self openSourceScheme:@"sidestore"];
  else
    [self startIpaDownload];
}

@end

void RBShowUpdaterFrom(UIViewController *presenter) {
  RBUpdaterController *vc = [RBUpdaterController new];
  if (presenter.navigationController) {
    [presenter.navigationController pushViewController:vc animated:YES];
    return;
  }
  if (presenter) {
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
    nav.modalPresentationStyle = UIModalPresentationPageSheet;
    if (@available(iOS 15.0, *)) {
      nav.sheetPresentationController.detents = @[ UISheetPresentationControllerDetent.largeDetent ];
      nav.sheetPresentationController.prefersGrabberVisible = YES;
    }
    [presenter presentViewController:nav animated:YES completion:nil];
    return;
  }
  RBPresentController(vc);
}

void RBShowUpdater(void) {
  RBShowUpdaterFrom(RBTopController());
}

#endif // TARGET_OS_IOS
