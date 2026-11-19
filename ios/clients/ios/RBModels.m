#import "RBModels.h"
#import <TargetConditionals.h>

static NSArray<NSString *> *RBModelsValidFormats(void) {
  return @[ @"openai", @"openai-responses", @"anthropic" ];
}

static NSArray<NSString *> *RBModelsValidEfforts(void) {
  return @[ @"none", @"minimal", @"low", @"medium", @"high", @"xhigh", @"max" ];
}

static NSString *RBModelsAsString(id value) {
  return [value isKindOfClass:NSString.class] ? (NSString *)value : nil;
}

static NSNumber *RBModelsAsNumber(id value) {
  return [value isKindOfClass:NSNumber.class] ? (NSNumber *)value : nil;
}

static NSDictionary *RBModelsAsDict(id value) {
  return [value isKindOfClass:NSDictionary.class] ? (NSDictionary *)value : nil;
}

static NSArray *RBModelsAsArray(id value) {
  return [value isKindOfClass:NSArray.class] ? (NSArray *)value : nil;
}

static BOOL RBModelsHasBoolOrIntValue(id value) {
  return RBModelsAsNumber(value) != nil || RBModelsAsString(value) != nil;
}

static BOOL RBModelsBoolValue(id value, BOOL fallback) {
  if ([value isKindOfClass:NSNumber.class])
    return [(NSNumber *)value boolValue];
  if ([value isKindOfClass:NSString.class])
    return [(NSString *)value boolValue];
  return fallback;
}

static NSInteger RBModelsIntValue(id value, NSInteger fallback) {
  if ([value isKindOfClass:NSNumber.class])
    return [(NSNumber *)value integerValue];
  if ([value isKindOfClass:NSString.class])
    return [(NSString *)value integerValue];
  return fallback;
}

static NSString *RBModelsTrimmedString(id value) {
  if (![value isKindOfClass:NSString.class])
    return @"";
  return [(NSString *)value
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL RBModelsHasControlChars(NSString *value) {
  for (NSUInteger i = 0; i < value.length; i++) {
    unichar c = [value characterAtIndex:i];
    if (c == '\r' || c == '\n' || c == '\0')
      return YES;
  }
  return NO;
}

static BOOL RBModelsIsValidIdentifier(NSString *value) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > 64)
    return NO;
  for (NSUInteger i = 0; i < value.length; i++) {
    unichar c = [value characterAtIndex:i];
    BOOL alnum = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    if (i == 0) {
      if (!alnum)
        return NO;
    } else if (!alnum && c != '_' && c != '-') {
      return NO;
    }
  }
  return YES;
}

static BOOL RBModelsIsValidBaseURL(NSString *raw) {
  if (!raw.length || raw.length > 2048 || RBModelsHasControlChars(raw))
    return NO;
  NSURLComponents *comp = [NSURLComponents componentsWithString:raw];
  NSString *scheme = comp.scheme.lowercaseString;
  if (!([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]))
    return NO;
  if (!comp.host.length || comp.user.length || comp.password.length || comp.query.length ||
      comp.fragment.length)
    return NO;
  return YES;
}

NSDictionary *RBModelsExtractRoutingConfig(NSDictionary *response) {
  if (![response isKindOfClass:NSDictionary.class])
    return @{};
  NSDictionary *nested = response[@"config"];
  if ([nested isKindOfClass:NSDictionary.class])
    return nested;
  return response;
}

NSDictionary *RBModelsExtractReloadState(NSDictionary *response) {
  if (![response isKindOfClass:NSDictionary.class])
    return @{};
  if ([response[@"reload"] isKindOfClass:NSDictionary.class])
    return response[@"reload"];
  NSDictionary *nested = response[@"config"];
  if ([nested isKindOfClass:NSDictionary.class] &&
      [nested[@"reload"] isKindOfClass:NSDictionary.class])
    return nested[@"reload"];
  return @{};
}

BOOL RBModelsParseNeedsModel(NSDictionary *statusResponse, BOOL *canConfigureOut) {
  BOOL canConfigure = YES;
  NSDictionary *dict = RBModelsAsDict(statusResponse);
  if (dict && RBModelsHasBoolOrIntValue(dict[@"canConfigureModel"])) {
    canConfigure = RBModelsBoolValue(dict[@"canConfigureModel"], YES);
  }
  if (canConfigureOut)
    *canConfigureOut = canConfigure;
  if (!dict)
    return NO;
  if (RBModelsHasBoolOrIntValue(dict[@"needsModel"]))
    return RBModelsBoolValue(dict[@"needsModel"], NO);
  if (RBModelsHasBoolOrIntValue(dict[@"configured"]))
    return !RBModelsBoolValue(dict[@"configured"], YES);
  return NO;
}

NSString *RBModelsDefaultBaseURLForFormat(NSString *apiFormat) {
  if ([apiFormat isEqualToString:@"anthropic"])
    return @"https://api.anthropic.com";
  return @"https://api.openai.com/v1";
}

NSString *RBModelsNormalizeIdCandidate(NSString *raw, NSString *fallbackPrefix) {
  NSString *source = RBModelsTrimmedString(raw).lowercaseString;
  NSMutableString *clean = [NSMutableString string];
  for (NSUInteger i = 0; i < source.length && clean.length < 48; i++) {
    unichar c = [source characterAtIndex:i];
    BOOL alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    if (alnum) {
      [clean appendFormat:@"%C", c];
    } else if ((c == '-' || c == '_' || c == ' ' || c == '.') && clean.length > 0 &&
               ![clean hasSuffix:@"-"]) {
      [clean appendString:@"-"];
    }
  }
  while ([clean hasSuffix:@"-"])
    [clean deleteCharactersInRange:NSMakeRange(clean.length - 1, 1)];
  if (!clean.length || !RBModelsIsValidIdentifier(clean)) {
    NSString *prefix = RBModelsIsValidIdentifier(fallbackPrefix) ? fallbackPrefix : @"item";
    NSString *suffix = [[NSUUID.UUID.UUIDString substringToIndex:6] lowercaseString];
    NSString *combined = [NSString stringWithFormat:@"%@-%@", prefix, suffix];
    if (combined.length > 64)
      combined = [combined substringToIndex:64];
    return combined;
  }
  return clean;
}

NSDictionary *RBModelsBuildSavePayload(
    NSArray<NSDictionary *> *providers,
    NSArray<NSDictionary *> *profiles,
    NSDictionary *defaultRoute,
    NSDictionary *botRoutes,
    NSDictionary *pendingApiKeys,
    BOOL migrateLegacyRouting,
    NSString **errorMessage) {
  if (errorMessage)
    *errorMessage = nil;

  if (![providers isKindOfClass:NSArray.class] || providers.count == 0) {
    if (errorMessage) *errorMessage = @"At least one model provider is required.";
    return nil;
  }
  if (![profiles isKindOfClass:NSArray.class] || profiles.count == 0) {
    if (errorMessage) *errorMessage = @"At least one model profile is required.";
    return nil;
  }

  NSMutableSet<NSString *> *providerIds = [NSMutableSet set];
  NSMutableArray<NSDictionary *> *outProviders = [NSMutableArray arrayWithCapacity:providers.count];
  for (NSDictionary *p in providers) {
    if (![p isKindOfClass:NSDictionary.class]) {
      if (errorMessage) *errorMessage = @"Invalid provider entry.";
      return nil;
    }
    NSString *pid = RBModelsTrimmedString(p[@"id"]);
    if (!RBModelsIsValidIdentifier(pid) || [providerIds containsObject:pid]) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Invalid or duplicate provider ID: %@", pid];
      return nil;
    }
    [providerIds addObject:pid];

    NSString *name = RBModelsTrimmedString(p[@"name"]);
    if (!name.length || name.length > 120 || RBModelsHasControlChars(name)) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Invalid provider name for %@", pid];
      return nil;
    }
    NSString *apiFormat = RBModelsTrimmedString(p[@"apiFormat"]);
    if (![RBModelsValidFormats() containsObject:apiFormat]) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Unsupported API format for %@", name];
      return nil;
    }
    NSString *baseUrl = RBModelsTrimmedString(p[@"baseUrl"]);
    while ([baseUrl hasSuffix:@"/"])
      baseUrl = [baseUrl substringToIndex:baseUrl.length - 1];
    if (!RBModelsIsValidBaseURL(baseUrl)) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Invalid Base URL for %@", name];
      return nil;
    }
    NSString *pendingKey =
        [pendingApiKeys isKindOfClass:NSDictionary.class] ? RBModelsTrimmedString(pendingApiKeys[pid]) : @"";
    NSString *inlineKey = RBModelsTrimmedString(p[@"apiKey"]);
    NSString *candidateKey = pendingKey.length ? pendingKey : inlineKey;
    BOOL hasExistingKey = RBModelsBoolValue(p[@"hasApiKey"], NO);
    if (!candidateKey.length && !hasExistingKey) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"API Key is required for provider \"%@\".", name];
      return nil;
    }
    if (candidateKey.length && (candidateKey.length > 8192 || RBModelsHasControlChars(candidateKey))) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Invalid API Key for provider \"%@\".", name];
      return nil;
    }

    [outProviders addObject:@{
      @"id" : pid,
      @"name" : name,
      @"apiFormat" : apiFormat,
      @"baseUrl" : baseUrl,
      @"apiKey" : candidateKey.length ? candidateKey : @""
    }];
  }

  NSMutableDictionary<NSString *, NSArray<NSString *> *> *profileEffortsMap =
      [NSMutableDictionary dictionary];
  NSMutableArray<NSDictionary *> *outProfiles = [NSMutableArray arrayWithCapacity:profiles.count];
  for (NSDictionary *prof in profiles) {
    if (![prof isKindOfClass:NSDictionary.class]) {
      if (errorMessage) *errorMessage = @"Invalid model profile entry.";
      return nil;
    }
    NSString *profId = RBModelsTrimmedString(prof[@"id"]);
    if (!RBModelsIsValidIdentifier(profId) || profileEffortsMap[profId] != nil) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Invalid or duplicate profile ID: %@", profId];
      return nil;
    }
    NSString *name = RBModelsTrimmedString(prof[@"name"]);
    if (!name.length || name.length > 120 || RBModelsHasControlChars(name)) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Invalid profile name for %@", profId];
      return nil;
    }
    NSString *providerId = RBModelsTrimmedString(prof[@"providerId"]);
    if (![providerIds containsObject:providerId]) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Profile \"%@\" references unknown provider \"%@\".", name, providerId];
      return nil;
    }
    NSString *model = RBModelsTrimmedString(prof[@"model"]);
    if (!model.length || model.length > 256 || RBModelsHasControlChars(model)) {
      if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Model ID is required for profile \"%@\".", name];
      return nil;
    }

    NSMutableArray<NSString *> *efforts = [NSMutableArray array];
    NSArray *rawEfforts = RBModelsAsArray(prof[@"efforts"]) ?: @[];
    for (NSString *level in RBModelsValidEfforts()) {
      if ([rawEfforts containsObject:level])
        [efforts addObject:level];
    }
    profileEffortsMap[profId] = efforts;

    NSInteger ctx = MAX(0, RBModelsIntValue(prof[@"contextWindowTokens"], 0));
    NSInteger threshold = MAX(0, RBModelsIntValue(prof[@"summaryThresholdTokens"], 0));
    if (ctx > 0 && threshold >= ctx)
      threshold = 0;

    [outProfiles addObject:@{
      @"id" : profId,
      @"name" : name,
      @"providerId" : providerId,
      @"model" : model,
      @"efforts" : efforts,
      @"contextWindowTokens" : @(ctx),
      @"summaryThresholdTokens" : @(threshold)
    }];
  }

  if (![defaultRoute isKindOfClass:NSDictionary.class]) {
    if (errorMessage) *errorMessage = @"Default route is required.";
    return nil;
  }
  NSString *defaultProfileId = RBModelsTrimmedString(defaultRoute[@"profileId"]);
  NSArray<NSString *> *primaryEfforts = profileEffortsMap[defaultProfileId];
  if (!primaryEfforts) {
    if (errorMessage) *errorMessage = @"Default route references an unknown profile.";
    return nil;
  }
  NSString *effort = RBModelsTrimmedString(defaultRoute[@"effort"]);
  if (!effort.length)
    effort = @"default";
  if (![effort isEqualToString:@"default"] && ![primaryEfforts containsObject:effort])
    effort = @"default";

  NSMutableSet<NSString *> *seenFallbacks = [NSMutableSet setWithObject:defaultProfileId];
  NSMutableArray<NSDictionary *> *outFallbacks = [NSMutableArray array];
  NSArray *rawFallbacks =
      [defaultRoute[@"fallbacks"] isKindOfClass:NSArray.class] ? defaultRoute[@"fallbacks"] : @[];
  for (id item in rawFallbacks) {
    if (outFallbacks.count >= 8)
      break;
    NSString *fbProfileId = nil;
    NSString *fbEffort = @"default";
    if ([item isKindOfClass:NSDictionary.class]) {
      fbProfileId = RBModelsTrimmedString(item[@"profileId"]);
      fbEffort = RBModelsTrimmedString(item[@"effort"]);
    } else if ([item isKindOfClass:NSString.class]) {
      fbProfileId = RBModelsTrimmedString(item);
    }
    if (!fbProfileId.length || [seenFallbacks containsObject:fbProfileId])
      continue;
    NSArray<NSString *> *fbEfforts = profileEffortsMap[fbProfileId];
    if (!fbEfforts)
      continue;
    [seenFallbacks addObject:fbProfileId];
    if (!fbEffort.length ||
        (![fbEffort isEqualToString:@"default"] && ![fbEfforts containsObject:fbEffort]))
      fbEffort = @"default";
    [outFallbacks addObject:@{
      @"profileId" : fbProfileId,
      @"effort" : fbEffort,
      @"order" : @(outFallbacks.count)
    }];
  }

  NSMutableDictionary *payload = [@{
    @"version" : @1,
    @"providers" : outProviders,
    @"profiles" : outProfiles,
    @"defaultRoute" : @{
      @"profileId" : defaultProfileId,
      @"effort" : effort,
      @"fallbacks" : outFallbacks
    },
    @"botRoutes" : [botRoutes isKindOfClass:NSDictionary.class] ? botRoutes : @{}
  } mutableCopy];

  if (migrateLegacyRouting)
    payload[@"migrateLegacyRouting"] = @YES;

  if (errorMessage)
    *errorMessage = nil;
  return payload;
}

