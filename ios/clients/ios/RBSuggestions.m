#import "RBSuggestions.h"
#import <TargetConditionals.h>

static const NSUInteger RBSuggestionsMaxAI = 3;
static const NSUInteger RBSuggestionsMaxHabitMatches = 3;
static const NSUInteger RBSuggestionsMaxCandidates = 60;
static const NSUInteger RBSuggestionsMaxFeedbackText = 400;
static const NSUInteger RBSuggestionsMaxFeedbackShown = 8;
static const NSUInteger RBSuggestionsMaxPhraseChars = 120;
static const NSUInteger RBSuggestionsMaxPhrases = 50;
static const NSUInteger RBHistoryHintsMax = 64;

const NSTimeInterval RBSuggestionsPlaceholderDelay = 0.140;
const NSTimeInterval RBSuggestionsFadeOutDuration = 0.180;
const NSTimeInterval RBSuggestionsBarFadeDuration = 0.17;
const NSUInteger RBSuggestionsPlaceholderCount = 3;

const NSTimeInterval RBCompletionDebounce = 0.350;
const NSUInteger RBCompletionMinChars = 2;
const NSUInteger RBCompletionCacheLimit = 32;

static NSString *RBSuggestionsTrim(id value) {
  if (![value isKindOfClass:NSString.class]) return @"";
  NSString *trimmed = [[(NSString *)value stringByReplacingOccurrencesOfString:@"\u200B" withString:@""]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return [trimmed isEqualToString:@"null"] ? @"" : trimmed;
}

static NSUInteger RBSuggestionsCharCount(NSString *value) {
  if (!value.length) return 0;
  __block NSUInteger count = 0;
  [value enumerateSubstringsInRange:NSMakeRange(0, value.length)
                            options:NSStringEnumerationByComposedCharacterSequences
                         usingBlock:^(NSString *s, NSRange r, NSRange e, BOOL *stop) { count++; }];
  return count;
}

static BOOL RBSuggestionsBool(id value, BOOL fallback) {
  if ([value isKindOfClass:NSNumber.class]) return [value boolValue];
  return fallback;
}

NSDictionary *RBSuggestionsParseSettings(id response) {
  NSDictionary *dict = [response isKindOfClass:NSDictionary.class] ? response : @{};
  NSMutableArray<NSDictionary *> *phrases = [NSMutableArray array];
  id list = dict[@"quickPhrases"];
  if ([list isKindOfClass:NSArray.class]) {
    for (id raw in list) {
      NSString *text = RBSuggestionsTrim([raw isKindOfClass:NSDictionary.class] ? raw[@"text"] : raw);
      if (!text.length) continue;
      NSString *pid = [raw isKindOfClass:NSDictionary.class] ? RBSuggestionsTrim(raw[@"id"]) : @"";
      [phrases addObject:@{ @"id" : pid, @"text" : text }];
    }
  }
  return @{
    @"enabled" : @(RBSuggestionsBool(dict[@"enabled"], YES)),
    @"aiEnabled" : @(RBSuggestionsBool(dict[@"aiEnabled"], YES)),
    @"completionEnabled" : @(RBSuggestionsBool(dict[@"completionEnabled"], YES)),
    @"learningEnabled" : @(RBSuggestionsBool(dict[@"learningEnabled"], YES)),
    @"localCompletionEnabled" : @(RBSuggestionsBool(dict[@"localCompletionEnabled"], YES)),
    @"quickPhrases" : phrases,
    @"hasPhrases" : @([list isKindOfClass:NSArray.class]),
  };
}

NSArray<NSString *> *RBSuggestionsStringList(id array, NSUInteger max) {
  if (![array isKindOfClass:NSArray.class] || max == 0) return @[];
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  for (id raw in (NSArray *)array) {
    NSString *text = RBSuggestionsTrim(raw);
    if (text.length) [out addObject:text];
    if (out.count >= max) break;
  }
  return out;
}

NSArray<NSString *> *RBSuggestionsAIFromResponse(id response) {
  if (![response isKindOfClass:NSDictionary.class]) return @[];
  if (![response[@"source"] isKindOfClass:NSString.class] || ![response[@"source"] isEqualToString:@"model"]) return @[];
  id list = response[@"aiSuggestions"];
  if (![list isKindOfClass:NSArray.class]) return @[];
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  for (id raw in list) {
    NSString *text = RBSuggestionsTrim(raw);
    if (text.length && ![out containsObject:text]) [out addObject:text];
    if (out.count >= RBSuggestionsMaxAI) break;
  }
  return out;
}

NSArray<NSDictionary *> *RBSuggestionsMergeItemsWithFrequent(NSArray *phrases, NSArray *ai, NSArray *frequent,
                                                             NSUInteger maxAI) {
  NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  for (id raw in phrases ?: @[]) {
    NSString *text = RBSuggestionsTrim([raw isKindOfClass:NSDictionary.class] ? raw[@"text"] : raw);
    if (!text.length) continue;
    NSString *key = text.lowercaseString;
    if ([seen containsObject:key]) continue;
    [seen addObject:key];
    [out addObject:@{ @"type" : @"phrase", @"text" : text }];
  }
  NSUInteger nonPhraseCount = 0;
  for (id raw in ai ?: @[]) {
    if (nonPhraseCount >= maxAI) break;
    NSString *text = RBSuggestionsTrim([raw isKindOfClass:NSDictionary.class] ? raw[@"text"] : raw);
    if (!text.length) continue;
    NSString *key = text.lowercaseString;
    if ([seen containsObject:key]) continue;
    [seen addObject:key];
    [out addObject:@{ @"type" : @"ai", @"text" : text }];
    nonPhraseCount++;
  }
  for (id raw in frequent ?: @[]) {
    if (nonPhraseCount >= maxAI) break;
    NSString *text = RBSuggestionsTrim([raw isKindOfClass:NSDictionary.class] ? raw[@"text"] : raw);
    if (!text.length) continue;
    NSString *key = text.lowercaseString;
    if ([seen containsObject:key]) continue;
    [seen addObject:key];
    [out addObject:@{ @"type" : @"frequent", @"text" : text }];
    nonPhraseCount++;
  }
  return out;
}

NSArray<NSDictionary *> *RBSuggestionsMergeItems(NSArray *phrases, NSArray *ai) {
  return RBSuggestionsMergeItemsWithFrequent(phrases, ai, nil, RBSuggestionsMaxAI);
}

BOOL RBSuggestionsPlaceholderAllowed(NSString *placeholder) {
  NSString *lower = [placeholder isKindOfClass:NSString.class] ? placeholder.lowercaseString : @"";
  for (NSString *blocked in @[@"搜索", @"搜尋", @"名称", @"名稱", @"密码", @"网址"])
    if ([lower containsString:blocked]) return NO;
  // English keywords must be whole words: the composer placeholder contains Bot names
  // such as "Message Research Analyst", which must not match "search".
  static NSRegularExpression *words;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    words = [NSRegularExpression regularExpressionWithPattern:@"\\b(search|name|password|url)\\b" options:0 error:nil];
  });
  return [words firstMatchInString:lower options:0 range:NSMakeRange(0, lower.length)] == nil;
}

NSDictionary *RBSuggestionsSendBody(NSString *agentId, NSString *text, NSString *nonce) {
  return @{
    @"agentId" : agentId ?: @"",
    @"clientNonce" : nonce.length ? nonce : NSUUID.UUID.UUIDString.lowercaseString,
    @"prompt" : RBSuggestionsTrim(text),
    @"directAddressedAcceptance" : @YES,
  };
}

static BOOL RBSuggestionsValidAgentId(id agent) {
  if (![agent isKindOfClass:NSString.class]) return NO;
  NSString *value = agent;
  if (value.length == 0 || value.length > 128) return NO;
  static NSCharacterSet *invalid;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    invalid = [[NSCharacterSet characterSetWithCharactersInString:
        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"] invertedSet];
  });
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

static NSString *RBSuggestionsClip(NSString *value, NSUInteger maxLen) {
  if (!value.length || value.length <= maxLen) return value ?: @"";
  NSRange r = [value rangeOfComposedCharacterSequenceAtIndex:maxLen - 1];
  NSUInteger end = NSMaxRange(r) <= maxLen ? NSMaxRange(r) : r.location;
  return [value substringToIndex:end];
}

NSDictionary *RBSuggestionsFeedbackBody(NSString *agentId, NSString *action, NSString *text,
                                        NSArray<NSDictionary *> *shownItems) {
  NSString *agent = RBSuggestionsTrim(agentId);
  if (!RBSuggestionsValidAgentId(agent)) return nil;
  if (![action isKindOfClass:NSString.class] ||
      (![action isEqualToString:@"tap"] && ![action isEqualToString:@"dismiss"]))
    return nil;
  NSMutableArray<NSString *> *shown = [NSMutableArray array];
  if ([shownItems isKindOfClass:NSArray.class]) {
    for (id raw in shownItems) {
      if (shown.count >= RBSuggestionsMaxFeedbackShown) break;
      if (![raw isKindOfClass:NSDictionary.class]) continue;
      id type = raw[@"type"];
      if (![type isKindOfClass:NSString.class] ||
          (![type isEqualToString:@"ai"] && ![type isEqualToString:@"frequent"]))
        continue;
      NSString *itemText = RBSuggestionsClip(RBSuggestionsTrim(raw[@"text"]), RBSuggestionsMaxFeedbackText);
      if (itemText.length) [shown addObject:itemText];
    }
  }
  if ([action isEqualToString:@"dismiss"] && !shown.count) return nil;
  NSString *cleanText = [action isEqualToString:@"dismiss"]
      ? @"" : RBSuggestionsClip(RBSuggestionsTrim(text), RBSuggestionsMaxFeedbackText);
  return @{
    @"agentId" : agent,
    @"action" : action,
    @"text" : cleanText,
    @"shown" : shown,
  };
}

NSString *RBSuggestionsNormalize(NSString *text) {
  if (![text isKindOfClass:NSString.class]) return @"";
  NSString *s = [text stringByReplacingOccurrencesOfString:@"\u200B" withString:@" "];
  NSArray<NSString *> *parts = [s componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSMutableArray<NSString *> *nonEmpty = [NSMutableArray array];
  for (NSString *part in parts) {
    if (part.length) [nonEmpty addObject:part];
  }
  return [[nonEmpty componentsJoinedByString:@" "] lowercaseString];
}

static BOOL RBSuggestionsInOrder(NSString *q, NSString *key) {
  __block NSUInteger at = 0;
  __block BOOL ok = YES;
  [q enumerateSubstringsInRange:NSMakeRange(0, q.length)
                        options:NSStringEnumerationByComposedCharacterSequences
                     usingBlock:^(NSString *ch, NSRange r, NSRange e, BOOL *stop) {
                       if ([ch isEqualToString:@" "]) return;
                       if (at >= key.length) {
                         ok = NO;
                         *stop = YES;
                         return;
                       }
                       NSRange found = [key rangeOfString:ch options:0 range:NSMakeRange(at, key.length - at)];
                       if (found.location == NSNotFound) {
                         ok = NO;
                         *stop = YES;
                         return;
                       }
                       at = NSMaxRange(found);
                     }];
  return ok;
}

NSArray<NSString *> *RBSuggestionsHabitPool(NSArray *phrases, NSArray *candidates) {
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  for (NSArray *list in @[ phrases ?: @[], candidates ?: @[] ]) {
    if (![list isKindOfClass:NSArray.class]) continue;
    for (id raw in list) {
      NSString *text = RBSuggestionsTrim([raw isKindOfClass:NSDictionary.class] ? raw[@"text"] : raw);
      NSString *key = RBSuggestionsNormalize(text);
      if (key.length && ![seen containsObject:key]) {
        [seen addObject:key];
        [out addObject:text];
      }
    }
  }
  return out;
}

NSArray<NSString *> *RBSuggestionsHabitMatch(NSString *draft, NSArray<NSString *> *pool, NSUInteger max) {
  NSString *q = RBSuggestionsNormalize(draft);
  if (!q.length || ![pool isKindOfClass:NSArray.class] || !pool.count || max == 0) return @[];
  NSMutableArray<NSString *> *prefix = [NSMutableArray array];
  NSMutableArray<NSString *> *substring = [NSMutableArray array];
  NSMutableArray<NSString *> *fuzzy = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  BOOL allowFuzzy = RBSuggestionsCharCount(q) >= 2;
  for (id raw in pool) {
    NSString *text = RBSuggestionsTrim([raw isKindOfClass:NSDictionary.class] ? raw[@"text"] : raw);
    NSString *key = RBSuggestionsNormalize(text);
    if (!key.length || [key isEqualToString:q] || key.length <= q.length || [seen containsObject:key]) continue;
    [seen addObject:key];
    if ([key hasPrefix:q]) [prefix addObject:text];
    else if ([key containsString:q]) [substring addObject:text];
    else if (allowFuzzy && RBSuggestionsInOrder(q, key)) [fuzzy addObject:text];
  }
  NSMutableArray<NSString *> *out = [NSMutableArray arrayWithCapacity:prefix.count + substring.count + fuzzy.count];
  [out addObjectsFromArray:prefix];
  [out addObjectsFromArray:substring];
  [out addObjectsFromArray:fuzzy];
  return out.count > max ? [out subarrayWithRange:NSMakeRange(0, max)] : out;
}

NSString *RBSuggestionsAgentFromRequest(NSString *path, NSData *body, RBSuggestionsSignal *signalOut) {
  if (signalOut) *signalOut = RBSuggestionsSignalNone;
  if (![path hasPrefix:@"/api/"] || !body.length || body.length > 512 * 1024) return nil;
  // Only navigation (and sending) decides which bot is on screen. Everything else is a
  // read RN also performs for bots working in the background.
  static NSDictionary<NSString *, NSNumber *> *signals;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    signals = @{
      @"openAgentWindowed" : @(RBSuggestionsSignalActivate),
      @"markAgentViewed" : @(RBSuggestionsSignalActivate),
      @"sendPrompt" : @(RBSuggestionsSignalTurn),
      @"getAgentTranscriptTail" : @(RBSuggestionsSignalWeak),
      @"getAgentTranscript" : @(RBSuggestionsSignalWeak),
      @"getAgentTranscriptWindow" : @(RBSuggestionsSignalWeak),
      @"getAgent" : @(RBSuggestionsSignalWeak),
      @"markAgentRead" : @(RBSuggestionsSignalWeak),
      @"getForeverBoxStatus" : @(RBSuggestionsSignalWeak),
    };
  });
  NSString *method = path.lastPathComponent;
  NSNumber *signal = signals[method];
  if (!signal) return nil;
  id json = [NSJSONSerialization JSONObjectWithData:body options:0 error:nil];
  if (![json isKindOfClass:NSDictionary.class]) return nil;
  NSString *agent = nil;
  for (NSString *key in @[@"agentId", @"id", @"agent_id"]) {
    if ([json[key] isKindOfClass:NSString.class] && [json[key] length]) {
      agent = json[key];
      break;
    }
  }
  if (!RBSuggestionsValidAgentId(agent)) return nil;
  if (signalOut) *signalOut = (RBSuggestionsSignal)signal.integerValue;
  return agent;
}

NSString *RBSuggestionsResolveAgent(NSString *current, NSString *observed, RBSuggestionsSignal signal) {
  if ((signal == RBSuggestionsSignalActivate || signal == RBSuggestionsSignalTurn) && RBSuggestionsValidAgentId(observed))
    return observed;
  return current;
}

NSString *RBSuggestionsCacheKey(NSString *agentId, NSUInteger generation, NSString *locale) {
  return [NSString stringWithFormat:@"%@:%lu:%@", agentId ?: @"", (unsigned long)generation, locale ?: @""];
}

BOOL RBSuggestionsAcceptResponse(id response, NSString *requestAgent, NSString *requestId, NSString *currentAgent,
                                 NSUInteger requestSeq, NSUInteger latestSeq) {
  if (requestSeq != latestSeq) return NO;
  if (!requestAgent.length || ![requestAgent isEqualToString:currentAgent ?: @""]) return NO;
  if (![response isKindOfClass:NSDictionary.class]) return YES; // Nothing to show; caller handles errors.
  id echoedAgent = response[@"agentId"];
  if (echoedAgent && echoedAgent != NSNull.null &&
      (![echoedAgent isKindOfClass:NSString.class] || ![echoedAgent isEqualToString:requestAgent]))
    return NO;
  id echoedRequest = response[@"requestId"];
  if (requestId.length && echoedRequest && echoedRequest != NSNull.null &&
      (![echoedRequest isKindOfClass:NSString.class] || ![echoedRequest isEqualToString:requestId]))
    return NO;
  return YES;
}

NSDictionary *RBSuggestionsRequestBody(NSString *agentId, NSString *locale, NSString *requestId, BOOL prefetch) {
  NSMutableDictionary *body = [NSMutableDictionary dictionaryWithObject:agentId ?: @"" forKey:@"agentId"];
  if (locale.length) body[@"locale"] = locale;
  if (requestId.length) body[@"requestId"] = requestId.length > 64 ? [requestId substringToIndex:64] : requestId;
  if (prefetch) body[@"prefetch"] = @YES;
  return body;
}

NSDictionary *RBSuggestionsCompleteBody(NSString *agentId, NSString *text, NSString *locale) {
  NSMutableDictionary *body = [NSMutableDictionary dictionary];
  body[@"agentId"] = agentId ?: @"";
  body[@"text"] = text ?: @"";
  if (locale.length) body[@"locale"] = locale;
  return body;
}

NSString *RBSuggestionsValidatePhrase(NSString *text, NSArray<NSDictionary *> *existing, NSString *editingId, BOOL chinese) {
  NSString *clean = RBSuggestionsTrim(text);
  clean = [[clean componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
  if (!clean.length) return chinese ? @"常用语不能为空" : @"Quick phrase cannot be empty";
  if (RBSuggestionsCharCount(clean) > RBSuggestionsMaxPhraseChars)
    return chinese ? @"常用语最多 120 个字符" : @"Quick phrases can be up to 120 characters";
  NSUInteger others = 0;
  for (NSDictionary *phrase in existing ?: @[]) {
    if (editingId.length && [phrase[@"id"] isEqual:editingId]) continue;
    others++;
    if ([RBSuggestionsTrim(phrase[@"text"]).lowercaseString isEqualToString:clean.lowercaseString])
      return chinese ? @"常用语不能重复" : @"This quick phrase already exists";
  }
  if (!editingId.length && others >= RBSuggestionsMaxPhrases)
    return chinese ? @"最多保存 50 条常用语" : @"You can save up to 50 quick phrases";
  return nil;
}

NSArray<NSString *> *RBSuggestionsMovedIds(NSArray<NSDictionary *> *phrases, NSUInteger index, NSInteger delta) {
  NSInteger target = (NSInteger)index + delta;
  if (index >= phrases.count || target < 0 || target >= (NSInteger)phrases.count || delta == 0) return nil;
  NSMutableArray<NSString *> *ids = [NSMutableArray array];
  for (NSDictionary *phrase in phrases) {
    NSString *pid = RBSuggestionsTrim(phrase[@"id"]);
    if (!pid.length) return nil;
    [ids addObject:pid];
  }
  NSString *moving = ids[index];
  [ids removeObjectAtIndex:index];
  [ids insertObject:moving atIndex:(NSUInteger)target];
  return ids;
}

#pragma mark - RBChatHistoryHints

@implementation RBChatHistoryHints {
  NSMutableDictionary<NSString *, NSNumber *> *_hints;
  NSMutableArray<NSString *> *_order;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _hints = [NSMutableDictionary dictionary];
    _order = [NSMutableArray array];
  }
  return self;
}

- (NSString *)norm:(NSString *)agentId {
  return RBSuggestionsTrim(agentId);
}

- (void)recordAgent:(NSString *)agentId source:(NSString *)source {
  NSString *key = [self norm:agentId];
  if (!key.length || ![source isKindOfClass:NSString.class]) return;
  NSNumber *flag = nil;
  if ([source isEqualToString:@"empty"]) flag = @NO;
  else if ([source isEqualToString:@"model"]) flag = @YES;
  if (!flag) return;
  @synchronized (self) {
    [_order removeObject:key];
    [_order addObject:key];
    _hints[key] = flag;
    while (_order.count > RBHistoryHintsMax) {
      NSString *oldest = _order.firstObject;
      [_order removeObjectAtIndex:0];
      if (oldest) [_hints removeObjectForKey:oldest];
    }
  }
}

- (void)forgetAgent:(NSString *)agentId {
  NSString *key = [self norm:agentId];
  if (!key.length) return;
  @synchronized (self) {
    [_hints removeObjectForKey:key];
    [_order removeObject:key];
  }
}

- (void)clear {
  @synchronized (self) {
    [_hints removeAllObjects];
    [_order removeAllObjects];
  }
}

- (NSNumber *)hintForAgent:(NSString *)agentId {
  NSString *key = [self norm:agentId];
  if (!key.length) return nil;
  @synchronized (self) {
    return _hints[key];
  }
}

- (BOOL)mayHaveHistory:(NSString *)agentId {
  NSString *key = [self norm:agentId];
  if (!key.length) return NO;
  @synchronized (self) {
    NSNumber *hint = _hints[key];
    return hint == nil || hint.boolValue;
  }
}

@end

#pragma mark - RBSuggestionLoadState

@implementation RBSuggestionLoadState {
  RBSuggestionLoadPhase _phase;
  NSUInteger _token;
  NSString *_key;
  NSTimeInterval _startedAt;
  NSArray<NSString *> *_items;
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _phase = RBSuggestionLoadPhaseIdle;
    _key = @"";
    _items = @[];
  }
  return self;
}

- (RBSuggestionLoadPhase)phase { @synchronized (self) { return _phase; } }
- (NSUInteger)token { @synchronized (self) { return _token; } }
- (NSString *)key { @synchronized (self) { return _key; } }
- (NSArray<NSString *> *)items { @synchronized (self) { return _items; } }

- (NSUInteger)beginKey:(NSString *)key now:(NSTimeInterval)now {
  @synchronized (self) {
    _token++;
    _key = [key ?: @"" copy];
    _phase = RBSuggestionLoadPhaseLoading;
    _startedAt = now;
    _items = @[];
    return _token;
  }
}

- (BOOL)succeedToken:(NSUInteger)token items:(NSArray<NSString *> *)items {
  @synchronized (self) {
    if (token != _token || _phase != RBSuggestionLoadPhaseLoading) return NO;
    NSMutableArray<NSString *> *clean = [NSMutableArray array];
    for (id raw in items ?: @[]) {
      NSString *text = RBSuggestionsTrim(raw);
      if (text.length) [clean addObject:text];
    }
    if (!clean.count) {
      _phase = RBSuggestionLoadPhaseFailed;
      _items = @[];
    } else {
      _phase = RBSuggestionLoadPhaseReady;
      _items = [clean copy];
    }
    return YES;
  }
}

- (BOOL)failToken:(NSUInteger)token {
  @synchronized (self) {
    if (token != _token || _phase != RBSuggestionLoadPhaseLoading) return NO;
    _phase = RBSuggestionLoadPhaseFailed;
    _items = @[];
    return YES;
  }
}

- (BOOL)settleToken:(NSUInteger)token {
  @synchronized (self) {
    if (token != _token || _phase != RBSuggestionLoadPhaseFailed) return NO;
    _phase = RBSuggestionLoadPhaseIdle;
    return YES;
  }
}

- (void)cancel {
  @synchronized (self) {
    _token++;
    _phase = RBSuggestionLoadPhaseIdle;
    _key = @"";
    _items = @[];
  }
}

- (void)readyKey:(NSString *)key items:(NSArray<NSString *> *)items {
  @synchronized (self) {
    _token++;
    _key = [key ?: @"" copy];
    NSMutableArray<NSString *> *clean = [NSMutableArray array];
    for (id raw in items ?: @[]) {
      NSString *text = RBSuggestionsTrim(raw);
      if (text.length) [clean addObject:text];
    }
    _phase = clean.count ? RBSuggestionLoadPhaseReady : RBSuggestionLoadPhaseIdle;
    _items = [clean copy];
  }
}

- (NSUInteger)placeholdersAt:(NSTimeInterval)now {
  @synchronized (self) {
    if (_phase != RBSuggestionLoadPhaseLoading) return 0;
    return (now - _startedAt >= RBSuggestionsPlaceholderDelay) ? RBSuggestionsPlaceholderCount : 0;
  }
}

- (NSTimeInterval)placeholderDelayLeftAt:(NSTimeInterval)now {
  @synchronized (self) {
    if (_phase != RBSuggestionLoadPhaseLoading) return 0;
    NSTimeInterval left = RBSuggestionsPlaceholderDelay - (now - _startedAt);
    return left > 0 ? left : 0;
  }
}

@end

#pragma mark - RBInlineCompletionEngine

@interface RBInlineCompletionRequest ()
@property(nonatomic, assign, readwrite) NSUInteger seq;
@property(nonatomic, copy, readwrite) NSString *agentId;
@property(nonatomic, copy, readwrite) NSString *draft;
@end

@implementation RBInlineCompletionRequest
- (instancetype)initWithSeq:(NSUInteger)seq agentId:(NSString *)agentId draft:(NSString *)draft {
  self = [super init];
  if (self) {
    _seq = seq;
    _agentId = [agentId copy];
    _draft = [draft copy];
  }
  return self;
}
@end

@implementation RBInlineCompletionEngine {
  RBChatHistoryHints *_hints;
  NSMutableDictionary<NSString *, NSString *> *_cache;
  NSMutableArray<NSString *> *_cacheOrder;
  BOOL _enabled;
  NSUInteger _seq;
  NSString *_agentId;
  NSString *_base;
  NSString *_completion;
  NSString *_pendingDraft;
  NSTimeInterval _dueAt;
  RBInlineCompletionRequest *_inFlight;
  NSString *_suppressDraft;
  NSUInteger _requestsIssued;
}

- (instancetype)init {
  return [self initWithHints:nil];
}

- (instancetype)initWithHints:(RBChatHistoryHints *)hints {
  self = [super init];
  if (self) {
    _hints = hints ?: [RBChatHistoryHints new];
    _cache = [NSMutableDictionary dictionary];
    _cacheOrder = [NSMutableArray array];
    _enabled = YES;
    _agentId = @"";
    _completion = @"";
    _dueAt = -1;
  }
  return self;
}

+ (NSString *)cacheKeyForAgent:(NSString *)agentId draft:(NSString *)draft {
  return [NSString stringWithFormat:@"%@\x01%@", agentId ?: @"", draft ?: @""];
}

+ (BOOL)eligibleEnabled:(BOOL)enabled agentId:(NSString *)agentId draft:(NSString *)draft
              composing:(BOOL)composing cursorAtEnd:(BOOL)cursorAtEnd mayHaveHistory:(BOOL)mayHaveHistory {
  if (!enabled || composing || !cursorAtEnd || !mayHaveHistory) return NO;
  if (!RBSuggestionsTrim(agentId).length) return NO;
  return RBSuggestionsCharCount(RBSuggestionsTrim(draft)) >= RBCompletionMinChars;
}

+ (NSString *)remainingSuffixForBase:(NSString *)base completion:(NSString *)completion draft:(NSString *)draft {
  if (!base || !completion.length || !draft) return nil;
  NSString *full = [base stringByAppendingString:completion];
  if (draft.length < base.length || draft.length >= full.length) return nil;
  if (![full hasPrefix:draft]) return nil;
  return [full substringFromIndex:draft.length];
}

- (BOOL)enabled { @synchronized (self) { return _enabled; } }
- (void)setEnabled:(BOOL)enabled {
  @synchronized (self) {
    if (_enabled == enabled) return;
    _enabled = enabled;
    if (!enabled) [self resetLocked];
  }
}

- (NSUInteger)sequence { @synchronized (self) { return _seq; } }
- (NSUInteger)requestsIssued { @synchronized (self) { return _requestsIssued; } }
- (NSUInteger)cacheSize { @synchronized (self) { return _cache.count; } }
- (BOOL)hasPending { @synchronized (self) { return _pendingDraft != nil; } }
- (NSTimeInterval)dueAt { @synchronized (self) { return _dueAt; } }

- (void)dropShownLocked {
  _base = nil;
  _completion = @"";
}

- (void)dropPendingLocked {
  if (_pendingDraft != nil || _inFlight != nil) _seq++;
  _pendingDraft = nil;
  _dueAt = -1;
  _inFlight = nil;
}

- (void)resetLocked {
  [self dropShownLocked];
  [self dropPendingLocked];
  _suppressDraft = nil;
}

- (NSString *)cacheGetLocked:(NSString *)key {
  NSString *value = _cache[key];
  if (!value) return nil;
  [_cacheOrder removeObject:key];
  [_cacheOrder addObject:key];
  return value;
}

- (void)cacheSetLocked:(NSString *)value forKey:(NSString *)key {
  [_cacheOrder removeObject:key];
  [_cacheOrder addObject:key];
  _cache[key] = value;
  while (_cacheOrder.count > RBCompletionCacheLimit) {
    NSString *oldest = _cacheOrder.firstObject;
    [_cacheOrder removeObjectAtIndex:0];
    if (oldest) [_cache removeObjectForKey:oldest];
  }
}

- (NSString *)onDraftChanged:(NSString *)draft agentId:(NSString *)agentId
                   composing:(BOOL)composing cursorAtEnd:(BOOL)cursorAtEnd now:(NSTimeInterval)now {
  @synchronized (self) {
    NSString *agent = RBSuggestionsTrim(agentId);
    NSString *text = [draft isKindOfClass:NSString.class] ? draft : @"";
    if (![agent isEqualToString:_agentId]) {
      [self resetLocked];
      _agentId = agent;
    }
    if (composing || !cursorAtEnd || !_enabled) {
      [self dropShownLocked];
      [self dropPendingLocked];
      return @"";
    }
    NSString *rest = [RBInlineCompletionEngine remainingSuffixForBase:_base completion:_completion draft:text];
    if (rest && RBSuggestionsCharCount(RBSuggestionsTrim(text)) >= RBCompletionMinChars) {
      [self dropPendingLocked];
      return rest;
    }
    [self dropShownLocked];
    if (_suppressDraft && [_suppressDraft isEqualToString:text]) {
      [self dropPendingLocked];
      return @"";
    }
    _suppressDraft = nil;
    if (![RBInlineCompletionEngine eligibleEnabled:_enabled agentId:agent draft:text
                                         composing:NO cursorAtEnd:YES mayHaveHistory:[_hints mayHaveHistory:agent]]) {
      [self dropPendingLocked];
      return @"";
    }
    NSString *key = [RBInlineCompletionEngine cacheKeyForAgent:agent draft:text];
    NSString *hit = [self cacheGetLocked:key];
    if (hit != nil) {
      [self dropPendingLocked];
      if (!hit.length) return @"";
      _base = [text copy];
      _completion = [hit copy];
      return hit;
    }
    if (_pendingDraft && [_pendingDraft isEqualToString:text]) return @"";
    if (_inFlight && [_inFlight.draft isEqualToString:text] && _pendingDraft == nil) return @"";
    _seq++;
    _inFlight = nil;
    _pendingDraft = [text copy];
    _dueAt = now + RBCompletionDebounce;
    return @"";
  }
}