#if TARGET_OS_IOS

#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBLocalize.h"
#import "RBNetwork.h"
#import <CommonCrypto/CommonDigest.h>
#import <UIKit/UIKit.h>

static BOOL RBOnboardingPromptVisible = NO;
static BOOL RBOnboardingCheckInFlight = NO;

static NSString *RBModelOnboardingScopeHash(void) {
  NSString *base = (RBNetworkAddress().length ? RBNetworkAddress() : RBConnection.shared.serverURL) ?: @"";
  NSString *deviceId = [NSUserDefaults.standardUserDefaults stringForKey:@"RokBotLocal.deviceId"] ?: @"";
  NSString *raw = [NSString stringWithFormat:@"%@\n%@", base, deviceId];
  NSData *data = [raw dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger i = 0; i < CC_SHA256_DIGEST_LENGTH; i++)
    [hex appendFormat:@"%02x", digest[i]];
  return hex;
}

static NSString *RBModelOnboardingDismissedKey(void) {
  return [@"RokBotLocal.modelOnboardingDismissed." stringByAppendingString:RBModelOnboardingScopeHash()];
}

static NSString *RBModelsLocalizedError(NSDictionary *body, NSError *error, NSInteger status) {
  if ([body isKindOfClass:NSDictionary.class] && [body[@"error"] isKindOfClass:NSString.class] &&
      [body[@"error"] length] > 0) {
    return body[@"error"];
  }
  if (error)
    return error.localizedDescription ?: RBL(@"请求失败，请检查网络连接。", @"Request failed. Check your connection.");
  if (status == 401)
    return RBL(@"设备凭证已失效，请重新配对。", @"Device credential expired. Re-pair this device.");
  if (status == 403)
    return RBL(@"需要管理员权限才能修改模型配置。", @"Administrator permission is required to configure models.");
  if (status == 429)
    return RBL(@"操作过于频繁，请稍后重试。", @"Too many requests. Try again shortly.");
  return [NSString stringWithFormat:RBL(@"Host 返回状态 %ld。", @"Host returned HTTP %ld."), (long)status];
}

void RBClearModelOnboardingState(void) {
  RBOnboardingPromptVisible = NO;
  RBOnboardingCheckInFlight = NO;
}

void RBCheckModelOnboardingIfNeeded(void) {
  NSString *base = RBConnection.shared.serverURL;
  NSString *token = RBConnection.shared.deviceToken;
  if (!base.length || !token.length || RBOnboardingCheckInFlight || RBOnboardingPromptVisible)
    return;
  RBOnboardingCheckInFlight = YES;
  NSMutableURLRequest *req = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[base stringByAppendingString:@"/local/status"]]];
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
            RBOnboardingCheckInFlight = NO;
            if (error || status != 200 || ![json isKindOfClass:NSDictionary.class])
              return;
            if (![base isEqualToString:RBConnection.shared.serverURL] ||
                ![token isEqualToString:RBConnection.shared.deviceToken])
              return;
            BOOL canConfigure = YES;
            BOOL needsModel = RBModelsParseNeedsModel(json, &canConfigure);
            NSString *dismissKey = RBModelOnboardingDismissedKey();
            if (!needsModel) {
              [NSUserDefaults.standardUserDefaults removeObjectForKey:dismissKey];
              return;
            }
            if ([NSUserDefaults.standardUserDefaults boolForKey:dismissKey])
              return;
            UIViewController *top = RBTopController();
            if (!top || top.presentedViewController != nil ||
                [top isKindOfClass:UIAlertController.class] || RBOnboardingPromptVisible)
              return;
            RBOnboardingPromptVisible = YES;
            NSString *message = canConfigure
                ? RBL(@"当前 Host 还没有配置可用的对话模型。是否现在在 App 内完成模型配置？",
                      @"This Host does not have a model configured yet. Would you like to configure one now?")
                : RBL(@"当前 Host 还没有配置对话模型。请联系管理员或在配对时使用管理员密码完成配置。",
                      @"This Host does not have a model configured yet. Ask an admin or pair with admin password.");
            UIAlertController *alert = [UIAlertController
                alertControllerWithTitle:RBL(@"尚未配置模型", @"No Model Configured")
                                 message:message
                          preferredStyle:UIAlertControllerStyleAlert];
            if (canConfigure) {
              [alert addAction:[UIAlertAction
                                   actionWithTitle:RBL(@"立即配置", @"Configure Now")
                                             style:UIAlertActionStyleDefault
                                           handler:^(UIAlertAction *a) {
                                             RBOnboardingPromptVisible = NO;
                                             RBShowModels();
                                           }]];
            }
            [alert addAction:[UIAlertAction
                                 actionWithTitle:canConfigure ? RBL(@"稍后", @"Later") : RBL(@"知道了", @"OK")
                                           style:UIAlertActionStyleCancel
                                         handler:^(UIAlertAction *a) {
                                           RBOnboardingPromptVisible = NO;
                                           [NSUserDefaults.standardUserDefaults setBool:YES forKey:dismissKey];
                                         }]];
            [top presentViewController:alert animated:YES completion:nil];
          });
        }] resume];
}

// Forward declarations for sub-editors
@class RBModelsController;

@interface RBModelCatalogPickerController : UITableViewController <UISearchResultsUpdating>
@property(nonatomic, copy) NSArray<NSDictionary *> *allModels;
@property(nonatomic, copy) NSArray<NSDictionary *> *filteredModels;
@property(nonatomic, strong) UISearchController *searchController;
@property(nonatomic, copy) void (^onSelect)(NSDictionary *modelEntry);
@end

@implementation RBModelCatalogPickerController
- (instancetype)initWithModels:(NSArray<NSDictionary *> *)models onSelect:(void (^)(NSDictionary *))onSelect {
  self = [super initWithStyle:UITableViewStyleInsetGrouped];
  if (self) {
    _allModels = [models copy] ?: @[];
    _filteredModels = _allModels;
    _onSelect = [onSelect copy];
  }
  return self;
}
- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"选择模型", @"Choose Model");
  self.searchController = [[UISearchController alloc] initWithSearchResultsController:nil];
  self.searchController.searchResultsUpdater = self;
  self.searchController.obscuresBackgroundDuringPresentation = NO;
  self.searchController.searchBar.placeholder = RBL(@"搜索模型 ID", @"Filter model ID");
  self.navigationItem.searchController = self.searchController;
  self.navigationItem.hidesSearchBarWhenScrolling = NO;
}
- (void)updateSearchResultsForSearchController:(UISearchController *)searchController {
  NSString *q = RBModelsTrimmedString(searchController.searchBar.text).lowercaseString;
  if (!q.length) {
    self.filteredModels = self.allModels;
  } else {
    NSMutableArray *matches = [NSMutableArray array];
    for (NSDictionary *entry in self.allModels) {
      NSString *mid = [entry[@"id"] isKindOfClass:NSString.class] ? [entry[@"id"] lowercaseString] : @"";
      if ([mid containsString:q])
        [matches addObject:entry];
    }
    self.filteredModels = matches;
  }
  [self.tableView reloadData];
}
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return MAX(1, (NSInteger)self.filteredModels.count);
}
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"ModelCatalogCell"];
  if (!cell)
    cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:@"ModelCatalogCell"];
  if (!self.filteredModels.count) {
    cell.textLabel.text = RBL(@"没有匹配的模型", @"No matching models");
    cell.detailTextLabel.text = nil;
    cell.selectionStyle = UITableViewCellSelectionStyleNone;
    return cell;
  }
  NSDictionary *entry = RBModelsAsDict(self.filteredModels[indexPath.row]);
  cell.textLabel.text = RBModelsAsString(entry[@"id"]) ?: @"";
  NSArray *rawEfforts = RBModelsAsArray(entry[@"efforts"]) ?: @[];
  NSMutableArray<NSString *> *efforts = [NSMutableArray array];
  for (id item in rawEfforts) {
    NSString *s = RBModelsAsString(item);
    if (s.length)
      [efforts addObject:s];
  }
  NSInteger ctx = RBModelsIntValue(entry[@"contextWindowTokens"], 0);
  NSMutableArray *parts = [NSMutableArray array];
  if (ctx > 0)
    [parts addObject:[NSString stringWithFormat:@"%ldk ctx", (long)(ctx / 1000)]];
  if (efforts.count)
    [parts addObject:[efforts componentsJoinedByString:@","]];
  cell.detailTextLabel.text = [parts componentsJoinedByString:@" · "];
  cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
  cell.selectionStyle = UITableViewCellSelectionStyleDefault;
  return cell;
}
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  if (!self.filteredModels.count || indexPath.row < 0 ||
      indexPath.row >= (NSInteger)self.filteredModels.count)
    return;
  NSDictionary *entry = RBModelsAsDict(self.filteredModels[indexPath.row]);
  if (!entry)
    return;
  void (^callback)(NSDictionary *) = [self.onSelect copy];
  if (self.searchController.active) {
    self.searchController.active = NO;
  }
  UINavigationController *nav = self.navigationController;
  if (nav) {
    [nav popViewControllerAnimated:YES];
    id<UIViewControllerTransitionCoordinator> tc = nav.transitionCoordinator;
    if (tc) {
      [tc animateAlongsideTransition:nil
                          completion:^(id<UIViewControllerTransitionCoordinatorContext> ctx) {
                            if (callback)
                              callback(entry);
                          }];
    } else {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (callback)
          callback(entry);
      });
    }
  } else if (callback) {
    callback(entry);
  }
}
@end

@interface RBModelsController : UITableViewController
@property(nonatomic, strong) NSMutableArray<NSMutableDictionary *> *providers;
@property(nonatomic, strong) NSMutableArray<NSMutableDictionary *> *profiles;
@property(nonatomic, strong) NSMutableDictionary *defaultRoute;
@property(nonatomic, copy) NSDictionary *botRoutes;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *pendingApiKeys;
@property(nonatomic, assign) BOOL routingMigrated;
@property(nonatomic, assign) BOOL legacyAdaptiveRouting;
@property(nonatomic, assign) BOOL confirmedLegacyMigration;
@property(nonatomic, assign) BOOL configured;
@property(nonatomic, assign) BOOL needsModel;
@property(nonatomic, assign) BOOL loading;
@property(nonatomic, assign) BOOL saving;
@property(nonatomic, copy) NSDictionary *reloadState;
@property(nonatomic, strong) NSTimer *reloadPollTimer;
@property(nonatomic, assign) NSUInteger reloadPollCount;
@property(nonatomic, copy) NSString *adminPassword; // In-memory only for X-RokBot-Admin-Password step-up
@property(nonatomic, copy) NSString *statusBannerText;
@property(nonatomic, assign) BOOL statusBannerIsError;

- (NSURLSessionDataTask *)requestPath:(NSString *)path
                               method:(NSString *)method
                                 body:(NSDictionary *)body
                              timeout:(NSTimeInterval)timeout
                           completion:(void (^)(NSInteger status, NSDictionary *json, NSError *error))completion;
- (void)runPreflightTestForProfileId:(NSString *)profileId
                  candidateOverrides:(void (^)(NSMutableArray *providers, NSMutableArray *profiles, NSMutableDictionary *defaultRoute))overrides
                                from:(UIViewController *)presenter;
- (void)fetchCatalogForProvider:(NSDictionary *)provider
                   candidateKey:(NSString *)candidateKey
                           from:(UIViewController *)presenter
                       onSelect:(void (^)(NSDictionary *entry))onSelect;
@end

@interface RBModelProviderEditorController : UITableViewController
@property(nonatomic, weak) RBModelsController *parentModels;
@property(nonatomic, strong) NSMutableDictionary *provider;
@property(nonatomic, assign) BOOL isNew;
@property(nonatomic, strong) UITextField *nameField;
@property(nonatomic, strong) UISegmentedControl *formatControl;
@property(nonatomic, strong) UITextField *baseUrlField;
@property(nonatomic, strong) UITextField *apiKeyField;
@property(nonatomic, copy) void (^onSave)(NSMutableDictionary *provider, NSString *newApiKey);
@end

@implementation RBModelProviderEditorController
- (instancetype)initWithProvider:(NSMutableDictionary *)provider
                           isNew:(BOOL)isNew
                    parentModels:(RBModelsController *)parent
                          onSave:(void (^)(NSMutableDictionary *, NSString *))onSave {
  self = [super initWithStyle:UITableViewStyleInsetGrouped];
  if (self) {
    _provider = provider ? [provider mutableCopy] : [@{
      @"id" : @"",
      @"name" : @"",
      @"apiFormat" : @"openai",
      @"baseUrl" : RBModelsDefaultBaseURLForFormat(@"openai"),
      @"hasApiKey" : @NO
    } mutableCopy];
    _isNew = isNew;
    _parentModels = parent;
    _onSave = [onSave copy];
  }
  return self;
}
- (UITextField *)makeField:(NSString *)text placeholder:(NSString *)placeholder secure:(BOOL)secure {
  UITextField *f = [[UITextField alloc] initWithFrame:CGRectZero];
  f.text = text;
  f.placeholder = placeholder;
  f.secureTextEntry = secure;
  f.autocapitalizationType = UITextAutocapitalizationTypeNone;
  f.autocorrectionType = UITextAutocorrectionTypeNo;
  f.clearButtonMode = UITextFieldViewModeWhileEditing;
  f.returnKeyType = UIReturnKeyDone;
  f.translatesAutoresizingMaskIntoConstraints = NO;
  return f;
}
- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = self.isNew ? RBL(@"添加模型服务", @"Add Provider") : RBL(@"编辑模型服务", @"Edit Provider");
  self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc]
      initWithTitle:RBL(@"完成", @"Done")
              style:UIBarButtonItemStyleDone
             target:self
             action:@selector(doneTapped)];

  self.nameField = [self makeField:RBModelsAsString(self.provider[@"name"]) ?: @""
                       placeholder:RBL(@"例如 OpenAI / DeepSeek", @"e.g. OpenAI / DeepSeek")
                            secure:NO];
  NSString *fmt = RBModelsAsString(self.provider[@"apiFormat"]) ?: @"openai";
  self.formatControl = [[UISegmentedControl alloc] initWithItems:@[ @"OpenAI", @"Responses", @"Anthropic" ]];
  self.formatControl.translatesAutoresizingMaskIntoConstraints = NO;
  NSInteger idx = [RBModelsValidFormats() indexOfObject:fmt];
  self.formatControl.selectedSegmentIndex = idx == NSNotFound ? 0 : idx;
  [self.formatControl addTarget:self action:@selector(formatChanged) forControlEvents:UIControlEventValueChanged];

  self.baseUrlField = [self makeField:RBModelsAsString(self.provider[@"baseUrl"]) ?: @""
                          placeholder:RBModelsDefaultBaseURLForFormat(fmt)
                               secure:NO];
  self.baseUrlField.keyboardType = UIKeyboardTypeURL;

  NSString *pid = RBModelsAsString(self.provider[@"id"]) ?: @"";
  NSString *pendingKey = RBModelsAsString(self.parentModels.pendingApiKeys[pid]) ?: @"";
  BOOL hasKey = RBModelsBoolValue(self.provider[@"hasApiKey"], NO) || pendingKey.length > 0;
  self.apiKeyField = [self makeField:pendingKey
                         placeholder:hasKey
                                         ? RBL(@"已保存（留空则保留原 Key）", @"Saved (leave blank to keep)")
                                         : @"sk-..."
                              secure:YES];
}
- (void)formatChanged {
  NSString *selected = RBModelsValidFormats()[self.formatControl.selectedSegmentIndex];
  NSString *current = RBModelsTrimmedString(self.baseUrlField.text);
  if (!current.length || [current isEqualToString:@"https://api.openai.com/v1"] ||
      [current isEqualToString:@"https://api.anthropic.com"]) {
    self.baseUrlField.text = RBModelsDefaultBaseURLForFormat(selected);
  }
  self.baseUrlField.placeholder = RBModelsDefaultBaseURLForFormat(selected);
}
- (void)doneTapped {
  NSString *name = RBModelsTrimmedString(self.nameField.text);
  NSString *fmt = RBModelsValidFormats()[self.formatControl.selectedSegmentIndex];
  NSString *baseUrl = RBModelsTrimmedString(self.baseUrlField.text);
  while ([baseUrl hasSuffix:@"/"])
    baseUrl = [baseUrl substringToIndex:baseUrl.length - 1];
  NSString *apiKey = RBModelsTrimmedString(self.apiKeyField.text);

  if (!name.length) {
    [self showError:RBL(@"请输入模型服务名称。", @"Enter a provider name.")];
    return;
  }
  if (!RBModelsIsValidBaseURL(baseUrl)) {
    [self showError:RBL(@"请输入有效的 HTTP/HTTPS Base URL。", @"Enter a valid HTTP/HTTPS Base URL.")];
    return;
  }
  BOOL hasKey = RBModelsBoolValue(self.provider[@"hasApiKey"], NO);
  if (!apiKey.length && !hasKey) {
    [self showError:RBL(@"新建模型服务必须填写 API Key。", @"Enter an API Key for the new provider.")];
    return;
  }

  NSMutableDictionary *updated = [self.provider mutableCopy];
  if (![RBModelsAsString(updated[@"id"]) length]) {
    NSString *candidate = RBModelsNormalizeIdCandidate(name, @"provider");
    NSMutableSet *existingIds = [NSMutableSet set];
    for (NSDictionary *p in self.parentModels.providers) {
      NSString *existingPid = RBModelsAsString(p[@"id"]);
      if (existingPid.length)
        [existingIds addObject:existingPid];
    }
    NSString *unique = candidate;
    NSUInteger suffix = 2;
    while ([existingIds containsObject:unique]) {
      unique = [NSString stringWithFormat:@"%@-%lu", candidate, (unsigned long)suffix++];
    }
    updated[@"id"] = unique;
  }
  updated[@"name"] = name;
  updated[@"apiFormat"] = fmt;
  updated[@"baseUrl"] = baseUrl;
  if (self.onSave)
    self.onSave(updated, apiKey);
  [self.navigationController popViewControllerAnimated:YES];
}
- (void)showError:(NSString *)msg {
  UIAlertController *a = [UIAlertController alertControllerWithTitle:RBL(@"提示", @"Notice")
                                                             message:msg
                                                      preferredStyle:UIAlertControllerStyleAlert];
  [a addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK") style:UIAlertActionStyleDefault handler:nil]];
  [self presentViewController:a animated:YES completion:nil];
}
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return 2; }
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return section == 0 ? 4 : 1;
}
- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  return section == 0 ? RBL(@"服务配置", @"Provider Settings") : RBL(@"验证", @"Verification");
}
- (UITableViewCell *)layoutField:(UITextField *)field inTitle:(NSString *)title {
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  UILabel *lbl = [UILabel new];
  lbl.text = title;
  lbl.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  lbl.translatesAutoresizingMaskIntoConstraints = NO;
  [lbl setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [cell.contentView addSubview:lbl];
  [cell.contentView addSubview:field];
  [NSLayoutConstraint activateConstraints:@[
    [lbl.leadingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.leadingAnchor],
    [lbl.centerYAnchor constraintEqualToAnchor:cell.contentView.centerYAnchor],
    [field.leadingAnchor constraintEqualToAnchor:lbl.trailingAnchor constant:12],
    [field.trailingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.trailingAnchor],
    [field.topAnchor constraintEqualToAnchor:cell.contentView.topAnchor constant:11],
    [field.bottomAnchor constraintEqualToAnchor:cell.contentView.bottomAnchor constant:-11],
    [cell.contentView.heightAnchor constraintGreaterThanOrEqualToConstant:44]
  ]];
  return cell;
}
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.section == 0) {
    if (indexPath.row == 0)
      return [self layoutField:self.nameField inTitle:RBL(@"名称", @"Name")];
    if (indexPath.row == 1) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      [cell.contentView addSubview:self.formatControl];
      [NSLayoutConstraint activateConstraints:@[
        [self.formatControl.leadingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.leadingAnchor],
        [self.formatControl.trailingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.trailingAnchor],
        [self.formatControl.topAnchor constraintEqualToAnchor:cell.contentView.topAnchor constant:8],
        [self.formatControl.bottomAnchor constraintEqualToAnchor:cell.contentView.bottomAnchor constant:-8]
      ]];
      return cell;
    }
    if (indexPath.row == 2)
      return [self layoutField:self.baseUrlField inTitle:@"Base URL"];
    return [self layoutField:self.apiKeyField inTitle:@"API Key"];
  }
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
  cell.textLabel.text = RBL(@"拉取远端模型列表", @"Fetch Remote Models");
  cell.textLabel.textColor = self.view.tintColor;
  cell.textLabel.textAlignment = NSTextAlignmentCenter;
  return cell;
}
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  if (indexPath.section != 1)
    return;
  NSString *fmt = RBModelsValidFormats()[self.formatControl.selectedSegmentIndex];
  NSString *baseUrl = RBModelsTrimmedString(self.baseUrlField.text);
  while ([baseUrl hasSuffix:@"/"])
    baseUrl = [baseUrl substringToIndex:baseUrl.length - 1];
  NSString *rawPid = RBModelsAsString(self.provider[@"id"]);
  NSString *pid = rawPid.length ? rawPid : @"preview";
  NSDictionary *candidate = @{
    @"id" : pid,
    @"name" : RBModelsTrimmedString(self.nameField.text).length ? RBModelsTrimmedString(self.nameField.text) : @"Preview",
    @"apiFormat" : fmt,
    @"baseUrl" : baseUrl,
    @"hasApiKey" : RBModelsBoolValue(self.provider[@"hasApiKey"], NO) ? @YES : @NO
  };
  NSString *key = RBModelsTrimmedString(self.apiKeyField.text);
  [self.parentModels fetchCatalogForProvider:candidate
                                candidateKey:key
                                        from:self
                                    onSelect:^(NSDictionary *entry) {
                                      UIAlertController *ok = [UIAlertController
                                          alertControllerWithTitle:RBL(@"模型目录连接正常", @"Catalog Connected")
                                                           message:[NSString stringWithFormat:RBL(@"选中模型：%@", @"Selected model: %@"), RBModelsAsString(entry[@"id"]) ?: @""]
                                                    preferredStyle:UIAlertControllerStyleAlert];
                                      [ok addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK") style:UIAlertActionStyleDefault handler:nil]];
                                      [self presentViewController:ok animated:YES completion:nil];
                                    }];
}
@end