- (RBInlineCompletionRequest *)pollAt:(NSTimeInterval)now {
  @synchronized (self) {
    if (_pendingDraft == nil || now < _dueAt) return nil;
    RBInlineCompletionRequest *request = [[RBInlineCompletionRequest alloc] initWithSeq:_seq agentId:_agentId draft:_pendingDraft];
    _pendingDraft = nil;
    _dueAt = -1;
    _inFlight = request;
    _requestsIssued++;
    return request;
  }
}

- (BOOL)isCurrentRequest:(RBInlineCompletionRequest *)request {
  @synchronized (self) {
    return request != nil && request == _inFlight && request.seq == _seq;
  }
}

- (NSString *)onResponseForRequest:(RBInlineCompletionRequest *)request
                        completion:(NSString *)completion
                            source:(NSString *)source
                      currentDraft:(NSString *)currentDraft {
  @synchronized (self) {
    [_hints recordAgent:request.agentId source:source];
    if (!(request != nil && request == _inFlight && request.seq == _seq)) return nil;
    _inFlight = nil;
    NSString *suffix = [completion isKindOfClass:NSString.class] ? completion : @"";
    if ([source isEqualToString:@"model"]) {
      [self cacheSetLocked:suffix forKey:[RBInlineCompletionEngine cacheKeyForAgent:request.agentId draft:request.draft]];
    }
    if (!suffix.length || !_enabled) return @"";
    if (!currentDraft || ![currentDraft isEqualToString:request.draft]) {
      NSString *rest = [RBInlineCompletionEngine remainingSuffixForBase:request.draft completion:suffix draft:currentDraft];
      if (!rest) return @"";
      _base = [request.draft copy];
      _completion = [suffix copy];
      return rest;
    }
    _base = [request.draft copy];
    _completion = [suffix copy];
    return suffix;
  }
}

- (void)onFailureForRequest:(RBInlineCompletionRequest *)request {
  @synchronized (self) {
    if (request != nil && request == _inFlight && request.seq == _seq) _inFlight = nil;
  }
}

- (NSString *)acceptDraft:(NSString *)draft {
  @synchronized (self) {
    NSString *text = draft ?: @"";
    NSString *rest = [RBInlineCompletionEngine remainingSuffixForBase:_base completion:_completion draft:text];
    if (!rest && _base && [_base isEqualToString:text] && _completion.length) rest = _completion;
    if (!rest) return nil;
    NSString *full = [text stringByAppendingString:rest];
    [self dropShownLocked];
    [self dropPendingLocked];
    _suppressDraft = [full copy];
    return full;
  }
}

- (NSString *)shownSuffixForDraft:(NSString *)draft {
  @synchronized (self) {
    NSString *text = draft ?: @"";
    NSString *rest = [RBInlineCompletionEngine remainingSuffixForBase:_base completion:_completion draft:text];
    if (rest) return rest;
    if (_base && [_base isEqualToString:text]) return _completion ?: @"";
    return @"";
  }
}

- (void)reset {
  @synchronized (self) { [self resetLocked]; }
}

- (void)clearCache {
  @synchronized (self) {
    [_cache removeAllObjects];
    [_cacheOrder removeAllObjects];
  }
}

@end

#if TARGET_OS_IOS

#import "RBConnection.h"
#import "RBHostAPI.h"
#import "RBLocalize.h"
#import "RBTheme.h"
#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>

// The bot on screen. Only navigation signals (openAgentWindowed, markAgentViewed, sendPrompt,
// notification / deep-link opens) change it; background reads never do. Main queue only.
static NSString *RBActiveAgent;
// Per-bot turn generation: bumped only by that bot's sendPrompt or a new reply from it.
static NSMutableDictionary<NSString *, NSNumber *> *RBAgentGenerations;
static const NSTimeInterval RBSuggestionsTimeout = 9;
static const NSTimeInterval RBSuggestionsCacheTTL = 90;
static const NSTimeInterval RBSuggestionsFailureBackoff = 10;
static const NSTimeInterval RBSuggestionsPrefetchThrottle = 20;
static const NSTimeInterval RBSuggestionsReplyThrottle = 4;

NSString *RBSuggestionsCurrentAgent(void) { return RBActiveAgent; }

static NSUInteger RBSuggestionsGeneration(NSString *agent) {
  if (!agent.length) return 0;
  return [RBAgentGenerations[agent] unsignedIntegerValue] + 1;
}

static void RBSuggestionsBumpGeneration(NSString *agent) {
  if (!agent.length) return;
  if (!RBAgentGenerations) RBAgentGenerations = [NSMutableDictionary dictionary];
  if (RBAgentGenerations.count > 200 && !RBAgentGenerations[agent]) [RBAgentGenerations removeAllObjects];
  RBAgentGenerations[agent] = @([RBAgentGenerations[agent] unsignedIntegerValue] + 1);
}

static NSString *RBSuggestionsLocaleTag(void) { return RBIsChinese() ? @"zh" : @"en"; }

static NSString *RBSuggestionsLocale(void) {
  return RBIsChinese() ? @"zh-CN" : (NSLocale.preferredLanguages.firstObject ?: @"en");
}

static NSString *RBSuggestionsKeyFor(NSString *agent) {
  return RBSuggestionsCacheKey(agent, RBSuggestionsGeneration(agent), RBSuggestionsLocaleTag());
}

// Compact chip font: 12.5pt, Dynamic Type capped at 15pt so the row stays ~26-28pt tall.
static UIFont *RBSuggestionsChipFont(void) {
  return [[UIFontMetrics defaultMetrics] scaledFontForFont:[UIFont systemFontOfSize:12.5 weight:UIFontWeightMedium]
                                          maximumPointSize:15];
}

static CGFloat RBSuggestionsChipHeight(void) {
  return MIN(28, MAX(26, ceil(RBSuggestionsChipFont().lineHeight) + 9));
}

static UIColor *RBSuggestionsPhraseFill(void) {
  return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
    return t.userInterfaceStyle == UIUserInterfaceStyleDark
        ? [UIColor colorWithRed:0x1D / 255.0 green:0x2B / 255.0 blue:0x42 / 255.0 alpha:0.94]
        : [UIColor colorWithRed:0xEE / 255.0 green:0xF5 / 255.0 blue:0xFF / 255.0 alpha:0.97];
  }];
}

static UIColor *RBSuggestionsPhraseBorder(void) {
  return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
    return t.userInterfaceStyle == UIUserInterfaceStyleDark
        ? [UIColor colorWithRed:0x3B / 255.0 green:0x82 / 255.0 blue:0xF6 / 255.0 alpha:0.60]
        : [UIColor colorWithRed:0x16 / 255.0 green:0x77 / 255.0 blue:0xFF / 255.0 alpha:0.40];
  }];
}

#pragma mark - Shimmer placeholder pill

@interface RBSkeletonPillView : UIView
@property(nonatomic, strong) CAGradientLayer *shimmer;
- (void)startShimmerWithDelay:(CFTimeInterval)delay;
- (void)stopShimmer;
@end

@implementation RBSkeletonPillView

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  self.clipsToBounds = YES;
  self.userInteractionEnabled = NO;
  self.accessibilityIdentifier = @"rokbot.suggestions.placeholder";
  _shimmer = [CAGradientLayer layer];
  _shimmer.startPoint = CGPointMake(0, 0.5);
  _shimmer.endPoint = CGPointMake(1, 0.5);
  _shimmer.locations = @[ @(-0.5), @(-0.25), @(0.0) ];
  [self.layer addSublayer:_shimmer];
  [self applyColors];
  return self;
}

- (void)applyColors {
  BOOL dark = self.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
  self.backgroundColor = dark ? [UIColor colorWithRed:0x2A / 255.0 green:0x2A / 255.0 blue:0x31 / 255.0 alpha:1]
                              : [UIColor colorWithRed:0xE4 / 255.0 green:0xE6 / 255.0 blue:0xEB / 255.0 alpha:1];
  UIColor *clear = [UIColor colorWithWhite:1 alpha:0];
  UIColor *shine = [UIColor colorWithWhite:1 alpha:dark ? 0.24 : 0.85];
  self.shimmer.colors = @[ (id)clear.CGColor, (id)shine.CGColor, (id)clear.CGColor ];
}

- (void)layoutSubviews {
  [super layoutSubviews];
  self.layer.cornerRadius = self.bounds.size.height / 2.0;
  self.shimmer.frame = self.bounds;
}

- (void)traitCollectionDidChange:(UITraitCollection *)previous {
  [super traitCollectionDidChange:previous];
  [self applyColors];
}

- (void)startShimmerWithDelay:(CFTimeInterval)delay {
  if (UIAccessibilityIsReduceMotionEnabled()) {
    [self stopShimmer];
    return;
  }
  self.shimmer.hidden = NO;
  if ([self.shimmer animationForKey:@"rb.shimmer"]) return;
  CABasicAnimation *sweep = [CABasicAnimation animationWithKeyPath:@"locations"];
  sweep.fromValue = @[ @(-0.6), @(-0.3), @(0.0) ];
  sweep.toValue = @[ @(1.0), @(1.3), @(1.6) ];
  sweep.duration = 1.25;
  sweep.repeatCount = HUGE_VALF;
  sweep.beginTime = CACurrentMediaTime() + delay;
  sweep.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionLinear];
  [self.shimmer addAnimation:sweep forKey:@"rb.shimmer"];
}

- (void)stopShimmer {
  [self.shimmer removeAnimationForKey:@"rb.shimmer"];
  self.shimmer.hidden = YES;
}

@end

#pragma mark - Suggestions bar

@interface RBSuggestionsBar : UIView
@property(nonatomic, strong) UIScrollView *scroll;
@property(nonatomic, strong) UIStackView *chips;
@property(nonatomic, strong) NSMutableArray<RBSkeletonPillView *> *skeletons;
@property(nonatomic, copy) NSString *signature;
@property(nonatomic, copy) NSString *activeKey;
@property(nonatomic, copy) NSArray<NSDictionary *> *boundItems;
@property(nonatomic, assign) BOOL hiding;
@property(nonatomic, assign) BOOL lastBoundWithoutPlaceholders;
@property(nonatomic, assign) NSUInteger animGeneration;
@property(nonatomic, copy) void (^onTap)(NSDictionary *item);
@property(nonatomic, copy) void (^onClose)(void);
- (void)bindKey:(NSString *)key items:(NSArray<NSDictionary *> *)items placeholders:(NSUInteger)placeholders;
- (void)reset;
@end

#pragma mark - Inline completion pill & ghost text

@interface RBCompletionPill : UIView
@property(nonatomic, strong) UIButton *pill;
@property(nonatomic, copy) NSString *shownText;
@property(nonatomic, copy) void (^onAccept)(void);
- (void)bindSuffix:(NSString *)suffix;
@end

@implementation RBCompletionPill

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  self.tag = 731994;
  self.accessibilityIdentifier = @"rokbot.completion.bar";
  self.backgroundColor = UIColor.clearColor;
  self.pill = [UIButton buttonWithType:UIButtonTypeCustom];
  self.pill.translatesAutoresizingMaskIntoConstraints = NO;
  self.pill.accessibilityIdentifier = @"rokbot.completion.accept";
  self.pill.accessibilityHint = RBL(@"点按采用补全", @"Tap to accept completion");
  [self.pill addTarget:self action:@selector(acceptTapped) forControlEvents:UIControlEventTouchUpInside];
  [self addSubview:self.pill];
  [NSLayoutConstraint activateConstraints:@[
    [self.pill.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:10],
    [self.pill.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
    [self.pill.trailingAnchor constraintLessThanOrEqualToAnchor:self.trailingAnchor constant:-10],
    [self.pill.heightAnchor constraintEqualToConstant:RBSuggestionsChipHeight()],
  ]];
  return self;
}

- (void)acceptTapped {
  if (self.onAccept) self.onAccept();
}

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  UIView *hit = [super hitTest:point withEvent:event];
  return hit == self ? nil : hit;
}

- (void)traitCollectionDidChange:(UITraitCollection *)previous {
  [super traitCollectionDidChange:previous];
  NSString *current = self.shownText;
  self.shownText = nil;
  if (current.length) [self bindSuffix:current];
}

- (void)bindSuffix:(NSString *)suffix {
  NSString *clean = [suffix stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
  if ([clean isEqualToString:self.shownText ?: @""]) return;
  self.shownText = clean;
  UIButtonConfiguration *config = UIButtonConfiguration.plainButtonConfiguration;
  config.image = RBGlyphImage(RBGlyphTab, 13, 1.5);
  config.imagePadding = 5;
  config.imageColorTransformer = ^UIColor *(UIColor *c) { return RBThemeAccent(); };
  config.contentInsets = NSDirectionalEdgeInsetsMake(4, 10, 4, 11);
  config.titleLineBreakMode = NSLineBreakByTruncatingTail;
  config.background.backgroundColor = RBSuggestionsPhraseFill();
  config.background.strokeColor = RBSuggestionsPhraseBorder();
  config.background.strokeWidth = 1.0 / UIScreen.mainScreen.scale;
  config.background.cornerRadius = RBSuggestionsChipHeight() / 2.0;

  NSMutableAttributedString *title = [[NSMutableAttributedString alloc]
      initWithString:RBL(@"补全", @"Complete")
          attributes:@{
            NSFontAttributeName : [[UIFontMetrics defaultMetrics]
                scaledFontForFont:[UIFont systemFontOfSize:12.5 weight:UIFontWeightSemibold] maximumPointSize:15],
            NSForegroundColorAttributeName : RBThemeAccent(),
          }];
  [title appendAttributedString:[[NSAttributedString alloc]
      initWithString:[@"  " stringByAppendingString:clean]
          attributes:@{
            NSFontAttributeName : RBSuggestionsChipFont(),
            NSForegroundColorAttributeName : RBThemeTextSecondary(),
          }]];
  config.attributedTitle = title;
  self.pill.configuration = config;
  self.pill.accessibilityLabel = [NSString stringWithFormat:@"%@：%@", RBL(@"补全", @"Complete"), clean];
}

@end

@interface RBGhostTextView : UIControl
@property(nonatomic, strong) UILabel *label;
@property(nonatomic, copy) void (^onAccept)(void);
- (void)bindSuffix:(NSString *)suffix font:(UIFont *)font;
@end

@implementation RBGhostTextView

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  self.tag = 731994;
  self.backgroundColor = UIColor.clearColor;
  self.accessibilityIdentifier = @"rokbot.completion.ghost";
  self.isAccessibilityElement = YES;
  self.accessibilityTraits = UIAccessibilityTraitButton;
  _label = [UILabel new];
  _label.numberOfLines = 1;
  _label.lineBreakMode = NSLineBreakByTruncatingTail;
  _label.textColor = RBThemeTextMuted();
  _label.userInteractionEnabled = NO;
  [self addSubview:_label];
  [self addTarget:self action:@selector(tapped) forControlEvents:UIControlEventTouchUpInside];
  return self;
}

- (void)tapped {
  if (self.onAccept) self.onAccept();
}

- (void)layoutSubviews {
  [super layoutSubviews];
  self.label.frame = self.bounds;
}