@interface RBModelProfileEditorController : UITableViewController
@property(nonatomic, weak) RBModelsController *parentModels;
@property(nonatomic, strong) NSMutableDictionary *profile;
@property(nonatomic, assign) BOOL isNew;
@property(nonatomic, strong) UITextField *nameField;
@property(nonatomic, strong) UITextField *modelField;
@property(nonatomic, strong) UITextField *contextField;
@property(nonatomic, strong) UITextField *summaryField;
@property(nonatomic, copy) NSString *selectedProviderId;
@property(nonatomic, strong) NSMutableSet<NSString *> *selectedEfforts;
@property(nonatomic, copy) void (^onSave)(NSMutableDictionary *profile);
@end

@implementation RBModelProfileEditorController
- (instancetype)initWithProfile:(NSMutableDictionary *)profile
                          isNew:(BOOL)isNew
                   parentModels:(RBModelsController *)parent
                         onSave:(void (^)(NSMutableDictionary *))onSave {
  self = [super initWithStyle:UITableViewStyleInsetGrouped];
  if (self) {
    NSString *defaultPid = RBModelsAsString(parent.providers.firstObject[@"id"]) ?: @"";
    _profile = profile ? [profile mutableCopy] : [@{
      @"id" : @"",
      @"name" : @"",
      @"providerId" : defaultPid,
      @"model" : @"",
      @"efforts" : @[],
      @"contextWindowTokens" : @0,
      @"summaryThresholdTokens" : @0
    } mutableCopy];
    _isNew = isNew;
    _parentModels = parent;
    _selectedProviderId = RBModelsAsString(_profile[@"providerId"]) ?: defaultPid;
    NSArray *eff = RBModelsAsArray(_profile[@"efforts"]) ?: @[];
    NSMutableSet<NSString *> *effortSet = [NSMutableSet set];
    for (id item in eff) {
      NSString *s = RBModelsAsString(item);
      if (s.length)
        [effortSet addObject:s];
    }
    _selectedEfforts = effortSet;
    _onSave = [onSave copy];
  }
  return self;
}
- (UITextField *)makeField:(NSString *)text placeholder:(NSString *)placeholder numeric:(BOOL)numeric {
  UITextField *f = [[UITextField alloc] initWithFrame:CGRectZero];
  f.text = text;
  f.placeholder = placeholder;
  f.autocapitalizationType = UITextAutocapitalizationTypeNone;
  f.autocorrectionType = UITextAutocorrectionTypeNo;
  f.clearButtonMode = UITextFieldViewModeWhileEditing;
  f.keyboardType = numeric ? UIKeyboardTypeNumberPad : UIKeyboardTypeDefault;
  f.translatesAutoresizingMaskIntoConstraints = NO;
  return f;
}
- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = self.isNew ? RBL(@"添加模型档案", @"Add Profile") : RBL(@"编辑模型档案", @"Edit Profile");
  self.navigationItem.rightBarButtonItem = [[UIBarButtonItem alloc]
      initWithTitle:RBL(@"完成", @"Done")
              style:UIBarButtonItemStyleDone
             target:self
             action:@selector(doneTapped)];
  self.nameField = [self makeField:RBModelsAsString(self.profile[@"name"]) ?: @""
                       placeholder:RBL(@"例如 默认模型", @"e.g. Primary Model")
                           numeric:NO];
  self.modelField = [self makeField:RBModelsAsString(self.profile[@"model"]) ?: @""
                        placeholder:@"gpt-4o / claude-sonnet-4-5"
                            numeric:NO];
  NSInteger ctx = RBModelsIntValue(self.profile[@"contextWindowTokens"], 0);
  NSInteger sum = RBModelsIntValue(self.profile[@"summaryThresholdTokens"], 0);
  self.contextField = [self makeField:ctx > 0 ? [NSString stringWithFormat:@"%ld", (long)ctx] : @""
                          placeholder:@"0 (auto)"
                              numeric:YES];
  self.summaryField = [self makeField:sum > 0 ? [NSString stringWithFormat:@"%ld", (long)sum] : @""
                          placeholder:@"0 (auto)"
                              numeric:YES];
}
- (NSMutableDictionary *)buildDraftProfile {
  NSMutableDictionary *updated = [self.profile mutableCopy];
  NSString *name = RBModelsTrimmedString(self.nameField.text);
  NSString *model = RBModelsTrimmedString(self.modelField.text);
  if (![RBModelsAsString(updated[@"id"]) length]) {
    NSString *candidate = RBModelsNormalizeIdCandidate(name.length ? name : model, @"profile");
    NSMutableSet *existing = [NSMutableSet set];
    for (NSDictionary *item in self.parentModels.profiles) {
      NSString *itemId = RBModelsAsString(item[@"id"]);
      if (itemId.length)
        [existing addObject:itemId];
    }
    NSString *unique = candidate;
    NSUInteger suffix = 2;
    while ([existing containsObject:unique])
      unique = [NSString stringWithFormat:@"%@-%lu", candidate, (unsigned long)suffix++];
    updated[@"id"] = unique;
  }
  updated[@"name"] = name;
  updated[@"providerId"] = self.selectedProviderId ?: @"";
  updated[@"model"] = model;
  NSMutableArray *ordered = [NSMutableArray array];
  for (NSString *level in RBModelsValidEfforts()) {
    if ([self.selectedEfforts containsObject:level])
      [ordered addObject:level];
  }
  updated[@"efforts"] = ordered;
  updated[@"contextWindowTokens"] = @(MAX(0, [RBModelsTrimmedString(self.contextField.text) integerValue]));
  updated[@"summaryThresholdTokens"] = @(MAX(0, [RBModelsTrimmedString(self.summaryField.text) integerValue]));
  return updated;
}
- (void)doneTapped {
  NSString *name = RBModelsTrimmedString(self.nameField.text);
  NSString *model = RBModelsTrimmedString(self.modelField.text);
  if (!name.length) {
    [self showAlert:RBL(@"请输入档案名称。", @"Enter a profile name.")];
    return;
  }
  if (!self.selectedProviderId.length) {
    [self showAlert:RBL(@"请选择模型服务。", @"Select a provider.")];
    return;
  }
  if (!model.length) {
    [self showAlert:RBL(@"请输入或选择模型 ID。", @"Enter or select a model ID.")];
    return;
  }
  NSMutableDictionary *updated = [self buildDraftProfile];
  if (self.onSave)
    self.onSave(updated);
  [self.navigationController popViewControllerAnimated:YES];
}
- (void)showAlert:(NSString *)msg {
  UIAlertController *a = [UIAlertController alertControllerWithTitle:RBL(@"提示", @"Notice")
                                                             message:msg
                                                      preferredStyle:UIAlertControllerStyleAlert];
  [a addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK") style:UIAlertActionStyleDefault handler:nil]];
  [self presentViewController:a animated:YES completion:nil];
}
- (NSDictionary *)providerForId:(NSString *)pid {
  for (NSDictionary *p in self.parentModels.providers)
    if ([RBModelsAsString(p[@"id"]) isEqualToString:pid])
      return p;
  return nil;
}
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return 3; }
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  if (section == 0) return 6;
  if (section == 1) return RBModelsValidEfforts().count;
  return 1;
}
- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  if (section == 0) return RBL(@"基本设置", @"Profile Settings");
  if (section == 1) return RBL(@"支持的推理强度", @"Supported Reasoning Efforts");
  return RBL(@"测试", @"Preflight Test");
}
- (UITableViewCell *)layoutField:(UITextField *)field inTitle:(NSString *)title {
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  UILabel *lbl = [UILabel new];
  lbl.text = title;
  lbl.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  lbl.translatesAutoresizingMaskIntoConstraints = NO;
  [lbl setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [cell.contentView addSubview:lbl];
  [cell.contentView addSubview:field];
  [NSLayoutConstraint activateConstraints:@[
    [lbl.leadingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.leadingAnchor],
    [lbl.centerYAnchor constraintEqualToAnchor:cell.contentView.centerYAnchor],
    [field.leadingAnchor constraintEqualToAnchor:lbl.trailingAnchor constant:12],
    [field.trailingAnchor constraintEqualToAnchor:cell.contentView.layoutMarginsGuide.trailingAnchor],
    [field.topAnchor constraintEqualToAnchor:cell.contentView.topAnchor constant:11],
    [field.bottomAnchor constraintEqualToAnchor:cell.contentView.bottomAnchor constant:-11],
    [cell.contentView.heightAnchor constraintGreaterThanOrEqualToConstant:44]
  ]];
  return cell;
}
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.section == 0) {
    if (indexPath.row == 0)
      return [self layoutField:self.nameField inTitle:RBL(@"名称", @"Name")];
    if (indexPath.row == 1) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleValue1 reuseIdentifier:nil];
      cell.textLabel.text = RBL(@"模型服务", @"Provider");
      NSDictionary *p = [self providerForId:self.selectedProviderId];
      cell.detailTextLabel.text = RBModelsAsString(p[@"name"]) ?: RBL(@"请选择", @"Select");
      cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
      return cell;
    }
    if (indexPath.row == 2)
      return [self layoutField:self.modelField inTitle:RBL(@"模型 ID", @"Model ID")];
    if (indexPath.row == 3) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
      cell.textLabel.text = RBL(@"同步并选择模型列表", @"Fetch & Pick from Catalog");
      cell.textLabel.textColor = self.view.tintColor;
      cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
      return cell;
    }
    if (indexPath.row == 4)
      return [self layoutField:self.contextField inTitle:RBL(@"上下文上限", @"Context Tokens")];
    return [self layoutField:self.summaryField inTitle:RBL(@"摘要阈值", @"Summary Tokens")];
  }
  if (indexPath.section == 1) {
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
    NSString *level = RBModelsValidEfforts()[indexPath.row];
    cell.textLabel.text = level;
    cell.accessoryType = [self.selectedEfforts containsObject:level]
                             ? UITableViewCellAccessoryCheckmark
                             : UITableViewCellAccessoryNone;
    return cell;
  }
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
  cell.textLabel.text = RBL(@"测试此模型配置", @"Test This Model Profile");
  cell.textLabel.textColor = self.view.tintColor;
  cell.textLabel.textAlignment = NSTextAlignmentCenter;
  return cell;
}
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  if (indexPath.section == 0 && indexPath.row == 1) {
    UIAlertController *sheet = [UIAlertController alertControllerWithTitle:RBL(@"选择模型服务", @"Select Provider")
                                                                   message:nil
                                                            preferredStyle:UIAlertControllerStyleActionSheet];
    for (NSDictionary *p in self.parentModels.providers) {
      NSString *pid = RBModelsAsString(p[@"id"]) ?: @"";
      NSString *title = RBModelsAsString(p[@"name"]) ?: pid;
      [sheet addAction:[UIAlertAction actionWithTitle:title
                                                style:UIAlertActionStyleDefault
                                              handler:^(UIAlertAction *a) {
                                                self.selectedProviderId = pid;
                                                [self.tableView reloadRowsAtIndexPaths:@[indexPath] withRowAnimation:UITableViewRowAnimationNone];
                                              }]];
    }
    [sheet addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
    UITableViewCell *cell = [tableView cellForRowAtIndexPath:indexPath];
    sheet.popoverPresentationController.sourceView = cell ?: self.view;
    sheet.popoverPresentationController.sourceRect = cell ? cell.bounds : self.view.bounds;
    [self presentViewController:sheet animated:YES completion:nil];
    return;
  }
  if (indexPath.section == 0 && indexPath.row == 3) {
    NSDictionary *p = [self providerForId:self.selectedProviderId];
    if (!p) {
      [self showAlert:RBL(@"请先选择有效的模型服务。", @"Select a valid provider first.")];
      return;
    }
    [self.parentModels fetchCatalogForProvider:p
                                  candidateKey:RBModelsAsString(self.parentModels.pendingApiKeys[RBModelsAsString(p[@"id"]) ?: @""]) ?: @""
                                          from:self
                                      onSelect:^(NSDictionary *entry) {
                                        NSString *entryId = RBModelsAsString(entry[@"id"]);
                                        if (entryId.length) {
                                          self.modelField.text = entryId;
                                          if (!RBModelsTrimmedString(self.nameField.text).length)
                                            self.nameField.text = entryId;
                                        }
                                        NSArray *rawEfforts = RBModelsAsArray(entry[@"efforts"]);
                                        if (rawEfforts) {
                                          [self.selectedEfforts removeAllObjects];
                                          for (id item in rawEfforts) {
                                            NSString *s = RBModelsAsString(item);
                                            if (s.length)
                                              [self.selectedEfforts addObject:s];
                                          }
                                        }
                                        NSInteger ctx = RBModelsIntValue(entry[@"contextWindowTokens"], 0);
                                        NSInteger sum = RBModelsIntValue(entry[@"summaryThresholdTokens"], 0);
                                        if (ctx > 0)
                                          self.contextField.text = [NSString stringWithFormat:@"%ld", (long)ctx];
                                        if (sum > 0)
                                          self.summaryField.text = [NSString stringWithFormat:@"%ld", (long)sum];
                                        [self.tableView reloadData];
                                      }];
    return;
  }
  if (indexPath.section == 1) {
    NSString *level = RBModelsValidEfforts()[indexPath.row];
    if ([self.selectedEfforts containsObject:level])
      [self.selectedEfforts removeObject:level];
    else
      [self.selectedEfforts addObject:level];
    [tableView reloadRowsAtIndexPaths:@[indexPath] withRowAnimation:UITableViewRowAnimationNone];
    return;
  }
  if (indexPath.section == 2) {
    if (!RBModelsTrimmedString(self.modelField.text).length || !self.selectedProviderId.length) {
      [self showAlert:RBL(@"请先选择模型服务并填写模型 ID。", @"Select a provider and enter a model ID first.")];
      return;
    }
    NSMutableDictionary *draft = [self buildDraftProfile];
    if (![RBModelsAsString(draft[@"name"]) length])
      draft[@"name"] = RBModelsAsString(draft[@"model"]) ?: @"";
    NSString *draftId = RBModelsAsString(draft[@"id"]) ?: @"";
    [self.parentModels runPreflightTestForProfileId:draftId
                                 candidateOverrides:^(NSMutableArray *providers, NSMutableArray *profiles, NSMutableDictionary *defaultRoute) {
                                   NSUInteger idx = [profiles indexOfObjectPassingTest:^BOOL(NSDictionary *obj, NSUInteger i, BOOL *stop) {
                                     return [RBModelsAsString(obj[@"id"]) isEqualToString:draftId];
                                   }];
                                   if (idx != NSNotFound)
                                     profiles[idx] = draft;
                                   else
                                     [profiles addObject:draft];
                                 }
                                               from:self];
  }
}
@end

@implementation RBModelsController

- (instancetype)init {
  self = [super initWithStyle:UITableViewStyleInsetGrouped];
  if (self) {
    _providers = [NSMutableArray array];
    _profiles = [NSMutableArray array];
    _defaultRoute = [@{ @"profileId" : @"", @"effort" : @"default", @"fallbacks" : @[] } mutableCopy];
    _botRoutes = @{};
    _pendingApiKeys = [NSMutableDictionary dictionary];
    _reloadState = @{};
  }
  return self;
}

- (void)dealloc {
  [self stopReloadPolling];
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"模型配置", @"Model Config");
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  if (self.navigationController.viewControllers.firstObject == self) {
    self.navigationItem.leftBarButtonItem =
        [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                      target:self
                                                      action:@selector(closeTapped)];
  }
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:RBL(@"保存", @"Save")
                                       style:UIBarButtonItemStyleDone
                                      target:self
                                      action:@selector(saveTapped)];
  UIRefreshControl *refresh = [UIRefreshControl new];
  [refresh addTarget:self action:@selector(loadModelConfig) forControlEvents:UIControlEventValueChanged];
  self.refreshControl = refresh;
  [self loadModelConfig];
}

- (void)viewWillDisappear:(BOOL)animated {
  [self stopReloadPolling];
  [super viewWillDisappear:animated];
}

- (void)stopReloadPolling {
  [self.reloadPollTimer invalidate];
  self.reloadPollTimer = nil;
}

- (void)closeTapped {
  [self dismissViewControllerAnimated:YES completion:nil];
}

- (NSURLSessionDataTask *)requestPath:(NSString *)path
                               method:(NSString *)method
                                 body:(NSDictionary *)body
                              timeout:(NSTimeInterval)timeout
                           completion:(void (^)(NSInteger status, NSDictionary *json, NSError *error))completion {
  return [self requestPath:path
                    method:method
                      body:body
                   timeout:timeout
           autoPromptOn403:YES
                 presenter:nil
                completion:completion];
}

- (NSURLSessionDataTask *)requestPath:(NSString *)path
                               method:(NSString *)method
                                 body:(NSDictionary *)body
                              timeout:(NSTimeInterval)timeout
                      autoPromptOn403:(BOOL)autoPromptOn403
                            presenter:(UIViewController *)promptPresenter
                           completion:(void (^)(NSInteger status, NSDictionary *json, NSError *error))completion {
  NSString *base = RBConnection.shared.serverURL;
  NSString *token = RBConnection.shared.deviceToken;
  if (!base.length || !token.length) {
    if (completion)
      completion(0, nil, [NSError errorWithDomain:@"RokBotModels" code:401 userInfo:@{
        NSLocalizedDescriptionKey : RBL(@"请先连接 Host。", @"Connect to Host first.")
      }]);
    return nil;
  }
  NSMutableURLRequest *req =
      [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[base stringByAppendingString:path]]];
  req.HTTPMethod = method;
  req.timeoutInterval = timeout;
  [req setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [req setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  if (self.adminPassword.length)
    [req setValue:self.adminPassword forHTTPHeaderField:@"X-RokBot-Admin-Password"];
  if (body) {
    req.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  __weak typeof(self) weak = self;
  NSURLSessionDataTask *task = [RBHTTPSession()
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
            NSDictionary *dict = RBModelsAsDict(json);
            if (status == 403 && !strong.adminPassword.length && autoPromptOn403) {
              [strong promptForAdminPasswordWithMessage:RBModelsLocalizedError(dict, nil, status)
                                                   from:promptPresenter
                                             retryBlock:^{
                                               [strong requestPath:path
                                                            method:method
                                                              body:body
                                                           timeout:timeout
                                                   autoPromptOn403:autoPromptOn403
                                                         presenter:promptPresenter
                                                        completion:completion];
                                             }
                                            cancelBlock:^{
                                              if (completion) completion(status, dict, error);
                                            }];
              return;
            }
            if (status == 403 && strong.adminPassword.length) {
              strong.adminPassword = nil;
            }
            if (completion)
              completion(status, dict, error);
          });
        }];
  [task resume];
  return task;
}

- (void)promptForAdminPasswordWithMessage:(NSString *)message
                                     from:(UIViewController *)explicitPresenter
                               retryBlock:(void (^)(void))retryBlock
                              cancelBlock:(void (^)(void))cancelBlock {
  UIViewController *presenter = explicitPresenter ?: self.navigationController.topViewController ?: self;
  UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:RBL(@"需要管理员密码", @"Admin Password Required")
                       message:message.length ? message
                                              : RBL(@"输入 Host 管理员密码以修改模型配置（仅保存在本次内存中）。",
                                                    @"Enter the Host admin password to configure models (kept in memory only).")
                preferredStyle:UIAlertControllerStyleAlert];
  [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
    field.placeholder = RBL(@"管理员密码", @"Admin password");
    field.secureTextEntry = YES;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.autocorrectionType = UITextAutocorrectionTypeNo;
  }];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel")
                                            style:UIAlertActionStyleCancel
                                          handler:^(UIAlertAction *a) {
                                            if (cancelBlock) cancelBlock();
                                          }]];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"验证并继续", @"Continue")
                                            style:UIAlertActionStyleDefault
                                          handler:^(UIAlertAction *a) {
                                            NSString *pw = alert.textFields.firstObject.text ?: @"";
                                            if (!pw.length) {
                                              if (cancelBlock) cancelBlock();
                                              return;
                                            }
                                            self.adminPassword = pw;
                                            if (retryBlock) retryBlock();
                                          }]];
  [presenter presentViewController:alert animated:YES completion:nil];
}