- (void)bindSuffix:(NSString *)suffix font:(UIFont *)font {
  NSString *oneLine = [suffix stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
  self.label.font = font ?: RBThemeFont(15, UIFontWeightRegular);
  self.label.textColor = RBThemeTextMuted();
  self.label.text = oneLine;
  self.accessibilityLabel = [NSString stringWithFormat:@"%@：%@", RBL(@"补全", @"Complete"), oneLine];
}

@end

#pragma mark - Runtime

@interface RBSuggestionsRuntime : NSObject
@property(nonatomic, weak) UIView *input;
@property(nonatomic, strong) RBSuggestionsBar *bar;
@property(nonatomic, strong) RBCompletionPill *completionPill;
@property(nonatomic, strong) RBGhostTextView *ghostView;
@property(nonatomic, strong) CADisplayLink *link;
@property(nonatomic, assign) BOOL enabled;
@property(nonatomic, assign) BOOL aiEnabled;
@property(nonatomic, assign) BOOL completionEnabled;
@property(nonatomic, assign) BOOL learningEnabled;
@property(nonatomic, assign) BOOL localCompletionEnabled;
@property(nonatomic, copy) NSArray<NSDictionary *> *phrases;
@property(nonatomic, strong) NSDate *settingsAt;
@property(nonatomic, assign) BOOL settingsLoading;
@property(nonatomic, strong) NSCache<NSString *, NSDictionary *> *aiCache;
@property(nonatomic, strong) NSCache<NSString *, NSArray<NSString *> *> *frequentCache;
@property(nonatomic, strong) NSCache<NSString *, NSArray<NSString *> *> *candidatesCache;
@property(nonatomic, strong) RBChatHistoryHints *historyHints;
@property(nonatomic, strong) RBSuggestionLoadState *loadState;
@property(nonatomic, strong) RBInlineCompletionEngine *completionEngine;
@property(nonatomic, strong) NSURLSessionDataTask *fetchTask;
@property(nonatomic, strong) NSURLSessionDataTask *completionTask;
@property(nonatomic, copy) NSString *fetchingKey;
// Monotonic request sequence; only the latest request's response may update the bar.
@property(nonatomic, assign) NSUInteger fetchSeq;
@property(nonatomic, strong) NSDate *fetchingAt;
@property(nonatomic, copy) NSString *failedKey;
@property(nonatomic, strong) NSDate *failedAt;
@property(nonatomic, copy) NSString *prefetchKey;
@property(nonatomic, strong) NSDate *prefetchAt;
@property(nonatomic, copy) NSString *replyAgent;
@property(nonatomic, strong) NSDate *replyAt;
@property(nonatomic, copy) NSString *dismissedKey;
@property(nonatomic, copy) NSString *dismissedMatchDraft;
@property(nonatomic, copy) NSString *shownSuffix;
@property(nonatomic, copy) NSString *lastObservedSignature;
@property(nonatomic, assign) BOOL sending;
+ (instancetype)shared;
- (void)refresh;
- (void)invalidate;
- (void)invalidateSettingsCache;
- (void)clearLearnedHabits;
- (void)activateAgent:(NSString *)agent turn:(BOOL)turn;
- (void)noteReply:(NSString *)agent;
@end

static NSString *RBSuggestionsInputText(UIView *input) {
  if ([input isKindOfClass:UITextView.class]) return ((UITextView *)input).text ?: @"";
  if ([input isKindOfClass:UITextField.class]) return ((UITextField *)input).text ?: @"";
  return @"";
}

static UIFont *RBSuggestionsInputFont(UIView *input) {
  if ([input isKindOfClass:UITextView.class]) return ((UITextView *)input).font;
  if ([input isKindOfClass:UITextField.class]) return ((UITextField *)input).font;
  return nil;
}

static BOOL RBSuggestionsIsComposing(UIView *input) {
  if (![input conformsToProtocol:@protocol(UITextInput)]) return NO;
  return [(id<UITextInput>)input markedTextRange] != nil;
}

static BOOL RBSuggestionsIsCursorAtEnd(UIView *input) {
  if (![input conformsToProtocol:@protocol(UITextInput)]) return NO;
  id<UITextInput> ti = (id<UITextInput>)input;
  UITextRange *sel = ti.selectedTextRange;
  if (!sel || !sel.isEmpty) return NO;
  return [ti comparePosition:sel.end toPosition:ti.endOfDocument] == NSOrderedSame;
}

static NSString *RBSuggestionsInputPlaceholder(UIView *input) {
  if ([input isKindOfClass:UITextField.class]) return ((UITextField *)input).placeholder ?: @"";
  SEL selector = NSSelectorFromString(@"placeholder");
  if ([input respondsToSelector:selector]) {
    id value = [input valueForKey:@"placeholder"];
    if ([value isKindOfClass:NSString.class]) return value;
  }
  return input.accessibilityLabel ?: @"";
}

static UIView *RBSuggestionsReactInputAncestor(UIView *view) {
  static Class inputClass;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ inputClass = NSClassFromString(@"RCTTextInputComponentView"); });
  UIView *cursor = view;
  for (NSUInteger depth = 0; cursor && depth < 4; depth++, cursor = cursor.superview)
    if (inputClass && [cursor isKindOfClass:inputClass]) return cursor;
  return nil;
}

static void RBSuggestionsCountInputs(UIView *view, NSUInteger depth, NSUInteger *count) {
  static Class inputClass;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ inputClass = NSClassFromString(@"RCTTextInputComponentView"); });
  if (!view || view.hidden || view.alpha < 0.01 || depth > 80 || *count > 1) return;
  if (inputClass && [view isKindOfClass:inputClass]) {
    if (view.window && view.bounds.size.width > 0 && view.bounds.size.height > 0) (*count)++;
    return;
  }
  for (UIView *child in view.subviews) RBSuggestionsCountInputs(child, depth + 1, count);
}

static BOOL RBSuggestionsIsComposer(UIView *input) {
  UIWindow *window = input.window;
  if (!window || !RBConnection.shared.isPaired) return NO;
  UIView *reactInput = RBSuggestionsReactInputAncestor(input);
  if (!reactInput) return NO;
  CGRect frame = [input convertRect:input.bounds toView:window];
  CGFloat screenH = window.bounds.size.height;
  if (frame.size.width < 120 || frame.size.height <= 0 || frame.size.height > 180) return NO;
  if (CGRectGetMaxY(frame) < screenH * 0.25 || frame.origin.y < 90) return NO;
  if (!RBSuggestionsPlaceholderAllowed(RBSuggestionsInputPlaceholder(input))) return NO;
  if ([input isKindOfClass:UITextField.class] && ((UITextField *)input).secureTextEntry) return NO;
  NSUInteger count = 0;
  // Walk the whole window so modally presented chat screens are included.
  RBSuggestionsCountInputs(window, 0, &count);
  return count == 1;
}

static CGRect RBSuggestionsAnchorRect(UIView *input) {
  UIWindow *window = input.window;
  UIView *best = RBSuggestionsReactInputAncestor(input) ?: input;
  UIView *cursor = best;
  for (NSUInteger i = 0; i < 3 && cursor.superview; i++) {
    UIView *parent = cursor.superview;
    if (parent.bounds.size.height <= 0 || parent.bounds.size.height > 130) break;
    best = parent;
    cursor = parent;
  }
  return [best convertRect:best.bounds toView:window];
}

@implementation RBSuggestionsBar

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  self.tag = 731994;
  self.accessibilityIdentifier = @"rokbot.suggestions.bar";
  self.backgroundColor = UIColor.clearColor;
  self.skeletons = [NSMutableArray array];
  self.scroll = [UIScrollView new];
  self.scroll.showsHorizontalScrollIndicator = NO;
  self.scroll.alwaysBounceHorizontal = YES;
  self.scroll.contentInset = UIEdgeInsetsMake(0, 10, 0, 6);
  self.scroll.translatesAutoresizingMaskIntoConstraints = NO;
  [self addSubview:self.scroll];
  self.chips = [UIStackView new];
  self.chips.axis = UILayoutConstraintAxisHorizontal;
  self.chips.spacing = 6;
  self.chips.alignment = UIStackViewAlignmentCenter;
  self.chips.translatesAutoresizingMaskIntoConstraints = NO;
  [self.scroll addSubview:self.chips];
  UIButton *close = [UIButton buttonWithType:UIButtonTypeCustom];
  close.translatesAutoresizingMaskIntoConstraints = NO;
  [close setImage:RBGlyphImage(RBGlyphClose, 12, 1.8) forState:UIControlStateNormal];
  close.tintColor = RBThemeTextSecondary();
  close.backgroundColor = RBThemeElevated();
  close.layer.cornerRadius = 12;
  close.layer.borderWidth = 1.0 / UIScreen.mainScreen.scale;
  close.layer.borderColor = RBThemeBorder().CGColor;
  close.accessibilityLabel = RBL(@"隐藏输入建议", @"Hide suggestions");
  close.accessibilityIdentifier = @"rokbot.suggestions.close";
  [close addTarget:self action:@selector(closeTapped) forControlEvents:UIControlEventTouchUpInside];
  [self addSubview:close];
  [NSLayoutConstraint activateConstraints:@[
    [self.scroll.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
    [self.scroll.topAnchor constraintEqualToAnchor:self.topAnchor],
    [self.scroll.bottomAnchor constraintEqualToAnchor:self.bottomAnchor],
    [self.scroll.trailingAnchor constraintEqualToAnchor:close.leadingAnchor constant:-4],
    [close.trailingAnchor constraintEqualToAnchor:self.trailingAnchor constant:-8],
    [close.centerYAnchor constraintEqualToAnchor:self.centerYAnchor],
    [close.widthAnchor constraintEqualToConstant:24],
    [close.heightAnchor constraintEqualToConstant:24],
    [self.chips.leadingAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.leadingAnchor],
    [self.chips.trailingAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.trailingAnchor],
    [self.chips.topAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.topAnchor],
    [self.chips.bottomAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.bottomAnchor],
    [self.chips.heightAnchor constraintEqualToAnchor:self.scroll.frameLayoutGuide.heightAnchor],
  ]];
  return self;
}

- (void)traitCollectionDidChange:(UITraitCollection *)previous {
  [super traitCollectionDidChange:previous];
  self.signature = nil;
  for (UIView *view in self.subviews)
    if ([view isKindOfClass:UIButton.class]) view.layer.borderColor = RBThemeBorder().CGColor;
}

- (void)closeTapped {
  if (self.onClose) self.onClose();
}

- (void)reset {
  for (RBSkeletonPillView *sk in self.skeletons) [sk stopShimmer];
  [self.skeletons removeAllObjects];
  for (UIView *view in [self.chips.arrangedSubviews copy]) [view removeFromSuperview];
  self.signature = nil;
  self.activeKey = @"";
  self.boundItems = @[];
  self.lastBoundWithoutPlaceholders = NO;
}

// Only chips, the close button and horizontal scrolling take touches; the gaps between
// chips stay transparent so the chat underneath keeps working.
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  UIView *hit = [super hitTest:point withEvent:event];
  if (hit == self || hit == self.chips) return nil;
  if (hit == self.scroll && CGRectGetMaxX(self.chips.frame) - self.scroll.contentOffset.x < point.x) return nil;
  return hit;
}

- (void)bindKey:(NSString *)key items:(NSArray<NSDictionary *> *)items placeholders:(NSUInteger)placeholders {
  self.activeKey = key ?: @"";
  self.boundItems = [items ?: @[] copy];
  BOOL animate = !UIAccessibilityIsReduceMotionEnabled();
  NSMutableString *signature = [NSMutableString stringWithFormat:@"%ld:", (long)self.traitCollection.userInterfaceStyle];
  for (NSDictionary *item in items) [signature appendFormat:@"%@:%@\n", item[@"type"], item[@"text"]];
  [signature appendFormat:@"#ph=%lu:%d", (unsigned long)placeholders, animate ? 1 : 0];
  if ([signature isEqualToString:self.signature ?: @""]) return;
  BOOL hadSkeletons = self.skeletons.count > 0;
  self.signature = signature;

  for (RBSkeletonPillView *sk in self.skeletons) [sk stopShimmer];
  [self.skeletons removeAllObjects];
  for (UIView *view in [self.chips.arrangedSubviews copy]) [view removeFromSuperview];

  NSUInteger aiIndex = 0;
  for (NSDictionary *item in items) {
    NSString *type = item[@"type"] ?: @"";
    BOOL phrase = [type isEqualToString:@"phrase"];
    BOOL frequent = [type isEqualToString:@"frequent"];
    BOOL match = [type isEqualToString:@"match"];
    BOOL bolt = phrase || frequent || match;
    UIButton *chip = [UIButton buttonWithType:UIButtonTypeCustom];
    UIButtonConfiguration *config = UIButtonConfiguration.plainButtonConfiguration;
    config.title = item[@"text"];
    config.image = RBGlyphImage(bolt ? RBGlyphBolt : RBGlyphSparkle, 11, 0);
    config.imagePadding = 4;
    config.imageColorTransformer = ^UIColor *(UIColor *c) { return bolt ? RBThemeAccent() : RBThemeTextSecondary(); };
    config.baseForegroundColor = RBThemeTextPrimary();
    config.contentInsets = NSDirectionalEdgeInsetsMake(4, 9, 4, 10);
    config.titleLineBreakMode = NSLineBreakByTruncatingTail;
    config.titleTextAttributesTransformer = ^NSDictionary *(NSDictionary *attributes) {
      NSMutableDictionary *next = [attributes mutableCopy];
      next[NSFontAttributeName] = RBSuggestionsChipFont();
      return next;
    };
    config.background.backgroundColor = phrase ? RBSuggestionsPhraseFill() : RBThemeElevated();
    config.background.cornerRadius = 13;
    config.background.strokeColor = phrase ? RBSuggestionsPhraseBorder() : RBThemeBorder();
    config.background.strokeWidth = 1.0 / UIScreen.mainScreen.scale;
    chip.configuration = config;
    NSString *prefix = phrase ? RBL(@"常用语：", @"Quick phrase: ")
        : (match ? RBL(@"补全：", @"Complete: ") : RBL(@"建议：", @"Suggestion: "));
    chip.accessibilityLabel = [NSString stringWithFormat:@"%@%@", prefix, item[@"text"]];
    chip.accessibilityHint = match ? RBL(@"点击填入输入框", @"Tap to fill the input")
                                   : RBL(@"点击直接发送", @"Sends immediately");
    chip.accessibilityIdentifier = phrase ? @"rokbot.suggestions.phrase"
        : (frequent ? @"rokbot.suggestions.frequent"
                    : (match ? @"rokbot.suggestions.match" : @"rokbot.suggestions.ai"));
    [chip.widthAnchor constraintLessThanOrEqualToConstant:200].active = YES;
    [chip.heightAnchor constraintEqualToConstant:RBSuggestionsChipHeight()].active = YES;
    __weak typeof(self) weak = self;
    NSDictionary *captured = [item copy];
    [chip addAction:[UIAction actionWithHandler:^(UIAction *action) {
      if (weak.onTap) weak.onTap(captured);
    }] forControlEvents:UIControlEventTouchUpInside];
    [self.chips addArrangedSubview:chip];
    if (!phrase && hadSkeletons && animate) {
      chip.alpha = 0;
      chip.transform = CGAffineTransformMakeTranslation(0, 3);
      [UIView animateWithDuration:0.20 delay:aiIndex * 0.045 options:UIViewAnimationOptionCurveEaseOut animations:^{
        chip.alpha = 1;
        chip.transform = CGAffineTransformIdentity;
      } completion:nil];
      aiIndex++;
    }
  }

  static const CGFloat widths[] = { 84, 112, 68 };
  CGFloat chipH = RBSuggestionsChipHeight();
  for (NSUInteger k = 0; k < placeholders; k++) {
    RBSkeletonPillView *sk = [RBSkeletonPillView new];
    sk.translatesAutoresizingMaskIntoConstraints = NO;
    [sk.widthAnchor constraintEqualToConstant:widths[k % 3]].active = YES;
    [sk.heightAnchor constraintEqualToConstant:chipH].active = YES;
    [self.chips addArrangedSubview:sk];
    [self.skeletons addObject:sk];
    [sk startShimmerWithDelay:k * 0.12];
    if (animate) {
      sk.alpha = 0;
      [UIView animateWithDuration:0.16 delay:k * 0.06 options:UIViewAnimationOptionCurveEaseOut animations:^{
        sk.alpha = 1;
      } completion:nil];
    }
  }
  self.scroll.contentOffset = CGPointMake(-self.scroll.contentInset.left, 0);
}

@end

@implementation RBSuggestionsRuntime