- (void)applyResponse:(NSDictionary *)json {
  NSDictionary *cfg = RBModelsExtractRoutingConfig(json);
  NSDictionary *reload = RBModelsExtractReloadState(json);
  self.reloadState = reload;
  self.routingMigrated = RBModelsBoolValue(cfg[@"routingMigrated"], NO) ||
                         RBModelsBoolValue(json[@"routingMigrated"], NO);
  self.legacyAdaptiveRouting =
      RBModelsBoolValue(cfg[@"legacyAdaptiveRouting"], NO) ||
      RBModelsBoolValue(json[@"legacyAdaptiveRouting"], NO);
  if (RBModelsHasBoolOrIntValue(json[@"configured"]))
    self.configured = RBModelsBoolValue(json[@"configured"], NO);
  else if (RBModelsHasBoolOrIntValue(cfg[@"configured"]))
    self.configured = RBModelsBoolValue(cfg[@"configured"], NO);
  else
    self.configured = ([RBModelsAsArray(cfg[@"providers"]) count] > 0);
  self.needsModel = !self.configured;

  [self.providers removeAllObjects];
  for (id p in RBModelsAsArray(cfg[@"providers"]) ?: @[]) {
    NSDictionary *pd = RBModelsAsDict(p);
    if (pd)
      [self.providers addObject:[pd mutableCopy]];
  }
  [self.profiles removeAllObjects];
  for (id p in RBModelsAsArray(cfg[@"profiles"]) ?: @[]) {
    NSDictionary *pd = RBModelsAsDict(p);
    if (pd)
      [self.profiles addObject:[pd mutableCopy]];
  }
  NSDictionary *defRoute = RBModelsAsDict(cfg[@"defaultRoute"]);
  if (defRoute) {
    self.defaultRoute = [defRoute mutableCopy];
  } else {
    NSString *firstProfile = RBModelsAsString(self.profiles.firstObject[@"id"]) ?: @"";
    self.defaultRoute = [@{ @"profileId" : firstProfile, @"effort" : @"default", @"fallbacks" : @[] } mutableCopy];
  }
  self.botRoutes = RBModelsAsDict(cfg[@"botRoutes"]) ?: @{};
  [self updateBannerFromReloadState];
  [self.tableView reloadData];
}

- (void)updateBannerFromReloadState {
  NSString *rStatus = RBModelsAsString(self.reloadState[@"status"]);
  if ([rStatus isEqualToString:@"waiting"] || [rStatus isEqualToString:@"pending"]) {
    self.statusBannerText = RBL(@"配置已保存，Host 正在热加载生效中…", @"Saved. Waiting for Host reload…");
    self.statusBannerIsError = NO;
  } else if ([rStatus isEqualToString:@"applied"]) {
    self.statusBannerText = RBL(@"配置已生效", @"Configuration applied on Host");
    self.statusBannerIsError = NO;
  } else if ([rStatus isEqualToString:@"error"]) {
    NSString *err = RBModelsAsString(self.reloadState[@"error"]);
    if (!err.length)
      err = RBModelsAsString(self.reloadState[@"message"]);
    if (!err.length)
      err = RBL(@"Host 热加载失败，请检查服务日志。", @"Host reload failed.");
    self.statusBannerText = err;
    self.statusBannerIsError = YES;
  } else if (self.needsModel) {
    self.statusBannerText = RBL(@"尚未配置可用模型，请先添加模型服务和档案。", @"No model configured yet. Add a provider and profile.");
    self.statusBannerIsError = NO;
  } else {
    self.statusBannerText = nil;
    self.statusBannerIsError = NO;
  }
}

- (void)loadModelConfig {
  self.loading = YES;
  [self requestPath:@"/local/model"
             method:@"GET"
               body:nil
            timeout:20
         completion:^(NSInteger status, NSDictionary *json, NSError *error) {
           self.loading = NO;
           [self.refreshControl endRefreshing];
           if (status == 401) {
             [self showAlertTitle:RBL(@"未授权", @"Unauthorized")
                          message:RBModelsLocalizedError(json, error, status)
                         onClose:^{ [RBConnection.shared show]; }];
             return;
           }
           if (error || status < 200 || status >= 300 || !json) {
             self.statusBannerText = RBModelsLocalizedError(json, error, status);
             self.statusBannerIsError = YES;
             [self.tableView reloadData];
             return;
           }
           [self applyResponse:json];
         }];
}

- (void)startReloadPollingIfNeeded {
  [self stopReloadPolling];
  NSString *rStatus = RBModelsAsString(self.reloadState[@"status"]);
  if (!([rStatus isEqualToString:@"waiting"] || [rStatus isEqualToString:@"pending"]))
    return;
  self.reloadPollCount = 0;
  __weak typeof(self) weak = self;
  self.reloadPollTimer = [NSTimer scheduledTimerWithTimeInterval:1.5
                                                         repeats:YES
                                                           block:^(NSTimer *timer) {
                                                             typeof(self) strong = weak;
                                                             if (!strong) {
                                                               [timer invalidate];
                                                               return;
                                                             }
                                                             if (strong.reloadPollCount >= 30) {
                                                               [strong stopReloadPolling];
                                                               return;
                                                             }
                                                             strong.reloadPollCount++;
                                                             [strong pollReloadStatusOnce];
                                                           }];
}

- (void)pollReloadStatusOnce {
  [self requestPath:@"/local/model"
             method:@"GET"
               body:nil
            timeout:15
         completion:^(NSInteger status, NSDictionary *json, NSError *error) {
           if (error || status != 200 || !json)
             return;
           NSDictionary *reload = RBModelsExtractReloadState(json);
           self.reloadState = reload;
           [self updateBannerFromReloadState];
           [self.tableView reloadData];
           NSString *rStatus = RBModelsAsString(reload[@"status"]);
           if (!([rStatus isEqualToString:@"waiting"] || [rStatus isEqualToString:@"pending"])) {
             [self stopReloadPolling];
           }
         }];
}

- (void)saveTapped {
  if (self.saving)
    return;
  if (self.legacyAdaptiveRouting && !self.confirmedLegacyMigration) {
    UIAlertController *confirm = [UIAlertController
        alertControllerWithTitle:RBL(@"迁移旧版配置", @"Migrate Legacy Config")
                         message:RBL(@"检测到 Host 正在使用旧版自适应路由配置。保存新配置将迁移为多模型路由格式，是否继续？",
                                     @"Host is using legacy adaptive routing. Saving will migrate to multi-provider routing. Continue?")
                  preferredStyle:UIAlertControllerStyleAlert];
    [confirm addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
    [confirm addAction:[UIAlertAction actionWithTitle:RBL(@"迁移并保存", @"Migrate & Save")
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *a) {
                                              self.confirmedLegacyMigration = YES;
                                              [self performSaveWithMigration:YES];
                                            }]];
    [self presentViewController:confirm animated:YES completion:nil];
    return;
  }
  [self performSaveWithMigration:self.routingMigrated || self.confirmedLegacyMigration];
}

- (void)performSaveWithMigration:(BOOL)migrate {
  NSString *errMsg = nil;
  NSDictionary *payload = RBModelsBuildSavePayload(
      self.providers, self.profiles, self.defaultRoute, self.botRoutes, self.pendingApiKeys, migrate, &errMsg);
  if (!payload) {
    [self showAlertTitle:RBL(@"配置不完整", @"Invalid Configuration") message:errMsg onClose:nil];
    return;
  }
  self.saving = YES;
  self.navigationItem.rightBarButtonItem.enabled = NO;
  self.statusBannerText = RBL(@"正在保存模型配置…", @"Saving model configuration…");
  self.statusBannerIsError = NO;
  [self.tableView reloadData];

  [self requestPath:@"/local/model"
             method:@"PUT"
               body:payload
            timeout:30
         completion:^(NSInteger status, NSDictionary *json, NSError *error) {
           self.saving = NO;
           self.navigationItem.rightBarButtonItem.enabled = YES;
           if (status == 409 && !migrate) {
             UIAlertController *confirm = [UIAlertController
                 alertControllerWithTitle:RBL(@"需要确认迁移", @"Confirm Migration")
                                  message:RBModelsLocalizedError(json, error, status)
                           preferredStyle:UIAlertControllerStyleAlert];
             [confirm addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
             [confirm addAction:[UIAlertAction actionWithTitle:RBL(@"确认迁移", @"Migrate")
                                                       style:UIAlertActionStyleDefault
                                                     handler:^(UIAlertAction *a) {
                                                       self.confirmedLegacyMigration = YES;
                                                       [self performSaveWithMigration:YES];
                                                     }]];
             [self presentViewController:confirm animated:YES completion:nil];
             return;
           }
           if (error || status < 200 || status >= 300 || !json) {
             NSString *msg = RBModelsLocalizedError(json, error, status);
             self.statusBannerText = msg;
             self.statusBannerIsError = YES;
             [self.tableView reloadData];
             [self showAlertTitle:RBL(@"保存失败", @"Save Failed") message:msg onClose:nil];
             return;
           }
           [self.pendingApiKeys removeAllObjects];
           [NSUserDefaults.standardUserDefaults removeObjectForKey:RBModelOnboardingDismissedKey()];
           [self applyResponse:json];
           [NSNotificationCenter.defaultCenter postNotificationName:@"RokBotModelConfigChanged" object:nil];
           [self startReloadPollingIfNeeded];
         }];
}

- (void)fetchCatalogForProvider:(NSDictionary *)provider
                   candidateKey:(NSString *)candidateKey
                           from:(UIViewController *)presenter
                       onSelect:(void (^)(NSDictionary *entry))onSelect {
  NSString *key = RBModelsTrimmedString(candidateKey);
  if (!key.length && !RBModelsBoolValue(provider[@"hasApiKey"], NO)) {
    [self showAlertTitle:RBL(@"缺少 API Key", @"Missing API Key")
                 message:RBL(@"请先填写此模型服务的 API Key。", @"Enter an API Key for this provider first.")
                    from:presenter
                 onClose:nil];
    return;
  }
  NSDictionary *body = @{
    @"provider" : @{
      @"id" : RBModelsAsString(provider[@"id"]) ?: @"preview",
      @"name" : RBModelsAsString(provider[@"name"]) ?: @"Provider",
      @"apiFormat" : RBModelsAsString(provider[@"apiFormat"]) ?: @"openai",
      @"baseUrl" : RBModelsAsString(provider[@"baseUrl"]) ?: @"",
      @"apiKey" : key
    }
  };
  [self requestPath:@"/local/model/catalog"
             method:@"POST"
               body:body
            timeout:20
    autoPromptOn403:YES
          presenter:presenter
         completion:^(NSInteger status, NSDictionary *json, NSError *error) {
           NSArray *rawModels = RBModelsAsArray(json[@"models"]);
           if (error || status < 200 || status >= 300 || !rawModels) {
             [self showAlertTitle:RBL(@"无法拉取模型列表", @"Catalog Failed")
                          message:RBModelsLocalizedError(json, error, status)
                             from:presenter
                          onClose:nil];
             return;
           }
           NSMutableArray<NSDictionary *> *models = [NSMutableArray array];
           for (id item in rawModels) {
             NSDictionary *entry = RBModelsAsDict(item);
             if (entry)
               [models addObject:entry];
           }
           if (!models.count) {
             [self showAlertTitle:RBL(@"模型列表为空", @"Empty Catalog")
                          message:RBL(@"服务端未返回可用模型，请手动填写模型 ID。", @"No models returned. Enter the model ID manually.")
                             from:presenter
                          onClose:nil];
             return;
           }
           RBModelCatalogPickerController *picker =
               [[RBModelCatalogPickerController alloc] initWithModels:models onSelect:onSelect];
           [presenter.navigationController pushViewController:picker animated:YES];
         }];
}

- (void)runPreflightTestForProfileId:(NSString *)profileId
                  candidateOverrides:(void (^)(NSMutableArray *, NSMutableArray *, NSMutableDictionary *))overrides
                                from:(UIViewController *)presenter {
  NSMutableArray *candProviders = [NSMutableArray arrayWithCapacity:self.providers.count];
  for (NSDictionary *p in self.providers)
    [candProviders addObject:[p mutableCopy]];
  NSMutableArray *candProfiles = [NSMutableArray arrayWithCapacity:self.profiles.count];
  for (NSDictionary *p in self.profiles)
    [candProfiles addObject:[p mutableCopy]];
  NSMutableDictionary *candDefault = [self.defaultRoute mutableCopy];
  if (overrides)
    overrides(candProviders, candProfiles, candDefault);
  if (![RBModelsAsString(candDefault[@"profileId"]) length] && candProfiles.count)
    candDefault[@"profileId"] = RBModelsAsString(candProfiles.firstObject[@"id"]) ?: @"";

  NSString *errMsg = nil;
  NSDictionary *payload = RBModelsBuildSavePayload(
      candProviders, candProfiles, candDefault, self.botRoutes, self.pendingApiKeys,
      self.routingMigrated || self.confirmedLegacyMigration, &errMsg);
  if (!payload) {
    [self showAlertTitle:RBL(@"无法测试", @"Cannot Test") message:errMsg from:presenter onClose:nil];
    return;
  }
  NSMutableDictionary *body = [payload mutableCopy];
  if (profileId.length)
    body[@"profileId"] = profileId;

  UIViewController *targetPresenter = presenter ?: self;
  if (targetPresenter.presentedViewController != nil)
    return;

  __block BOOL progressPresented = NO;
  __block BOOL cancelled = NO;
  __block void (^pendingFinish)(void) = nil;
  __block NSURLSessionDataTask *task = nil;

  UIAlertController *progress = [UIAlertController
      alertControllerWithTitle:RBL(@"正在测试模型…", @"Testing Model…")
                       message:RBL(@"正在发送测试请求，最多可能需要 120 秒。", @"Sending live test prompt (up to 120s)…")
                preferredStyle:UIAlertControllerStyleAlert];
  [progress addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel")
                                               style:UIAlertActionStyleCancel
                                             handler:^(UIAlertAction *a) {
                                               cancelled = YES;
                                               pendingFinish = nil;
                                               [task cancel];
                                             }]];
  [targetPresenter presentViewController:progress
                                animated:YES
                              completion:^{
                                progressPresented = YES;
                                if (pendingFinish) {
                                  void (^fn)(void) = pendingFinish;
                                  pendingFinish = nil;
                                  fn();
                                }
                              }];

  __weak typeof(self) weak = self;
  task = [self requestPath:@"/local/model/test"
                    method:@"POST"
                      body:body
                   timeout:125
           autoPromptOn403:NO
                 presenter:targetPresenter
                completion:^(NSInteger status, NSDictionary *json, NSError *error) {
                  typeof(self) strong = weak;
                  if (!strong || cancelled)
                    return;
                  void (^dismissAndHandle)(void) = ^{
                    if (cancelled)
                      return;
                    void (^afterDismiss)(void) = ^{
                      if (cancelled)
                        return;
                      if (status == 403 && !strong.adminPassword.length) {
                        [strong promptForAdminPasswordWithMessage:RBModelsLocalizedError(json, nil, status)
                                                             from:targetPresenter
                                                       retryBlock:^{
                                                         [strong runPreflightTestForProfileId:profileId
                                                                           candidateOverrides:overrides
                                                                                         from:targetPresenter];
                                                       }
                                                      cancelBlock:nil];
                        return;
                      }
                      if (error || status < 200 || status >= 300 || !RBModelsBoolValue(json[@"ok"], NO)) {
                        [strong showAlertTitle:RBL(@"测试失败", @"Test Failed")
                                     message:RBModelsLocalizedError(json, error, status)
                                        from:targetPresenter
                                     onClose:nil];
                        return;
                      }
                      NSString *reply = RBModelsAsString(json[@"reply"]) ?: @"OK";
                      NSInteger ms = RBModelsIntValue(json[@"latencyMs"], 0);
                      NSString *model = RBModelsAsString(json[@"model"]) ?: @"";
                      [strong showAlertTitle:RBL(@"测试成功", @"Test Passed")
                                   message:[NSString stringWithFormat:@"%@\n%@ · %ld ms", reply, model, (long)ms]
                                      from:targetPresenter
                                   onClose:nil];
                    };
                    if (progress.presentingViewController) {
                      [progress dismissViewControllerAnimated:YES completion:afterDismiss];
                    } else {
                      afterDismiss();
                    }
                  };
                  if (progressPresented) {
                    dismissAndHandle();
                  } else {
                    pendingFinish = [dismissAndHandle copy];
                  }
                }];
}