+ (instancetype)shared {
  static RBSuggestionsRuntime *runtime;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    runtime = [RBSuggestionsRuntime new];
    runtime.enabled = YES;
    runtime.aiEnabled = YES;
    runtime.completionEnabled = YES;
    runtime.learningEnabled = YES;
    runtime.localCompletionEnabled = YES;
    runtime.phrases = @[];
    runtime.aiCache = [NSCache new];
    runtime.aiCache.countLimit = 40;
    runtime.frequentCache = [NSCache new];
    runtime.frequentCache.countLimit = 40;
    runtime.candidatesCache = [NSCache new];
    runtime.candidatesCache.countLimit = 40;
    runtime.historyHints = [RBChatHistoryHints new];
    runtime.loadState = [RBSuggestionLoadState new];
    runtime.completionEngine = [[RBInlineCompletionEngine alloc] initWithHints:runtime.historyHints];
    runtime.shownSuffix = @"";
  });
  return runtime;
}

- (void)install {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (NSString *name in @[UITextViewTextDidBeginEditingNotification, UITextFieldTextDidBeginEditingNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
      UIView *input = n.object;
      if (![input isKindOfClass:UIView.class]) return;
      if (RBSuggestionsIsComposer(input)) {
        self.input = input;
        // Allow a fresh attempt per focus, but never orphan a request that is still in flight.
        if (!self.fetchingAt || -self.fetchingAt.timeIntervalSinceNow > RBSuggestionsTimeout) self.fetchingKey = nil;
        [self syncSettings:NO];
        [self refresh];
      } else if (self.input == input || !self.input) {
        self.input = nil;
        [self hideAll];
      }
    }];
  }
  for (NSString *name in @[UITextViewTextDidEndEditingNotification, UITextFieldTextDidEndEditingNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
      if (n.object == self.input) {
        self.input = nil;
        [self hideAll];
      }
    }];
  }
  for (NSString *name in @[UITextViewTextDidChangeNotification, UITextFieldTextDidChangeNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
      if (n.object == self.input) [self refresh];
    }];
  }
  [center addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification *n) { [self hideAll]; }];
  [center addObserverForName:@"RokBotSuggestionsSettingsChanged" object:nil queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification *n) {
                    NSDictionary *settings = n.userInfo[@"settings"];
                    if (settings) [self applySettings:settings];
                    else [self invalidate];
                  }];
}

- (void)applySettings:(NSDictionary *)raw {
  NSDictionary *settings = RBSuggestionsParseSettings(raw);
  if ([raw isKindOfClass:NSDictionary.class] && raw[@"enabled"]) self.enabled = [settings[@"enabled"] boolValue];
  if ([raw isKindOfClass:NSDictionary.class] && raw[@"aiEnabled"]) self.aiEnabled = [settings[@"aiEnabled"] boolValue];
  if ([raw isKindOfClass:NSDictionary.class] && raw[@"completionEnabled"]) {
    self.completionEnabled = [settings[@"completionEnabled"] boolValue];
    self.completionEngine.enabled = self.completionEnabled;
  }
  if ([raw isKindOfClass:NSDictionary.class] && raw[@"learningEnabled"]) {
    self.learningEnabled = [settings[@"learningEnabled"] boolValue];
  }
  if ([raw isKindOfClass:NSDictionary.class] && raw[@"localCompletionEnabled"]) {
    self.localCompletionEnabled = [settings[@"localCompletionEnabled"] boolValue];
  }
  if ([settings[@"hasPhrases"] boolValue]) self.phrases = settings[@"quickPhrases"];
  self.settingsAt = NSDate.date;
}

- (void)syncSettings:(BOOL)force {
  if (!RBConnection.shared.isPaired || self.settingsLoading) return;
  if (!force && self.settingsAt && -self.settingsAt.timeIntervalSinceNow < 15) return;
  self.settingsLoading = YES;
  RBHostRequest(@"GET", @"/local/suggestions/settings", nil, 10, ^(NSInteger status, id json, NSError *error) {
    self.settingsLoading = NO;
    if (status == 200 && [json isKindOfClass:NSDictionary.class]) [self applySettings:json];
    [self refresh];
  });
}

- (void)invalidateSettingsCache {
  self.settingsAt = nil;
  self.failedKey = nil;
  self.prefetchKey = nil;
}

- (void)clearLearnedHabits {
  [self.frequentCache removeAllObjects];
  [self.candidatesCache removeAllObjects];
  [self.aiCache removeAllObjects];
  [self invalidateSettingsCache];
}

- (void)invalidate {
  self.settingsAt = nil;
  [self.fetchTask cancel];
  self.fetchTask = nil;
  self.fetchingKey = nil;
  self.fetchSeq++;
  self.dismissedKey = nil;
  self.dismissedMatchDraft = nil;
  self.failedKey = nil;
  self.prefetchKey = nil;
  [self.loadState cancel];
  [self.historyHints clear];
  [self.aiCache removeAllObjects];
  [self.frequentCache removeAllObjects];
  [self.candidatesCache removeAllObjects];
  [self clearCompletion];
  [self.completionEngine clearCache];
  if (RBConnection.shared.isPaired) [self syncSettings:YES];
  else {
    RBActiveAgent = nil;
    [self hideAll];
  }
}

- (NSString *)currentKey {
  return RBSuggestionsKeyFor(RBActiveAgent);
}

- (NSArray<NSString *> *)cachedForKey:(NSString *)key {
  NSDictionary *cached = [self.aiCache objectForKey:key];
  if (cached && -[cached[@"at"] timeIntervalSinceNow] < RBSuggestionsCacheTTL) return cached[@"items"];
  return nil;
}

- (NSArray<NSDictionary *> *)localMatchesForDraft:(NSString *)draft {
  if (!self.enabled || !self.localCompletionEnabled) return @[];
  NSString *agent = RBActiveAgent;
  NSArray<NSString *> *candidates = agent.length ? [self.candidatesCache objectForKey:agent] : nil;
  NSArray<NSString *> *pool = RBSuggestionsHabitPool(self.phrases, candidates);
  NSArray<NSString *> *matched = RBSuggestionsHabitMatch(draft, pool, RBSuggestionsMaxHabitMatches);
  NSMutableArray<NSDictionary *> *out = [NSMutableArray arrayWithCapacity:matched.count];
  for (NSString *text in matched) {
    [out addObject:@{ @"type" : @"match", @"text" : text }];
  }
  return out;
}

- (void)sendFeedbackAction:(NSString *)action text:(NSString *)text shown:(NSArray<NSDictionary *> *)shown {
  if (!self.learningEnabled || !RBConnection.shared.isPaired) return;
  NSDictionary *body = RBSuggestionsFeedbackBody(RBActiveAgent, action, text, shown);
  if (!body) return;
  RBHostRequest(@"POST", @"/local/suggestions/feedback", body, 8, nil);
}

- (void)refresh {
  UIView *input = self.input;
  if (!input || !input.window || !input.isFirstResponder || !RBConnection.shared.isPaired || self.sending) {
    [self hideAll];
    return;
  }
  NSString *rawText = RBSuggestionsInputText(input);
  BOOL hasDraft = rawText.length > 0 && RBSuggestionsTrim(rawText).length > 0;
  if (hasDraft) {
    if (self.dismissedMatchDraft && ![rawText isEqualToString:self.dismissedMatchDraft]) {
      self.dismissedMatchDraft = nil;
    }
    [self observeComposer:input draft:rawText];
    [self renderCompletionForInput:input];
    // Local completion while typing (no network): shown when no ghost-text suffix is active.
    NSArray<NSDictionary *> *matches =
        (!self.shownSuffix.length && ![rawText isEqualToString:self.dismissedMatchDraft ?: @""])
            ? [self localMatchesForDraft:rawText] : @[];
    if (!matches.count) {
      [self hideBar];
    } else {
      NSString *matchKey = [@"match:" stringByAppendingString:RBActiveAgent ?: @""];
      [self showItems:matches forKey:matchKey placeholders:0];
    }
    return;
  }
  self.dismissedMatchDraft = nil;
  [self clearCompletion];

  if (!self.enabled) {
    [self hideBar];
    return;
  }
  NSString *key = [self currentKey];
  if ([key isEqualToString:self.dismissedKey ?: @""]) {
    [self hideBar];
    return;
  }

  NSTimeInterval now = CACurrentMediaTime();
  NSArray<NSString *> *ai = @[];
  NSUInteger placeholders = 0;
  if (self.aiEnabled && RBActiveAgent.length) {
    NSArray<NSString *> *cached = [self cachedForKey:key];
    if (cached) {
      if (![self.loadState.key isEqualToString:key] || self.loadState.phase != RBSuggestionLoadPhaseReady) {
        [self.loadState readyKey:key items:cached];
      }
      ai = cached;
    } else if (![key isEqualToString:self.fetchingKey ?: @""] &&
               !([key isEqualToString:self.failedKey ?: @""] && -self.failedAt.timeIntervalSinceNow < RBSuggestionsFailureBackoff)) {
      NSUInteger loadToken = [self.loadState beginKey:key now:now];
      [self fetchForKey:key agent:RBActiveAgent loadToken:loadToken];
    }
    if ([self.loadState.key isEqualToString:key]) {
      if (self.loadState.phase == RBSuggestionLoadPhaseReady) ai = self.loadState.items;
      if ([self.historyHints mayHaveHistory:RBActiveAgent]) {
        placeholders = [self.loadState placeholdersAt:now];
        NSTimeInterval delayLeft = [self.loadState placeholderDelayLeftAt:now];
        if (delayLeft > 0) {
          __weak typeof(self) weak = self;
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((delayLeft + 0.008) * NSEC_PER_SEC)),
                         dispatch_get_main_queue(), ^{ [weak refresh]; });
        }
      }
    }
  } else if (self.loadState.phase != RBSuggestionLoadPhaseIdle) {
    [self.loadState cancel];
  }
  if (![self.loadState.key isEqualToString:key] && self.loadState.phase != RBSuggestionLoadPhaseIdle) {
    [self.loadState cancel];
  }

  NSArray<NSString *> *frequent = (self.learningEnabled && key.length)
      ? ([self.frequentCache objectForKey:key] ?: @[]) : @[];
  NSArray<NSDictionary *> *items = RBSuggestionsMergeItemsWithFrequent(self.phrases, ai, frequent, RBSuggestionsMaxAI);
  BOOL fading = self.bar && !self.bar.hidden && self.loadState.phase == RBSuggestionLoadPhaseFailed &&
                [self.loadState.key isEqualToString:key];
  if (!items.count && placeholders == 0 && !fading) {
    [self hideBar];
    return;
  }
  [self showItems:items forKey:key placeholders:placeholders];
}

- (NSString *)newRequestId:(NSString *)kind seq:(NSUInteger)seq {
  NSString *nonce = [NSUUID.UUID.UUIDString.lowercaseString substringToIndex:8];
  return [NSString stringWithFormat:@"ios-%@-%lu-%@", kind, (unsigned long)seq, nonce];
}

- (void)settleFailedToken:(NSUInteger)token {
  [self refresh];
  if (self.loadState.phase != RBSuggestionLoadPhaseFailed) return;
  NSTimeInterval fade = UIAccessibilityIsReduceMotionEnabled() ? 0 : RBSuggestionsFadeOutDuration;
  __weak typeof(self) weak = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((fade + 0.02) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if ([weak.loadState settleToken:token]) [weak refresh];
  });
}

- (void)fetchForKey:(NSString *)key agent:(NSString *)agent loadToken:(NSUInteger)loadToken {
  NSUInteger seq = ++self.fetchSeq;
  [self.fetchTask cancel];
  self.fetchingKey = key;
  self.fetchingAt = NSDate.date;
  NSString *requestId = [self newRequestId:@"f" seq:seq];
  self.fetchTask = RBHostRequest(@"POST", @"/local/suggestions", RBSuggestionsRequestBody(agent, RBSuggestionsLocale(), requestId, NO),
                RBSuggestionsTimeout, ^(NSInteger status, id json, NSError *error) {
                  // Late or foreign responses (bot switched, newer request, echo mismatch) are dropped.
                  if (seq != self.fetchSeq) return;
                  self.fetchTask = nil;
                  if (!RBSuggestionsAcceptResponse(json, agent, requestId, RBActiveAgent, seq, self.fetchSeq)) {
                    self.fetchingKey = nil;
                    self.fetchingAt = nil;
                    self.failedKey = key;
                    self.failedAt = NSDate.date;
                    if ([self.loadState failToken:loadToken]) [self settleFailedToken:loadToken];
                    return;
                  }
                  self.fetchingAt = nil;
                  NSString *source = [json isKindOfClass:NSDictionary.class] && [json[@"source"] isKindOfClass:NSString.class]
                      ? json[@"source"] : @"";
                  if (status == 200) [self.historyHints recordAgent:agent source:source];
                  NSArray<NSString *> *ai = status == 200 ? RBSuggestionsAIFromResponse(json) : @[];
                  if (status == 200 && [json isKindOfClass:NSDictionary.class]) {
                    NSArray<NSString *> *frequent = RBSuggestionsStringList(json[@"frequentSuggestions"], RBSuggestionsMaxAI);
                    [self.frequentCache setObject:frequent forKey:key];
                    id rawCandidates = json[@"completionCandidates"];
                    if ([rawCandidates isKindOfClass:NSArray.class]) {
                      [self.candidatesCache setObject:RBSuggestionsStringList(rawCandidates, RBSuggestionsMaxCandidates)
                                               forKey:agent];
                    }
                    [self applySettings:json];
                  }
                  // Never cache failures or empty results; a later focus retries (after a short backoff on errors).
                  if (ai.count) [self.aiCache setObject:@{ @"items" : ai, @"at" : NSDate.date } forKey:key];
                  if (status != 200) {
                    self.failedKey = key;
                    self.failedAt = NSDate.date;
                  }
                  if (ai.count) {
                    [self.loadState succeedToken:loadToken items:ai];
                    [self refresh];
                  } else if ([self.loadState failToken:loadToken]) {
                    [self settleFailedToken:loadToken];
                  } else {
                    [self refresh];
                  }
                });
}

// Background warm-up when entering a chat or after a new reply. New Hosts answer 202 and
// generate into their own cache; older Hosts answer 200 with suggestions, which we cache here.
// Failures are not retried.
- (void)prefetchAgent:(NSString *)agent {
  if (!agent.length || !self.enabled || !self.aiEnabled || !RBConnection.shared.isPaired) return;
  NSString *key = RBSuggestionsKeyFor(agent);
  if ([self cachedForKey:key]) return;
  if ([key isEqualToString:self.prefetchKey ?: @""] && -self.prefetchAt.timeIntervalSinceNow < RBSuggestionsPrefetchThrottle) return;
  self.prefetchKey = key;
  self.prefetchAt = NSDate.date;
  NSString *requestId = [self newRequestId:@"p" seq:self.fetchSeq];
  RBHostRequest(@"POST", @"/local/suggestions", RBSuggestionsRequestBody(agent, RBSuggestionsLocale(), requestId, YES),
                RBSuggestionsTimeout, ^(NSInteger status, id json, NSError *error) {
                  if (status != 200) return;
                  // Echo check only; prefetch results are keyed by bot + generation and never shown directly.
                  if (!RBSuggestionsAcceptResponse(json, agent, requestId, agent, 0, 0)) return;
                  NSString *source = [json isKindOfClass:NSDictionary.class] && [json[@"source"] isKindOfClass:NSString.class]
                      ? json[@"source"] : @"";
                  [self.historyHints recordAgent:agent source:source];
                  NSArray<NSString *> *frequent = @[];
                  if ([json isKindOfClass:NSDictionary.class]) {
                    frequent = RBSuggestionsStringList(json[@"frequentSuggestions"], RBSuggestionsMaxAI);
                    if (frequent.count) [self.frequentCache setObject:frequent forKey:key];
                    id rawCandidates = json[@"completionCandidates"];
                    if ([rawCandidates isKindOfClass:NSArray.class]) {
                      [self.candidatesCache setObject:RBSuggestionsStringList(rawCandidates, RBSuggestionsMaxCandidates)
                                               forKey:agent];
                    }
                  }
                  NSArray<NSString *> *ai = RBSuggestionsAIFromResponse(json);
                  if (ai.count) [self.aiCache setObject:@{ @"items" : ai, @"at" : NSDate.date } forKey:key];
                  if ((ai.count || frequent.count) && [key isEqualToString:[self currentKey]] && self.input) [self refresh];
                });
}