- (void)showAlertTitle:(NSString *)title message:(NSString *)message onClose:(void (^)(void))onClose {
  [self showAlertTitle:title message:message from:self onClose:onClose];
}

- (void)showAlertTitle:(NSString *)title
               message:(NSString *)message
                  from:(UIViewController *)presenter
               onClose:(void (^)(void))onClose {
  UIAlertController *a = [UIAlertController alertControllerWithTitle:title
                                                             message:message
                                                      preferredStyle:UIAlertControllerStyleAlert];
  [a addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK")
                                        style:UIAlertActionStyleDefault
                                      handler:^(UIAlertAction *act) {
                                        if (onClose) onClose();
                                      }]];
  [(presenter ?: self) presentViewController:a animated:YES completion:nil];
}

- (NSDictionary *)profileById:(NSString *)pid {
  for (NSDictionary *p in self.profiles)
    if ([RBModelsAsString(p[@"id"]) isEqualToString:pid])
      return p;
  return nil;
}

- (NSDictionary *)providerById:(NSString *)pid {
  for (NSDictionary *p in self.providers)
    if ([RBModelsAsString(p[@"id"]) isEqualToString:pid])
      return p;
  return nil;
}

- (BOOL)isProfileReferenced:(NSString *)pid {
  if ([RBModelsAsString(self.defaultRoute[@"profileId"]) isEqualToString:pid])
    return YES;
  NSArray *fbs = RBModelsAsArray(self.defaultRoute[@"fallbacks"]) ?: @[];
  for (id item in fbs) {
    NSDictionary *fb = RBModelsAsDict(item);
    if (fb && [RBModelsAsString(fb[@"profileId"]) isEqualToString:pid])
      return YES;
  }
  for (NSString *botId in self.botRoutes) {
    NSDictionary *route = RBModelsAsDict(self.botRoutes[botId]);
    if (!route)
      continue;
    if ([RBModelsAsString(route[@"profileId"]) isEqualToString:pid])
      return YES;
    NSArray *botFbs = RBModelsAsArray(route[@"fallbacks"]) ?: @[];
    for (id item in botFbs) {
      NSDictionary *fb = RBModelsAsDict(item);
      if (fb && [RBModelsAsString(fb[@"profileId"]) isEqualToString:pid])
        return YES;
    }
  }
  return NO;
}

- (BOOL)isProviderReferenced:(NSString *)pid {
  for (NSDictionary *p in self.profiles)
    if ([RBModelsAsString(p[@"providerId"]) isEqualToString:pid])
      return YES;
  return NO;
}

#pragma mark - Table View

- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
  return 4;
}

- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  if (section == 0) return self.statusBannerText.length ? 2 : 1; // Status / Test Default
  if (section == 1) return 3; // Default profile, effort, fallbacks
  if (section == 2) return (NSInteger)self.profiles.count + 1;
  return (NSInteger)self.providers.count + 1;
}

- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  if (section == 0) return RBL(@"状态与验证", @"Status & Test");
  if (section == 1) return RBL(@"默认路由", @"Default Route");
  if (section == 2) return RBL(@"模型档案", @"Model Profiles");
  return RBL(@"模型服务", @"Providers");
}

- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.section == 0) {
    if (self.statusBannerText.length && indexPath.row == 0) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
      cell.selectionStyle = UITableViewCellSelectionStyleNone;
      cell.textLabel.text = self.statusBannerText;
      cell.textLabel.numberOfLines = 0;
      cell.textLabel.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
      cell.textLabel.textColor = self.statusBannerIsError ? UIColor.systemRedColor : UIColor.secondaryLabelColor;
      return cell;
    }
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
    cell.textLabel.text = RBL(@"测试当前默认模型", @"Test Default Model");
    cell.textLabel.textColor = self.profiles.count ? self.view.tintColor : UIColor.tertiaryLabelColor;
    cell.textLabel.textAlignment = NSTextAlignmentCenter;
    return cell;
  }

  if (indexPath.section == 1) {
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleValue1 reuseIdentifier:nil];
    cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    NSDictionary *active = [self profileById:RBModelsAsString(self.defaultRoute[@"profileId"]) ?: @""];
    if (indexPath.row == 0) {
      cell.textLabel.text = RBL(@"当前模型档案", @"Active Profile");
      cell.detailTextLabel.text = RBModelsAsString(active[@"name"]) ?: RBL(@"未设置", @"Unset");
    } else if (indexPath.row == 1) {
      cell.textLabel.text = RBL(@"推理强度", @"Reasoning Effort");
      cell.detailTextLabel.text = RBModelsAsString(self.defaultRoute[@"effort"]) ?: @"default";
    } else {
      cell.textLabel.text = RBL(@"备用回退模型", @"Fallback Profiles");
      NSArray *fbs = RBModelsAsArray(self.defaultRoute[@"fallbacks"]) ?: @[];
      cell.detailTextLabel.text = fbs.count ? [NSString stringWithFormat:@"%lu", (unsigned long)fbs.count] : RBL(@"无", @"None");
    }
    return cell;
  }

  if (indexPath.section == 2) {
    if (indexPath.row == (NSInteger)self.profiles.count) {
      UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
      cell.textLabel.text = RBL(@"+ 添加模型档案", @"+ Add Profile");
      cell.textLabel.textColor = self.view.tintColor;
      return cell;
    }
    NSDictionary *prof = self.profiles[indexPath.row];
    NSString *profPid = RBModelsAsString(prof[@"providerId"]) ?: @"";
    NSDictionary *prov = [self providerById:profPid];
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
    NSString *profId = RBModelsAsString(prof[@"id"]) ?: @"";
    NSString *profName = RBModelsAsString(prof[@"name"]) ?: @"";
    NSString *profModel = RBModelsAsString(prof[@"model"]) ?: @"";
    BOOL isDefault = [RBModelsAsString(self.defaultRoute[@"profileId"]) isEqualToString:profId];
    cell.textLabel.text = isDefault ? [NSString stringWithFormat:@"★ %@", profName] : profName;
    cell.detailTextLabel.text = [NSString stringWithFormat:@"%@ · %@", profModel, RBModelsAsString(prov[@"name"]) ?: profPid];
    cell.detailTextLabel.textColor = UIColor.secondaryLabelColor;
    cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
    return cell;
  }

  if (indexPath.row == (NSInteger)self.providers.count) {
    UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
    cell.textLabel.text = RBL(@"+ 添加模型服务", @"+ Add Provider");
    cell.textLabel.textColor = self.view.tintColor;
    return cell;
  }
  NSDictionary *prov = self.providers[indexPath.row];
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:nil];
  NSString *provId = RBModelsAsString(prov[@"id"]) ?: @"";
  BOOL hasKey = RBModelsBoolValue(prov[@"hasApiKey"], NO) ||
                [RBModelsAsString(self.pendingApiKeys[provId]) length] > 0;
  cell.textLabel.text = RBModelsAsString(prov[@"name"]) ?: @"";
  cell.detailTextLabel.text = [NSString stringWithFormat:@"%@ · %@ · %@",
      RBModelsAsString(prov[@"apiFormat"]) ?: @"openai",
      RBModelsAsString(prov[@"baseUrl"]) ?: @"",
      hasKey ? RBL(@"已配置 Key", @"Key set") : RBL(@"缺少 Key", @"Missing Key")];
  cell.detailTextLabel.textColor = hasKey ? UIColor.secondaryLabelColor : UIColor.systemOrangeColor;
  cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
  return cell;
}