- (void)activateAgent:(NSString *)agent turn:(BOOL)turn {
  if (!agent.length) return;
  BOOL changed = ![agent isEqualToString:RBActiveAgent ?: @""];
  RBActiveAgent = RBSuggestionsResolveAgent(RBActiveAgent, agent, turn ? RBSuggestionsSignalTurn : RBSuggestionsSignalActivate);
  if (turn) {
    RBSuggestionsBumpGeneration(agent);
    [self.historyHints forgetAgent:agent];
    [self.completionEngine clearCache];
  }
  if (changed) {
    // Switching bots clears the old bot's suggestions immediately and cancels its in-flight request.
    [self.fetchTask cancel];
    self.fetchTask = nil;
    self.fetchingKey = nil;
    self.fetchSeq++;
    self.dismissedMatchDraft = nil;
    [self.loadState cancel];
    [self.bar reset];
    [self hideBar];
    [self clearCompletion];
    [self.completionEngine clearCache];
  }
  if (!turn) [self prefetchAgent:agent];
  if (changed || turn) [self refresh];
}

- (void)noteReply:(NSString *)agent {
  if (!agent.length) return;
  if ([agent isEqualToString:self.replyAgent ?: @""] && -self.replyAt.timeIntervalSinceNow < RBSuggestionsReplyThrottle) return;
  self.replyAgent = agent;
  self.replyAt = NSDate.date;
  RBSuggestionsBumpGeneration(agent);
  [self.historyHints forgetAgent:agent];
  if (![agent isEqualToString:RBActiveAgent ?: @""]) return;
  [self.completionEngine clearCache];
  [self prefetchAgent:agent];
  [self refresh];
}

#pragma mark - Inline completion runtime

- (void)observeComposer:(UIView *)input draft:(NSString *)draft {
  BOOL composing = RBSuggestionsIsComposing(input);
  BOOL cursorAtEnd = RBSuggestionsIsCursorAtEnd(input);
  NSString *agent = RBActiveAgent ?: @"";
  NSString *sig = [NSString stringWithFormat:@"%@\x01%@\x01%d\x01%d\x01%d",
                   agent, draft, composing ? 1 : 0, cursorAtEnd ? 1 : 0, self.completionEnabled ? 1 : 0];
  if ([sig isEqualToString:self.lastObservedSignature ?: @""]) return;
  self.lastObservedSignature = sig;
  self.completionEngine.enabled = self.completionEnabled;
  NSUInteger seqBefore = self.completionEngine.sequence;
  NSTimeInterval now = CACurrentMediaTime();
  self.shownSuffix = [self.completionEngine onDraftChanged:draft agentId:agent
                                                 composing:composing cursorAtEnd:cursorAtEnd now:now];
  if (self.completionEngine.sequence != seqBefore) {
    [self.completionTask cancel];
    self.completionTask = nil;
  }
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(pollCompletion) object:nil];
  if (self.completionEngine.hasPending) {
    NSTimeInterval wait = MAX(0, self.completionEngine.dueAt - now);
    [self performSelector:@selector(pollCompletion) withObject:nil afterDelay:wait];
  }
}

- (void)pollCompletion {
  NSTimeInterval now = CACurrentMediaTime();
  RBInlineCompletionRequest *req = [self.completionEngine pollAt:now];
  if (!req) {
    if (self.completionEngine.hasPending) {
      [self performSelector:@selector(pollCompletion) withObject:nil afterDelay:MAX(0.01, self.completionEngine.dueAt - now)];
    }
    return;
  }
  [self.completionTask cancel];
  self.completionTask = RBHostRequest(@"POST", @"/local/suggestions/complete",
      RBSuggestionsCompleteBody(req.agentId, req.draft, RBSuggestionsLocale()), RBSuggestionsTimeout,
      ^(NSInteger status, id json, NSError *error) {
        if (![self.completionEngine isCurrentRequest:req]) return;
        self.completionTask = nil;
        if (error || status != 200 || ![json isKindOfClass:NSDictionary.class]) {
          [self.completionEngine onFailureForRequest:req];
          return;
        }
        if ([json[@"enabled"] isKindOfClass:NSNumber.class] && ![json[@"enabled"] boolValue]) {
          self.completionEnabled = NO;
          self.completionEngine.enabled = NO;
        }
        NSString *completion = [json[@"completion"] isKindOfClass:NSString.class] ? json[@"completion"] : @"";
        NSString *source = [json[@"source"] isKindOfClass:NSString.class] ? json[@"source"] : @"";
        NSString *current = self.input ? RBSuggestionsInputText(self.input) : nil;
        NSString *shown = [self.completionEngine onResponseForRequest:req completion:completion source:source currentDraft:current];
        if (!shown) return;
        self.shownSuffix = shown;
        self.lastObservedSignature = nil;
        [self refresh];
      });
}

- (void)clearCompletion {
  if (self.shownSuffix.length || self.completionEngine.hasPending) [self.completionEngine reset];
  self.shownSuffix = @"";
  self.lastObservedSignature = nil;
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(pollCompletion) object:nil];
  [self.completionTask cancel];
  self.completionTask = nil;
  [self hideCompletionViews];
}

- (void)hideCompletionViews {
  if (self.completionPill) self.completionPill.hidden = YES;
  if (self.ghostView) self.ghostView.hidden = YES;
  [self stopLinkIfIdle];
}

- (void)renderCompletionForInput:(UIView *)input {
  UIWindow *window = input.window;
  if (!window || !self.shownSuffix.length) {
    [self hideCompletionViews];
    return;
  }
  if (!self.completionPill) {
    self.completionPill = [[RBCompletionPill alloc] initWithFrame:CGRectZero];
    __weak typeof(self) weak = self;
    self.completionPill.onAccept = ^{ [weak acceptCompletion]; };
  }
  if (self.completionPill.superview != window) [window addSubview:self.completionPill];
  [self.completionPill bindSuffix:self.shownSuffix];
  self.completionPill.hidden = NO;

  if (!self.ghostView) {
    self.ghostView = [[RBGhostTextView alloc] initWithFrame:CGRectZero];
    __weak typeof(self) weak = self;
    self.ghostView.onAccept = ^{ [weak acceptCompletion]; };
  }
  if (self.ghostView.superview != window) [window addSubview:self.ghostView];
  [self.ghostView bindSuffix:self.shownSuffix font:RBSuggestionsInputFont(input)];

  [self reposition];
  [self ensureDisplayLink];
}

- (void)acceptCompletion {
  UIView *input = self.input;
  if (!input || ![input conformsToProtocol:@protocol(UITextInput)]) return;
  NSString *draft = RBSuggestionsInputText(input);
  NSString *suffix = [self.completionEngine shownSuffixForDraft:draft];
  NSString *full = [self.completionEngine acceptDraft:draft];
  self.shownSuffix = @"";
  self.lastObservedSignature = nil;
  [self hideCompletionViews];
  if (!full || !suffix.length) return;
  if (!input.isFirstResponder) [input becomeFirstResponder];
  [(id<UITextInput>)input insertText:suffix];
}

#pragma mark - Overlay positioning

- (void)ensureDisplayLink {
  if (self.link) return;
  self.link = [CADisplayLink displayLinkWithTarget:self selector:@selector(reposition)];
  self.link.preferredFrameRateRange = CAFrameRateRangeMake(20, 60, 30);
  [self.link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

- (void)stopLinkIfIdle {
  BOOL barVisible = self.bar && !self.bar.hidden;
  BOOL pillVisible = self.completionPill && !self.completionPill.hidden;
  if (!barVisible && !pillVisible) {
    [self.link invalidate];
    self.link = nil;
  }
}

- (void)showItems:(NSArray<NSDictionary *> *)items forKey:(NSString *)key placeholders:(NSUInteger)placeholders {
  UIWindow *window = self.input.window;
  if (!window) return;
  if (!self.bar) {
    self.bar = [[RBSuggestionsBar alloc] initWithFrame:CGRectZero];
    self.bar.hidden = YES;
    __weak typeof(self) weak = self;
    self.bar.onTap = ^(NSDictionary *item) {
      if ([item[@"type"] isEqualToString:@"match"]) {
        [weak fillDraft:item[@"text"]];
        return;
      }
      if (![item[@"type"] isEqualToString:@"phrase"]) {
        [weak sendFeedbackAction:@"tap" text:item[@"text"] shown:weak.bar.boundItems];
      }
      [weak send:item[@"text"]];
    };
    self.bar.onClose = ^{
      NSString *activeKey = weak.bar.activeKey ?: @"";
      if ([activeKey hasPrefix:@"match:"]) {
        weak.dismissedMatchDraft = weak.input ? RBSuggestionsInputText(weak.input) : nil;
      } else {
        weak.dismissedKey = [weak currentKey];
        [weak sendFeedbackAction:@"dismiss" text:@"" shown:weak.bar.boundItems];
      }
      [weak hideBar];
    };
  }
  if (self.bar.superview != window) [window addSubview:self.bar];
  NSString *before = self.bar.signature ?: @"";
  BOOL wasShown = !self.bar.hidden && !self.bar.hiding;
  [self.bar bindKey:key items:items placeholders:placeholders];
  BOOL changed = ![before isEqualToString:self.bar.signature ?: @""];
  BOOL animate = !UIAccessibilityIsReduceMotionEnabled();
  if (!wasShown) {
    // Appear: fade in alpha 0->1 + 3pt rise over 0.17s (cancels any running hide).
    self.bar.hiding = NO;
    self.bar.animGeneration++;
    [self.bar.layer removeAllAnimations];
    self.bar.hidden = NO;
    [self reposition];
    if (animate) {
      self.bar.alpha = 0;
      self.bar.transform = CGAffineTransformMakeTranslation(0, 3);
      [UIView animateWithDuration:RBSuggestionsBarFadeDuration
                            delay:0
                          options:UIViewAnimationOptionCurveEaseOut
                       animations:^{
                         self.bar.alpha = 1;
                         self.bar.transform = CGAffineTransformIdentity;
                       }
                       completion:nil];
    } else {
      self.bar.alpha = 1;
      self.bar.transform = CGAffineTransformIdentity;
    }
  } else {
    [self reposition];
    if (changed && animate && self.bar.skeletons.count == 0 && self.bar.lastBoundWithoutPlaceholders) {
      // Content swap (different items, no placeholders): quick soft refresh (alpha 0.35->1 + 3pt rise).
      self.bar.animGeneration++;
      [self.bar.layer removeAllAnimations];
      self.bar.alpha = 0.35;
      self.bar.transform = CGAffineTransformMakeTranslation(0, 3);
      [UIView animateWithDuration:RBSuggestionsBarFadeDuration
                            delay:0
                          options:UIViewAnimationOptionCurveEaseOut
                       animations:^{
                         self.bar.alpha = 1;
                         self.bar.transform = CGAffineTransformIdentity;
                       }
                       completion:nil];
    }
  }
  self.bar.lastBoundWithoutPlaceholders = (placeholders == 0);
  [self ensureDisplayLink];
}

- (void)reposition {
  UIView *input = self.input;
  if (!input.window) {
    [self hideAll];
    return;
  }
  UIWindow *window = input.window;
  CGRect anchor = RBSuggestionsAnchorRect(input);
  // Compact single row (26pt chips) hugging the composer so it covers as little of the last message as possible.
  CGFloat height = RBSuggestionsChipHeight() + 4;
  CGFloat y = MAX(window.safeAreaInsets.top + 4, CGRectGetMinY(anchor) - height - 2);
  CGRect barFrame = CGRectMake(0, y, window.bounds.size.width, height);
  if (self.bar && !self.bar.hidden && self.bar.superview) {
    CGRect targetBounds = CGRectMake(0, 0, barFrame.size.width, barFrame.size.height);
    CGPoint targetCenter = CGPointMake(CGRectGetMidX(barFrame), CGRectGetMidY(barFrame));
    if (!CGRectEqualToRect(self.bar.bounds, targetBounds)) self.bar.bounds = targetBounds;
    if (!CGPointEqualToPoint(self.bar.center, targetCenter)) self.bar.center = targetCenter;
    [self.bar.superview bringSubviewToFront:self.bar];
  }
  if (self.completionPill && !self.completionPill.hidden && self.completionPill.superview) {
    if (!CGRectEqualToRect(self.completionPill.frame, barFrame)) self.completionPill.frame = barFrame;
    [self.completionPill.superview bringSubviewToFront:self.completionPill];
  }
  if (self.ghostView && self.shownSuffix.length && [input conformsToProtocol:@protocol(UITextInput)]) {
    id<UITextInput> ti = (id<UITextInput>)input;
    UITextRange *sel = ti.selectedTextRange;
    if (sel && sel.isEmpty && RBSuggestionsIsCursorAtEnd(input)) {
      CGRect caret = [ti caretRectForPosition:sel.end];
      CGRect caretInWin = [input convertRect:caret toView:window];
      CGRect inputInWin = [input convertRect:input.bounds toView:window];
      CGFloat left = CGRectGetMaxX(caretInWin) + 1;
      CGFloat rightLimit = CGRectGetMaxX(inputInWin) - 10;
      CGFloat avail = rightLimit - left;
      if (avail >= 20 && CGRectGetMinY(caretInWin) >= CGRectGetMinY(inputInWin) - 4 &&
          CGRectGetMaxY(caretInWin) <= CGRectGetMaxY(inputInWin) + 4) {
        self.ghostView.frame = CGRectMake(left, caretInWin.origin.y, avail, MAX(18, caretInWin.size.height));
        self.ghostView.hidden = NO;
        [self.ghostView.superview bringSubviewToFront:self.ghostView];
      } else {
        self.ghostView.hidden = YES;
      }
    } else {
      self.ghostView.hidden = YES;
    }
  }
}

- (void)hideBar {
  RBSuggestionsBar *bar = self.bar;
  if (!bar || bar.hidden || bar.hiding) {
    [self stopLinkIfIdle];
    return;
  }
  for (RBSkeletonPillView *sk in bar.skeletons) [sk stopShimmer];
  if (UIAccessibilityIsReduceMotionEnabled() || !bar.window) {
    bar.animGeneration++;
    bar.hiding = NO;
    [bar.layer removeAllAnimations];
    bar.alpha = 1;
    bar.transform = CGAffineTransformIdentity;
    bar.hidden = YES;
    [self stopLinkIfIdle];
    return;
  }
  // Fade out with a 3pt drop, then hidden (a show in between cancels it).
  bar.hiding = YES;
  NSUInteger gen = ++bar.animGeneration;
  [bar.layer removeAllAnimations];
  __weak typeof(self) weak = self;
  [UIView animateWithDuration:RBSuggestionsBarFadeDuration
                        delay:0
                      options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionCurveEaseOut
                   animations:^{
                     bar.alpha = 0;
                     bar.transform = CGAffineTransformMakeTranslation(0, 3);
                   }
                   completion:^(BOOL finished) {
                     if (!bar.hiding || bar.animGeneration != gen) return;
                     bar.hiding = NO;
                     bar.hidden = YES;
                     bar.alpha = 1;
                     bar.transform = CGAffineTransformIdentity;
                     [weak stopLinkIfIdle];
                   }];
}

- (void)hideAll {
  self.dismissedMatchDraft = nil;
  [self hideBar];
  [self clearCompletion];
}

- (void)fillDraft:(NSString *)text {
  UIView *input = self.input;
  if (!text.length || ![input conformsToProtocol:@protocol(UITextInput)]) return;
  self.dismissedMatchDraft = nil;
  [self hideBar];
  if (!input.isFirstResponder) [input becomeFirstResponder];
  id<UITextInput> ti = (id<UITextInput>)input;
  UITextRange *all = [ti textRangeFromPosition:ti.beginningOfDocument toPosition:ti.endOfDocument];
  if (all) [ti replaceRange:all withText:text];
  else [ti insertText:text];
  UITextPosition *end = ti.endOfDocument;
  if (end) ti.selectedTextRange = [ti textRangeFromPosition:end toPosition:end];
}

- (void)send:(NSString *)text {
  NSString *agent = RBActiveAgent;
  UIView *input = self.input;
  if (!text.length) return;
  if (!agent.length) {
    [self insertIntoComposer:text];
    return;
  }
  self.sending = YES;
  [self hideAll];
  UIImpactFeedbackGenerator *haptic = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
  [haptic impactOccurred];
  RBHostRequest(@"POST", @"/api/sendPrompt", RBSuggestionsSendBody(agent, text, nil), 30,
                ^(NSInteger status, id json, NSError *error) {
                  self.sending = NO;
                  if (status >= 200 && status < 300) {
                    RBSuggestionsBumpGeneration(agent);
                    [self.historyHints forgetAgent:agent];
                    [self.loadState cancel];
                    [self.completionEngine clearCache];
                    return;
                  }
                  // Keep the user's intent: put the text in the composer so they can send it manually.
                  self.input = input;
                  [self insertIntoComposer:text];
                });
}

- (void)insertIntoComposer:(NSString *)text {
  UIView *input = self.input;
  if (![input conformsToProtocol:@protocol(UITextInput)]) return;
  [self hideAll];
  if (!input.isFirstResponder) [input becomeFirstResponder];
  // insertText: goes through the delegate path so React Native receives onChangeText.
  [(id<UITextInput>)input insertText:text];
}

@end

void RBInstallSuggestions(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    dispatch_async(dispatch_get_main_queue(), ^{ [[RBSuggestionsRuntime shared] install]; });
  });
}

void RBSuggestionsNoteRequest(NSString *path, NSData *body) {
  RBSuggestionsSignal signal = RBSuggestionsSignalNone;
  NSString *agent = RBSuggestionsAgentFromRequest(path, body, &signal);
  if (!agent || signal == RBSuggestionsSignalNone) return;
  BOOL read = [path.lastPathComponent isEqualToString:@"markAgentRead"];
  dispatch_async(dispatch_get_main_queue(), ^{
    RBSuggestionsRuntime *runtime = [RBSuggestionsRuntime shared];
    if (signal == RBSuggestionsSignalActivate || signal == RBSuggestionsSignalTurn) {
      [runtime activateAgent:agent turn:signal == RBSuggestionsSignalTurn];
    } else if (read && [agent isEqualToString:RBActiveAgent ?: @""]) {
      // RN marks the open chat read when a new reply lands; weak for any other bot.
      [runtime noteReply:agent];
    }
  });
}

void RBSuggestionsNoteOpenedAgent(NSString *agentId) {
  if (!RBSuggestionsValidAgentId(agentId)) return;
  NSString *agent = [agentId copy];
  dispatch_async(dispatch_get_main_queue(), ^{ [[RBSuggestionsRuntime shared] activateAgent:agent turn:NO]; });
}

void RBSuggestionsNoteReply(NSString *agentId) {
  if (!RBSuggestionsValidAgentId(agentId)) return;
  NSString *agent = [agentId copy];
  dispatch_async(dispatch_get_main_queue(), ^{ [[RBSuggestionsRuntime shared] noteReply:agent]; });
}

void RBSuggestionsInvalidate(void) {
  dispatch_async(dispatch_get_main_queue(), ^{ [[RBSuggestionsRuntime shared] invalidate]; });
}

#pragma mark - Settings

@interface RBSuggestionsSettingsController : UIViewController <UITextFieldDelegate>
@property(nonatomic, strong) UIStackView *stack;
@property(nonatomic, strong) UISwitch *enabledSwitch;
@property(nonatomic, strong) UISwitch *aiSwitch;
@property(nonatomic, strong) UISwitch *completionSwitch;
@property(nonatomic, strong) UISwitch *learningSwitch;
@property(nonatomic, strong) UISwitch *localCompletionSwitch;
@property(nonatomic, strong) UIButton *clearHabitsButton;
@property(nonatomic, strong) UIView *aiRow;
@property(nonatomic, strong) UITextField *field;
@property(nonatomic, strong) UIButton *addButton;
@property(nonatomic, strong) UIButton *cancelEditButton;
@property(nonatomic, strong) UILabel *editorTitle;
@property(nonatomic, strong) UIStackView *phraseList;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, copy) NSArray<NSDictionary *> *phrases;
@property(nonatomic, copy) NSString *editingId;
@property(nonatomic, assign) BOOL busy;
@end

@implementation RBSuggestionsSettingsController

- (UILabel *)label:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight color:(UIColor *)color {
  UILabel *label = [UILabel new];
  label.text = text;
  label.font = RBThemeFont(size, weight);
  label.textColor = color;
  label.numberOfLines = 0;
  label.adjustsFontForContentSizeCategory = YES;
  return label;
}

- (UIView *)sectionHeader:(NSString *)text {
  UILabel *label = [self label:text size:13 weight:UIFontWeightSemibold color:RBThemeTextSecondary()];
  label.accessibilityTraits = UIAccessibilityTraitHeader;
  UIView *wrap = [UIView new];
  label.translatesAutoresizingMaskIntoConstraints = NO;
  [wrap addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.leadingAnchor constraintEqualToAnchor:wrap.leadingAnchor constant:6],
    [label.trailingAnchor constraintEqualToAnchor:wrap.trailingAnchor],
    [label.topAnchor constraintEqualToAnchor:wrap.topAnchor],
    [label.bottomAnchor constraintEqualToAnchor:wrap.bottomAnchor],
  ]];
  return wrap;
}