- (BOOL)tableView:(UITableView *)tableView canEditRowAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.section == 2 && indexPath.row < (NSInteger)self.profiles.count)
    return YES;
  if (indexPath.section == 3 && indexPath.row < (NSInteger)self.providers.count)
    return YES;
  return NO;
}

- (void)tableView:(UITableView *)tableView
    commitEditingStyle:(UITableViewCellEditingStyle)editingStyle
     forRowAtIndexPath:(NSIndexPath *)indexPath {
  if (editingStyle != UITableViewCellEditingStyleDelete)
    return;
  if (indexPath.section == 2 && indexPath.row < (NSInteger)self.profiles.count) {
    NSString *pid = RBModelsAsString(self.profiles[indexPath.row][@"id"]) ?: @"";
    if ([self isProfileReferenced:pid]) {
      [self showAlertTitle:RBL(@"无法删除", @"Cannot Delete")
                   message:RBL(@"此模型档案正在被默认路由或 Bot 路由使用。", @"This profile is referenced by the default route or a bot route.")
                   onClose:nil];
      return;
    }
    [self.profiles removeObjectAtIndex:indexPath.row];
    [tableView deleteRowsAtIndexPaths:@[indexPath] withRowAnimation:UITableViewRowAnimationAutomatic];
    return;
  }
  if (indexPath.section == 3 && indexPath.row < (NSInteger)self.providers.count) {
    NSString *pid = RBModelsAsString(self.providers[indexPath.row][@"id"]) ?: @"";
    if ([self isProviderReferenced:pid]) {
      [self showAlertTitle:RBL(@"无法删除", @"Cannot Delete")
                   message:RBL(@"仍有模型档案正在使用此服务，请先修改或删除对应档案。", @"A profile still uses this provider.")
                   onClose:nil];
      return;
    }
    [self.providers removeObjectAtIndex:indexPath.row];
    if (pid.length)
      [self.pendingApiKeys removeObjectForKey:pid];
    [tableView deleteRowsAtIndexPaths:@[indexPath] withRowAnimation:UITableViewRowAnimationAutomatic];
  }
}

- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  if (indexPath.section == 0) {
    BOOL isTestRow = self.statusBannerText.length ? (indexPath.row == 1) : (indexPath.row == 0);
    if (isTestRow && self.profiles.count) {
      [self runPreflightTestForProfileId:RBModelsAsString(self.defaultRoute[@"profileId"])
                      candidateOverrides:nil
                                    from:self];
    }
    return;
  }

  if (indexPath.section == 1) {
    if (indexPath.row == 0) {
      if (!self.profiles.count) {
        [self showAlertTitle:RBL(@"暂无档案", @"No Profiles")
                     message:RBL(@"请先添加一个模型档案。", @"Add a model profile first.")
                     onClose:nil];
        return;
      }
      UIAlertController *sheet = [UIAlertController alertControllerWithTitle:RBL(@"选择默认模型档案", @"Select Active Profile")
                                                                     message:nil
                                                              preferredStyle:UIAlertControllerStyleActionSheet];
      for (NSDictionary *prof in self.profiles) {
        NSString *profName = RBModelsAsString(prof[@"name"]) ?: @"";
        NSString *profModel = RBModelsAsString(prof[@"model"]) ?: @"";
        NSString *profId = RBModelsAsString(prof[@"id"]) ?: @"";
        NSString *title = [NSString stringWithFormat:@"%@ (%@)", profName, profModel];
        [sheet addAction:[UIAlertAction actionWithTitle:title
                                                  style:UIAlertActionStyleDefault
                                                handler:^(UIAlertAction *a) {
                                                  self.defaultRoute[@"profileId"] = profId;
                                                  NSArray *efforts = RBModelsAsArray(prof[@"efforts"]) ?: @[];
                                                  NSString *curEffort = RBModelsAsString(self.defaultRoute[@"effort"]) ?: @"default";
                                                  if (![efforts containsObject:curEffort])
                                                    self.defaultRoute[@"effort"] = @"default";
                                                  [self.tableView reloadData];
                                                }]];
      }
      [sheet addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
      UITableViewCell *cell = [tableView cellForRowAtIndexPath:indexPath];
      sheet.popoverPresentationController.sourceView = cell ?: self.view;
      sheet.popoverPresentationController.sourceRect = cell ? cell.bounds : self.view.bounds;
      [self presentViewController:sheet animated:YES completion:nil];
    } else if (indexPath.row == 1) {
      NSDictionary *active = [self profileById:RBModelsAsString(self.defaultRoute[@"profileId"]) ?: @""];
      NSArray *efforts = RBModelsAsArray(active[@"efforts"]) ?: @[];
      NSMutableArray *options = [NSMutableArray arrayWithObject:@"default"];
      for (id item in efforts) {
        NSString *s = RBModelsAsString(item);
        if (s.length)
          [options addObject:s];
      }
      UIAlertController *sheet = [UIAlertController alertControllerWithTitle:RBL(@"选择推理强度", @"Select Reasoning Effort")
                                                                     message:nil
                                                              preferredStyle:UIAlertControllerStyleActionSheet];
      for (NSString *opt in options) {
        [sheet addAction:[UIAlertAction actionWithTitle:opt
                                                  style:UIAlertActionStyleDefault
                                                handler:^(UIAlertAction *a) {
                                                  self.defaultRoute[@"effort"] = opt;
                                                  [self.tableView reloadRowsAtIndexPaths:@[indexPath] withRowAnimation:UITableViewRowAnimationNone];
                                                }]];
      }
      [sheet addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
      UITableViewCell *cell = [tableView cellForRowAtIndexPath:indexPath];
      sheet.popoverPresentationController.sourceView = cell ?: self.view;
      sheet.popoverPresentationController.sourceRect = cell ? cell.bounds : self.view.bounds;
      [self presentViewController:sheet animated:YES completion:nil];
    } else if (indexPath.row == 2) {
      NSString *primaryId = RBModelsAsString(self.defaultRoute[@"profileId"]) ?: @"";
      NSMutableArray *candidates = [NSMutableArray array];
      for (NSDictionary *p in self.profiles)
        if (![RBModelsAsString(p[@"id"]) isEqualToString:primaryId])
          [candidates addObject:p];
      if (!candidates.count) {
        [self showAlertTitle:RBL(@"无可用备用模型", @"No Fallback Candidates")
                     message:RBL(@"添加第二个模型档案后即可配置回退链。", @"Add another profile to configure fallbacks.")
                     onClose:nil];
        return;
      }
      UIAlertController *sheet = [UIAlertController alertControllerWithTitle:RBL(@"切换备用模型", @"Toggle Fallback Profile")
                                                                     message:RBL(@"点击可添加或移除备用回退档案。", @"Tap to add or remove a fallback profile.")
                                                              preferredStyle:UIAlertControllerStyleActionSheet];
      NSMutableArray *fbs = [(RBModelsAsArray(self.defaultRoute[@"fallbacks"]) ?: @[]) mutableCopy];
      for (NSDictionary *cand in candidates) {
        NSString *candId = RBModelsAsString(cand[@"id"]) ?: @"";
        NSString *candName = RBModelsAsString(cand[@"name"]) ?: candId;
        NSUInteger existingIdx = [fbs indexOfObjectPassingTest:^BOOL(id obj, NSUInteger i, BOOL *stop) {
          NSDictionary *d = RBModelsAsDict(obj);
          return d && [RBModelsAsString(d[@"profileId"]) isEqualToString:candId];
        }];
        NSString *prefix = existingIdx != NSNotFound ? @"✓ " : @"";
        [sheet addAction:[UIAlertAction actionWithTitle:[prefix stringByAppendingString:candName]
                                                  style:UIAlertActionStyleDefault
                                                handler:^(UIAlertAction *a) {
                                                  if (existingIdx != NSNotFound)
                                                    [fbs removeObjectAtIndex:existingIdx];
                                                  else if (fbs.count < 8)
                                                    [fbs addObject:@{ @"profileId" : candId, @"effort" : @"default", @"order" : @(fbs.count) }];
                                                  self.defaultRoute[@"fallbacks"] = fbs;
                                                  [self.tableView reloadRowsAtIndexPaths:@[indexPath] withRowAnimation:UITableViewRowAnimationNone];
                                                }]];
      }
      [sheet addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
      UITableViewCell *cell = [tableView cellForRowAtIndexPath:indexPath];
      sheet.popoverPresentationController.sourceView = cell ?: self.view;
      sheet.popoverPresentationController.sourceRect = cell ? cell.bounds : self.view.bounds;
      [self presentViewController:sheet animated:YES completion:nil];
    }
    return;
  }

  if (indexPath.section == 2) {
    BOOL isNew = (indexPath.row == (NSInteger)self.profiles.count);
    if (isNew && !self.providers.count) {
      [self showAlertTitle:RBL(@"请先添加模型服务", @"Add a Provider First")
                   message:RBL(@"模型档案需要关联一个模型服务。", @"A model profile requires a model provider.")
                   onClose:nil];
      return;
    }
    NSMutableDictionary *existing = isNew ? nil : self.profiles[indexPath.row];
    RBModelProfileEditorController *editor = [[RBModelProfileEditorController alloc]
        initWithProfile:existing
                  isNew:isNew
           parentModels:self
                 onSave:^(NSMutableDictionary *updated) {
                   if (isNew) {
                     [self.profiles addObject:updated];
                     if (![RBModelsAsString(self.defaultRoute[@"profileId"]) length])
                       self.defaultRoute[@"profileId"] = RBModelsAsString(updated[@"id"]) ?: @"";
                   } else {
                     self.profiles[indexPath.row] = updated;
                   }
                   [self.tableView reloadData];
                 }];
    [self.navigationController pushViewController:editor animated:YES];
    return;
  }

  if (indexPath.section == 3) {
    BOOL isNew = (indexPath.row == (NSInteger)self.providers.count);
    NSMutableDictionary *existing = isNew ? nil : self.providers[indexPath.row];
    RBModelProviderEditorController *editor = [[RBModelProviderEditorController alloc]
        initWithProvider:existing
                   isNew:isNew
            parentModels:self
                  onSave:^(NSMutableDictionary *updated, NSString *newApiKey) {
                    NSString *pid = RBModelsAsString(updated[@"id"]) ?: @"";
                    if (pid.length) {
                      if (newApiKey.length)
                        self.pendingApiKeys[pid] = newApiKey;
                      else
                        [self.pendingApiKeys removeObjectForKey:pid];
                    }
                    if (isNew)
                      [self.providers addObject:updated];
                    else
                      self.providers[indexPath.row] = updated;
                    [self.tableView reloadData];
                  }];
    [self.navigationController pushViewController:editor animated:YES];
  }
}

@end

void RBShowModelsFrom(UIViewController *presenter) {
  RBModelsController *vc = [RBModelsController new];
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

void RBShowModels(void) {
  RBShowModelsFrom(RBTopController());
}

#endif // TARGET_OS_IOS