- (UIView *)switchRowTitle:(NSString *)title subtitle:(NSString *)subtitle control:(UISwitch *)control {
  UILabel *t = [self label:title size:15 weight:UIFontWeightMedium color:RBThemeTextPrimary()];
  UILabel *s = [self label:subtitle size:12.5 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
  UIStackView *texts = [[UIStackView alloc] initWithArrangedSubviews:@[t, s]];
  texts.axis = UILayoutConstraintAxisVertical;
  texts.spacing = 3;
  control.onTintColor = RBThemeAccent();
  [control setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [control setContentCompressionResistancePriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[texts, control]];
  row.alignment = UIStackViewAlignmentCenter;
  row.spacing = 12;
  row.layoutMargins = UIEdgeInsetsMake(14, 16, 14, 16);
  row.layoutMarginsRelativeArrangement = YES;
  control.accessibilityLabel = title;
  return row;
}

- (UIView *)hairline {
  UIView *line = [UIView new];
  line.backgroundColor = RBThemeBorder();
  [line.heightAnchor constraintEqualToConstant:1.0 / UIScreen.mainScreen.scale].active = YES;
  return line;
}

- (UIView *)card:(NSArray<UIView *> *)rows {
  UIView *card = RBThemeCard(16);
  UIStackView *stack = [UIStackView new];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  for (NSUInteger i = 0; i < rows.count; i++) {
    if (i > 0) [stack addArrangedSubview:[self hairline]];
    [stack addArrangedSubview:rows[i]];
  }
  [card addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:card.leadingAnchor],
    [stack.trailingAnchor constraintEqualToAnchor:card.trailingAnchor],
    [stack.topAnchor constraintEqualToAnchor:card.topAnchor],
    [stack.bottomAnchor constraintEqualToAnchor:card.bottomAnchor],
  ]];
  return card;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"输入建议", @"Input Suggestions");
  self.view.backgroundColor = RBThemeChrome();
  self.navigationController.navigationBar.tintColor = RBThemeTextPrimary();
  if (self.navigationController.viewControllers.firstObject == self) {
    UIBarButtonItem *close = [[UIBarButtonItem alloc] initWithImage:RBGlyphImage(RBGlyphClose, 22, 2)
                                                              style:UIBarButtonItemStylePlain
                                                             target:self
                                                             action:@selector(close)];
    close.accessibilityLabel = RBL(@"关闭", @"Close");
    self.navigationItem.leftBarButtonItem = close;
  }
  UIScrollView *scroll = [UIScrollView new];
  scroll.translatesAutoresizingMaskIntoConstraints = NO;
  scroll.keyboardDismissMode = UIScrollViewKeyboardDismissModeInteractive;
  scroll.alwaysBounceVertical = YES;
  [self.view addSubview:scroll];
  self.stack = [UIStackView new];
  self.stack.axis = UILayoutConstraintAxisVertical;
  self.stack.spacing = 10;
  self.stack.translatesAutoresizingMaskIntoConstraints = NO;
  [scroll addSubview:self.stack];
  [NSLayoutConstraint activateConstraints:@[
    [scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [scroll.topAnchor constraintEqualToAnchor:self.view.topAnchor],
    [scroll.bottomAnchor constraintEqualToAnchor:self.view.keyboardLayoutGuide.topAnchor],
    [self.stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:16],
    [self.stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-16],
    [self.stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:16],
    [self.stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-32],
    [self.stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-32],
  ]];

  self.enabledSwitch = [UISwitch new];
  self.enabledSwitch.accessibilityIdentifier = @"rokbot.suggestions.enabled";
  [self.enabledSwitch addTarget:self action:@selector(switchChanged:) forControlEvents:UIControlEventValueChanged];
  self.aiSwitch = [UISwitch new];
  self.aiSwitch.accessibilityIdentifier = @"rokbot.suggestions.ai-enabled";
  [self.aiSwitch addTarget:self action:@selector(switchChanged:) forControlEvents:UIControlEventValueChanged];
  self.completionSwitch = [UISwitch new];
  self.completionSwitch.accessibilityIdentifier = @"rokbot.suggestions.completion-enabled";
  [self.completionSwitch addTarget:self action:@selector(switchChanged:) forControlEvents:UIControlEventValueChanged];

  UIView *enabledRow = [self switchRowTitle:RBL(@"输入建议", @"Input Suggestions")
                                   subtitle:RBL(@"输入框聚焦时显示常用语与快捷建议，点击直接发送", @"Show quick phrases and smart replies on focus; tap to send")
                                    control:self.enabledSwitch];
  self.aiRow = [self switchRowTitle:RBL(@"AI 生成建议", @"AI-Generated Suggestions")
                           subtitle:RBL(@"根据当前对话上下文由模型自动生成回复建议，空会话只显示常用语", @"Generate contextual replies from conversation history; empty chats show quick phrases only")
                            control:self.aiSwitch];
  UIView *completionRow = [self switchRowTitle:RBL(@"输入补全", @"Inline Completion")
                                      subtitle:RBL(@"输入时以灰色文字预测后续内容，点按补全即可采用", @"Predict the rest of your message in gray while typing; tap to accept")
                                       control:self.completionSwitch];
  [self.stack addArrangedSubview:[self sectionHeader:RBL(@"开关", @"Switches")]];
  [self.stack addArrangedSubview:[self card:@[enabledRow, self.aiRow, completionRow]]];
  [self.stack setCustomSpacing:22 afterView:self.stack.arrangedSubviews.lastObject];

  self.learningSwitch = [UISwitch new];
  self.learningSwitch.accessibilityIdentifier = @"rokbot.suggestions.learning";
  [self.learningSwitch addTarget:self action:@selector(personalizationSwitchChanged:) forControlEvents:UIControlEventValueChanged];
  self.localCompletionSwitch = [UISwitch new];
  self.localCompletionSwitch.accessibilityIdentifier = @"rokbot.suggestions.local-completion";
  [self.localCompletionSwitch addTarget:self action:@selector(personalizationSwitchChanged:) forControlEvents:UIControlEventValueChanged];

  UIView *learningRow = [self switchRowTitle:RBL(@"根据习惯学习", @"Learn From My Habits")
                                    subtitle:RBL(@"参考你常发的话和点选记录，让建议更像你会说的话；仅保存在你的 Host 上",
                                                 @"Use the messages you often send and the suggestions you pick; stored only on your Host")
                                     control:self.learningSwitch];
  UIView *localCompletionRow = [self switchRowTitle:RBL(@"本地补全", @"Local Completion")
                                           subtitle:RBL(@"输入时匹配常用语和你常发的话，点按填入输入框",
                                                        @"While typing, match quick phrases and your frequent messages; tap to fill the input")
                                            control:self.localCompletionSwitch];
  [self.stack addArrangedSubview:[self sectionHeader:RBL(@"个性化", @"Personalization")]];
  [self.stack addArrangedSubview:[self card:@[learningRow, localCompletionRow]]];
  self.clearHabitsButton = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(self.clearHabitsButton, RBL(@"清空学习记录", @"Clear Learned Habits"), NO);
  self.clearHabitsButton.accessibilityIdentifier = @"rokbot.suggestions.clear-habits";
  [self.clearHabitsButton setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [self.clearHabitsButton addTarget:self action:@selector(confirmClearHabits) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *clearRow = [[UIStackView alloc] initWithArrangedSubviews:@[self.clearHabitsButton, [UIView new]]];
  clearRow.alignment = UIStackViewAlignmentCenter;
  [self.stack addArrangedSubview:clearRow];
  [self.stack setCustomSpacing:22 afterView:clearRow];

  [self.stack addArrangedSubview:[self sectionHeader:RBL(@"自定义常用语", @"Quick Phrases")]];
  UILabel *phrasesHint = [self label:RBL(@"常用语显示在 AI 建议之前，在所有设备间同步。空会话仅显示常用语。",
                                         @"Shown before AI suggestions and synced across devices. Empty chats only show quick phrases.")
                                size:12.5 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
  [self.stack addArrangedSubview:phrasesHint];
  self.editorTitle = [self label:RBL(@"编辑常用语", @"Edit Quick Phrase") size:12.5 weight:UIFontWeightSemibold color:RBThemeTextSecondary()];
  self.editorTitle.hidden = YES;
  self.field = [UITextField new];
  self.field.placeholder = RBL(@"输入常用语，例如：继续、总结一下", @"Add a quick phrase, e.g. Continue");
  self.field.font = RBThemeFont(15, UIFontWeightRegular);
  self.field.adjustsFontForContentSizeCategory = YES;
  self.field.textColor = RBThemeTextPrimary();
  self.field.returnKeyType = UIReturnKeyDone;
  self.field.delegate = self;
  self.field.clearButtonMode = UITextFieldViewModeWhileEditing;
  self.field.accessibilityIdentifier = @"rokbot.suggestions.phrase-input";
  self.field.backgroundColor = RBThemeSecondaryFill();
  self.field.layer.cornerRadius = 12;
  self.field.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 12, 10)];
  self.field.leftViewMode = UITextFieldViewModeAlways;
  [self.field.heightAnchor constraintGreaterThanOrEqualToConstant:44].active = YES;
  self.addButton = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(self.addButton, RBL(@"添加", @"Add"), YES);
  self.addButton.accessibilityIdentifier = @"rokbot.suggestions.phrase-add";
  [self.addButton setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [self.addButton addTarget:self action:@selector(commitField) forControlEvents:UIControlEventTouchUpInside];
  self.cancelEditButton = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(self.cancelEditButton, RBL(@"取消", @"Cancel"), NO);
  self.cancelEditButton.hidden = YES;
  [self.cancelEditButton setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [self.cancelEditButton addTarget:self action:@selector(cancelEdit) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *inputRow = [[UIStackView alloc] initWithArrangedSubviews:@[self.field, self.cancelEditButton, self.addButton]];
  inputRow.spacing = 8;
  inputRow.alignment = UIStackViewAlignmentCenter;
  UIStackView *editor = [[UIStackView alloc] initWithArrangedSubviews:@[self.editorTitle, inputRow]];
  editor.axis = UILayoutConstraintAxisVertical;
  editor.spacing = 8;
  editor.layoutMargins = UIEdgeInsetsMake(12, 12, 12, 12);
  editor.layoutMarginsRelativeArrangement = YES;
  self.phraseList = [UIStackView new];
  self.phraseList.axis = UILayoutConstraintAxisVertical;
  [self.stack addArrangedSubview:[self card:@[editor, self.phraseList]]];
  self.status = [self label:@"" size:12.5 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
  self.status.textAlignment = NSTextAlignmentCenter;
  [self.stack addArrangedSubview:self.status];

  self.phrases = @[];
  [self renderPhrases];
  [self applyEnabledState];
  [self load];
}

- (void)close { [self dismissViewControllerAnimated:YES completion:nil]; }

- (void)setStatusText:(NSString *)text error:(BOOL)error {
  self.status.text = text;
  self.status.textColor = error ? RBThemeDanger() : RBThemeTextSecondary();
}

- (void)applySettingsResponse:(id)json {
  NSDictionary *settings = RBSuggestionsParseSettings(json);
  if ([json isKindOfClass:NSDictionary.class] && json[@"enabled"]) self.enabledSwitch.on = [settings[@"enabled"] boolValue];
  if ([json isKindOfClass:NSDictionary.class] && json[@"aiEnabled"]) self.aiSwitch.on = [settings[@"aiEnabled"] boolValue];
  if ([json isKindOfClass:NSDictionary.class] && json[@"completionEnabled"]) self.completionSwitch.on = [settings[@"completionEnabled"] boolValue];
  if ([json isKindOfClass:NSDictionary.class] && json[@"learningEnabled"]) self.learningSwitch.on = [settings[@"learningEnabled"] boolValue];
  if ([json isKindOfClass:NSDictionary.class] && json[@"localCompletionEnabled"]) self.localCompletionSwitch.on = [settings[@"localCompletionEnabled"] boolValue];
  if ([settings[@"hasPhrases"] boolValue]) self.phrases = settings[@"quickPhrases"];
  [self renderPhrases];
  [self applyEnabledState];
  NSMutableDictionary *broadcast = [NSMutableDictionary dictionary];
  if ([json isKindOfClass:NSDictionary.class]) [broadcast addEntriesFromDictionary:json];
  if (!broadcast[@"quickPhrases"]) broadcast[@"quickPhrases"] = self.phrases;
  [NSNotificationCenter.defaultCenter postNotificationName:@"RokBotSuggestionsSettingsChanged" object:nil
                                                    userInfo:@{ @"settings" : broadcast }];
}

- (void)load {
  [self setStatusText:RBL(@"正在同步设置…", @"Syncing settings…") error:NO];
  self.enabledSwitch.on = YES;
  self.aiSwitch.on = YES;
  self.completionSwitch.on = YES;
  self.learningSwitch.on = YES;
  self.localCompletionSwitch.on = YES;
  RBHostRequest(@"GET", @"/local/suggestions/settings", nil, 10, ^(NSInteger status, id json, NSError *error) {
    if (status != 200) {
      [self setStatusText:[RBL(@"读取设置失败：", @"Failed to load settings: ") stringByAppendingString:RBHostErrorMessage(json, error, status)] error:YES];
      return;
    }
    [self setStatusText:@"" error:NO];
    [self applySettingsResponse:json];
  });
}

- (void)applyEnabledState {
  BOOL on = self.enabledSwitch.on;
  self.aiSwitch.enabled = on && !self.busy;
  self.aiRow.alpha = on ? 1 : 0.45;
  self.enabledSwitch.enabled = !self.busy;
  self.completionSwitch.enabled = !self.busy;
  self.learningSwitch.enabled = !self.busy;
  self.localCompletionSwitch.enabled = !self.busy;
  self.clearHabitsButton.enabled = !self.busy;
}

- (void)switchChanged:(UISwitch *)sender {
  [self applyEnabledState];
  NSDictionary *body = @{
    @"enabled" : @(self.enabledSwitch.on),
    @"aiEnabled" : @(self.aiSwitch.on),
    @"completionEnabled" : @(self.completionSwitch.on),
  };
  RBHostRequest(@"PUT", @"/local/suggestions/settings", body, 10, ^(NSInteger status, id json, NSError *error) {
    if (status != 200) {
      sender.on = !sender.on;
      [self applyEnabledState];
      [self setStatusText:[RBL(@"更新失败：", @"Update failed: ") stringByAppendingString:RBHostErrorMessage(json, error, status)] error:YES];
      return;
    }
    [self setStatusText:@"" error:NO];
    [self applySettingsResponse:json];
  });
}

- (void)personalizationSwitchChanged:(UISwitch *)sender {
  NSString *key = sender == self.learningSwitch ? @"learningEnabled" : @"localCompletionEnabled";
  NSDictionary *body = @{ key : @(sender.on) };
  RBHostRequest(@"PUT", @"/local/suggestions/settings", body, 10, ^(NSInteger status, id json, NSError *error) {
    if (status != 200) {
      sender.on = !sender.on;
      [self applyEnabledState];
      [self setStatusText:[RBL(@"保存失败: ", @"Save failed: ") stringByAppendingString:RBHostErrorMessage(json, error, status)] error:YES];
      return;
    }
    [self setStatusText:@"" error:NO];
    [self applySettingsResponse:json];
    [[RBSuggestionsRuntime shared] invalidateSettingsCache];
  });
}

- (void)confirmClearHabits {
  if (self.busy) return;
  UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:RBL(@"清空学习记录", @"Clear Learned Habits")
                       message:RBL(@"将删除 Host 上为每个 Bot 学到的常用说法和点选记录，常用语不受影响。",
                                   @"Deletes the habits and pick history learned for every Bot on your Host. Quick phrases are kept.")
                preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
  __weak typeof(self) weak = self;
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"清空", @"Clear")
                                            style:UIAlertActionStyleDestructive
                                          handler:^(UIAlertAction *a) { [weak clearHabits]; }]];
  [self presentViewController:alert animated:YES completion:nil];
}

- (void)clearHabits {
  if (self.busy) return;
  self.busy = YES;
  RBHostRequest(@"DELETE", @"/local/suggestions/habits", nil, 10, ^(NSInteger status, id json, NSError *error) {
    self.busy = NO;
    if (status < 200 || status >= 300) {
      [self setStatusText:[RBL(@"清空失败: ", @"Clear failed: ") stringByAppendingString:RBHostErrorMessage(json, error, status)] error:YES];
      return;
    }
    [[RBSuggestionsRuntime shared] clearLearnedHabits];
    [self setStatusText:RBL(@"已清空学习记录", @"Learned habits cleared") error:NO];
  });
}

- (BOOL)textFieldShouldReturn:(UITextField *)textField {
  [self commitField];
  return NO;
}

- (void)beginEditPhrase:(NSDictionary *)phrase {
  self.editingId = phrase[@"id"];
  self.field.text = phrase[@"text"];
  self.editorTitle.hidden = NO;
  self.cancelEditButton.hidden = NO;
  RBThemeStyleButton(self.addButton, RBL(@"保存", @"Save"), YES);
  [self.field becomeFirstResponder];
}

- (void)cancelEdit {
  self.editingId = nil;
  self.field.text = @"";
  self.editorTitle.hidden = YES;
  self.cancelEditButton.hidden = YES;
  RBThemeStyleButton(self.addButton, RBL(@"添加", @"Add"), YES);
  [self.field resignFirstResponder];
}

- (void)setBusy:(BOOL)busy {
  _busy = busy;
  self.addButton.enabled = !busy;
  self.field.enabled = !busy;
  for (UIView *row in self.phraseList.arrangedSubviews)
    for (UIView *view in row.subviews)
      if ([view isKindOfClass:UIStackView.class])
        for (UIView *control in ((UIStackView *)view).arrangedSubviews)
          if ([control isKindOfClass:UIButton.class]) ((UIButton *)control).enabled = !busy;
  [self applyEnabledState];
}

- (void)commitField {
  if (self.busy) return;
  NSString *error = RBSuggestionsValidatePhrase(self.field.text, self.phrases, self.editingId, RBIsChinese());
  if (error) {
    [self setStatusText:error error:YES];
    return;
  }
  NSString *text = RBSuggestionsTrim(self.field.text);
  NSString *editing = self.editingId;
  self.busy = YES;
  NSString *path = editing.length ? [@"/local/suggestions/phrases/" stringByAppendingString:RBHostPathSegment(editing)]
                                  : @"/local/suggestions/phrases";
  RBHostRequest(editing.length ? @"PUT" : @"POST", path, @{ @"text" : text }, 10, ^(NSInteger status, id json, NSError *err) {
    self.busy = NO;
    if (status < 200 || status >= 300) {
      NSString *prefix = editing.length ? RBL(@"保存失败：", @"Save failed: ") : RBL(@"添加失败：", @"Add failed: ");
      [self setStatusText:[prefix stringByAppendingString:RBHostErrorMessage(json, err, status)] error:YES];
      return;
    }
    [self setStatusText:@"" error:NO];
    [self cancelEdit];
    [self applySettingsResponse:json];
  });
}

- (void)deletePhrase:(NSDictionary *)phrase {
  if (self.busy) return;
  self.busy = YES;
  NSString *path = [@"/local/suggestions/phrases/" stringByAppendingString:RBHostPathSegment(phrase[@"id"])];
  RBHostRequest(@"DELETE", path, nil, 10, ^(NSInteger status, id json, NSError *err) {
    self.busy = NO;
    if (status != 200) {
      [self setStatusText:[RBL(@"删除失败：", @"Delete failed: ") stringByAppendingString:RBHostErrorMessage(json, err, status)] error:YES];
      return;
    }
    if ([self.editingId isEqual:phrase[@"id"]]) [self cancelEdit];
    [self setStatusText:@"" error:NO];
    [self applySettingsResponse:json];
  });
}

- (void)movePhraseAt:(NSUInteger)index delta:(NSInteger)delta {
  if (self.busy) return;
  NSArray<NSString *> *ids = RBSuggestionsMovedIds(self.phrases, index, delta);
  if (!ids) return;
  self.busy = YES;
  RBHostRequest(@"PUT", @"/local/suggestions/phrases/reorder", @{ @"ids" : ids }, 10, ^(NSInteger status, id json, NSError *err) {
    self.busy = NO;
    if (status != 200) {
      [self setStatusText:[RBL(@"排序失败：", @"Reorder failed: ") stringByAppendingString:RBHostErrorMessage(json, err, status)] error:YES];
      return;
    }
    [self setStatusText:@"" error:NO];
    [self applySettingsResponse:json];
  });
}

- (UIButton *)iconButton:(RBGlyph)glyph label:(NSString *)label danger:(BOOL)danger enabled:(BOOL)enabled
                  action:(void (^)(void))action {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  [button setImage:RBGlyphImage(glyph, 18, 1.8) forState:UIControlStateNormal];
  button.tintColor = danger ? RBThemeDanger() : RBThemeTextSecondary();
  button.accessibilityLabel = label;
  button.enabled = enabled;
  [button.widthAnchor constraintEqualToConstant:36].active = YES;
  [button.heightAnchor constraintEqualToConstant:36].active = YES;
  [button addAction:[UIAction actionWithHandler:^(UIAction *a) { action(); }] forControlEvents:UIControlEventTouchUpInside];
  return button;
}

- (void)renderPhrases {
  for (UIView *view in self.phraseList.arrangedSubviews) [view removeFromSuperview];
  if (!self.phrases.count) {
    UILabel *empty = [self label:RBL(@"暂未添加常用语", @"No quick phrases yet") size:13 weight:UIFontWeightRegular color:RBThemeTextMuted()];
    empty.textAlignment = NSTextAlignmentCenter;
    UIView *wrap = [UIView new];
    empty.translatesAutoresizingMaskIntoConstraints = NO;
    [wrap addSubview:empty];
    [NSLayoutConstraint activateConstraints:@[
      [empty.leadingAnchor constraintEqualToAnchor:wrap.leadingAnchor constant:16],
      [empty.trailingAnchor constraintEqualToAnchor:wrap.trailingAnchor constant:-16],
      [empty.topAnchor constraintEqualToAnchor:wrap.topAnchor constant:18],
      [empty.bottomAnchor constraintEqualToAnchor:wrap.bottomAnchor constant:-18],
    ]];
    [self.phraseList addArrangedSubview:[self hairline]];
    [self.phraseList addArrangedSubview:wrap];
    return;
  }
  NSUInteger count = self.phrases.count;
  [self.phrases enumerateObjectsUsingBlock:^(NSDictionary *phrase, NSUInteger index, BOOL *stop) {
    [self.phraseList addArrangedSubview:[self hairline]];
    UIImageView *icon = [[UIImageView alloc] initWithImage:RBGlyphImage(RBGlyphBolt, 16, 0)];
    icon.tintColor = RBThemeAccent();
    [icon setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
    UILabel *text = [self label:phrase[@"text"] size:15 weight:UIFontWeightRegular color:RBThemeTextPrimary()];
    __weak typeof(self) weak = self;
    UIButton *up = [self iconButton:RBGlyphArrowUp label:RBL(@"上移", @"Move up") danger:NO enabled:index > 0
                             action:^{ [weak movePhraseAt:index delta:-1]; }];
    UIButton *down = [self iconButton:RBGlyphArrowDown label:RBL(@"下移", @"Move down") danger:NO enabled:index + 1 < count
                               action:^{ [weak movePhraseAt:index delta:1]; }];
    UIButton *edit = [self iconButton:RBGlyphPencil label:RBL(@"编辑", @"Edit") danger:NO enabled:YES
                               action:^{ [weak beginEditPhrase:phrase]; }];
    UIButton *remove = [self iconButton:RBGlyphTrash label:RBL(@"删除", @"Delete") danger:YES enabled:YES
                                 action:^{ [weak deletePhrase:phrase]; }];
    UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[icon, text, up, down, edit, remove]];
    row.alignment = UIStackViewAlignmentCenter;
    row.spacing = 4;
    [row setCustomSpacing:10 afterView:icon];
    row.layoutMargins = UIEdgeInsetsMake(6, 16, 6, 8);
    row.layoutMarginsRelativeArrangement = YES;
    row.accessibilityIdentifier = [@"rokbot.suggestions.phrase." stringByAppendingString:phrase[@"id"] ?: @""];
    UIView *wrap = [UIView new];
    row.translatesAutoresizingMaskIntoConstraints = NO;
    [wrap addSubview:row];
    [NSLayoutConstraint activateConstraints:@[
      [row.leadingAnchor constraintEqualToAnchor:wrap.leadingAnchor],
      [row.trailingAnchor constraintEqualToAnchor:wrap.trailingAnchor],
      [row.topAnchor constraintEqualToAnchor:wrap.topAnchor],
      [row.bottomAnchor constraintEqualToAnchor:wrap.bottomAnchor],
    ]];
    [self.phraseList addArrangedSubview:wrap];
  }];
}

@end

void RBShowSuggestionsSettingsFrom(UIViewController *presenter) {
  RBSuggestionsSettingsController *controller = [RBSuggestionsSettingsController new];
  if (presenter.navigationController) {
    [presenter.navigationController pushViewController:controller animated:YES];
    return;
  }
  if (presenter) {
    UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:controller];
    nav.modalPresentationStyle = UIModalPresentationPageSheet;
    nav.sheetPresentationController.detents = @[ UISheetPresentationControllerDetent.largeDetent ];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
    [presenter presentViewController:nav animated:YES completion:nil];
    return;
  }
  RBPresentController(controller);
}

#endif // TARGET_OS_IOS
