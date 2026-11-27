#import "RBSuggestions.h"
#import <TargetConditionals.h>

static const NSUInteger RBSuggestionsMaxAI = 3;
static const NSUInteger RBSuggestionsMaxPhraseChars = 120;
static const NSUInteger RBSuggestionsMaxPhrases = 50;

static NSString *RBSuggestionsTrim(id value) {
  if (![value isKindOfClass:NSString.class]) return @"";
  NSString *trimmed = [[(NSString *)value stringByReplacingOccurrencesOfString:@"​" withString:@""]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return [trimmed isEqualToString:@"null"] ? @"" : trimmed;
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
    @"quickPhrases" : phrases,
    @"hasPhrases" : @([list isKindOfClass:NSArray.class]),
  };
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

NSArray<NSDictionary *> *RBSuggestionsMergeItems(NSArray *phrases, NSArray *ai) {
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
  NSUInteger aiCount = 0;
  for (id raw in ai ?: @[]) {
    NSString *text = RBSuggestionsTrim(raw);
    if (!text.length) continue;
    NSString *key = text.lowercaseString;
    if ([seen containsObject:key]) continue;
    [seen addObject:key];
    [out addObject:@{ @"type" : @"ai", @"text" : text }];
    if (++aiCount >= RBSuggestionsMaxAI) break;
  }
  return out;
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

NSString *RBSuggestionsValidatePhrase(NSString *text, NSArray<NSDictionary *> *existing, NSString *editingId, BOOL chinese) {
  NSString *clean = RBSuggestionsTrim(text);
  clean = [[clean componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
  if (!clean.length) return chinese ? @"常用语不能为空" : @"Quick phrase cannot be empty";
  __block NSUInteger characters = 0;
  [clean enumerateSubstringsInRange:NSMakeRange(0, clean.length) options:NSStringEnumerationByComposedCharacterSequences
                         usingBlock:^(NSString *s, NSRange r, NSRange e, BOOL *stop) { characters++; }];
  if (characters > RBSuggestionsMaxPhraseChars)
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

#if TARGET_OS_IOS

#import "RBConnection.h"
#import "RBHostAPI.h"
#import "RBLocalize.h"
#import "RBTheme.h"
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

@interface RBSuggestionsBar : UIView
@property(nonatomic, strong) UIScrollView *scroll;
@property(nonatomic, strong) UIStackView *chips;
@property(nonatomic, copy) NSString *signature;
@property(nonatomic, copy) void (^onTap)(NSDictionary *item);
@property(nonatomic, copy) void (^onClose)(void);
- (void)bindItems:(NSArray<NSDictionary *> *)items;
@end

@interface RBSuggestionsRuntime : NSObject
@property(nonatomic, weak) UIView *input;
@property(nonatomic, strong) RBSuggestionsBar *bar;
@property(nonatomic, strong) CADisplayLink *link;
@property(nonatomic, assign) BOOL enabled;
@property(nonatomic, assign) BOOL aiEnabled;
@property(nonatomic, copy) NSArray<NSDictionary *> *phrases;
@property(nonatomic, strong) NSDate *settingsAt;
@property(nonatomic, assign) BOOL settingsLoading;
@property(nonatomic, strong) NSCache<NSString *, NSDictionary *> *aiCache;
@property(nonatomic, copy) NSArray<NSString *> *currentAI;
// Cache key currentAI belongs to; AI chips are shown only while it equals the current key.
@property(nonatomic, copy) NSString *currentAIKey;
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
@property(nonatomic, assign) BOOL sending;
+ (instancetype)shared;
- (void)refresh;
- (void)invalidate;
- (void)activateAgent:(NSString *)agent turn:(BOOL)turn;
- (void)noteReply:(NSString *)agent;
@end

static NSString *RBSuggestionsInputText(UIView *input) {
  if ([input isKindOfClass:UITextView.class]) return ((UITextView *)input).text ?: @"";
  if ([input isKindOfClass:UITextField.class]) return ((UITextField *)input).text ?: @"";
  return @"";
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

// Compact chip font: 12.5pt, Dynamic Type capped at 15pt so the row stays ~26-28pt tall.
static UIFont *RBSuggestionsChipFont(void) {
  return [[UIFontMetrics defaultMetrics] scaledFontForFont:[UIFont systemFontOfSize:12.5 weight:UIFontWeightMedium]
                                          maximumPointSize:15];
}

static CGFloat RBSuggestionsChipHeight(void) {
  return MIN(28, MAX(26, ceil(RBSuggestionsChipFont().lineHeight) + 9));
}

@implementation RBSuggestionsBar

- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  self.tag = 731994;
  self.accessibilityIdentifier = @"rokbot.suggestions.bar";
  self.backgroundColor = UIColor.clearColor;
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

// Only chips, the close button and horizontal scrolling take touches; the gaps between
// chips stay transparent so the chat underneath keeps working.
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  UIView *hit = [super hitTest:point withEvent:event];
  if (hit == self || hit == self.chips) return nil;
  if (hit == self.scroll && CGRectGetMaxX(self.chips.frame) - self.scroll.contentOffset.x < point.x) return nil;
  return hit;
}

- (void)bindItems:(NSArray<NSDictionary *> *)items {
  NSMutableString *signature = [NSMutableString string];
  for (NSDictionary *item in items) [signature appendFormat:@"%@:%@\n", item[@"type"], item[@"text"]];
  if ([signature isEqualToString:self.signature ?: @""]) return;
  self.signature = signature;
  for (UIView *view in self.chips.arrangedSubviews) [view removeFromSuperview];
  for (NSDictionary *item in items) {
    BOOL phrase = [item[@"type"] isEqualToString:@"phrase"];
    UIButton *chip = [UIButton buttonWithType:UIButtonTypeCustom];
    UIButtonConfiguration *config = UIButtonConfiguration.plainButtonConfiguration;
    config.title = item[@"text"];
    config.image = RBGlyphImage(phrase ? RBGlyphBolt : RBGlyphSparkle, 11, 0);
    config.imagePadding = 4;
    config.imageColorTransformer = ^UIColor *(UIColor *c) { return phrase ? RBThemeAccent() : RBThemeTextSecondary(); };
    config.baseForegroundColor = RBThemeTextPrimary();
    config.contentInsets = NSDirectionalEdgeInsetsMake(4, 9, 4, 10);
    config.titleLineBreakMode = NSLineBreakByTruncatingTail;
    config.titleTextAttributesTransformer = ^NSDictionary *(NSDictionary *attributes) {
      NSMutableDictionary *next = [attributes mutableCopy];
      next[NSFontAttributeName] = RBSuggestionsChipFont();
      return next;
    };
    config.background.backgroundColor = RBThemeElevated();
    config.background.cornerRadius = 13;
    config.background.strokeColor = RBThemeBorder();
    config.background.strokeWidth = 1.0 / UIScreen.mainScreen.scale;
    chip.configuration = config;
    chip.accessibilityLabel = [NSString stringWithFormat:@"%@%@", phrase ? RBL(@"常用语：", @"Quick phrase: ") : RBL(@"建议：", @"Suggestion: "), item[@"text"]];
    chip.accessibilityHint = RBL(@"点击直接发送", @"Sends immediately");
    chip.accessibilityIdentifier = phrase ? @"rokbot.suggestions.phrase" : @"rokbot.suggestions.ai";
    [chip.widthAnchor constraintLessThanOrEqualToConstant:200].active = YES;
    [chip.heightAnchor constraintEqualToConstant:RBSuggestionsChipHeight()].active = YES;
    __weak typeof(self) weak = self;
    NSDictionary *captured = [item copy];
    [chip addAction:[UIAction actionWithHandler:^(UIAction *action) {
      if (weak.onTap) weak.onTap(captured);
    }] forControlEvents:UIControlEventTouchUpInside];
    [self.chips addArrangedSubview:chip];
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
    runtime.phrases = @[];
    runtime.currentAI = @[];
    runtime.aiCache = [NSCache new];
    runtime.aiCache.countLimit = 40;
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
        [self hide];
      }
    }];
  }
  for (NSString *name in @[UITextViewTextDidEndEditingNotification, UITextFieldTextDidEndEditingNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
      if (n.object == self.input) {
        self.input = nil;
        [self hide];
      }
    }];
  }
  for (NSString *name in @[UITextViewTextDidChangeNotification, UITextFieldTextDidChangeNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) {
      if (n.object == self.input) [self refresh];
    }];
  }
  [center addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:NSOperationQueue.mainQueue
                  usingBlock:^(NSNotification *n) { [self hide]; }];
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

- (void)invalidate {
  self.settingsAt = nil;
  self.fetchingKey = nil;
  self.fetchSeq++;
  self.dismissedKey = nil;
  self.failedKey = nil;
  self.prefetchKey = nil;
  self.currentAI = @[];
  self.currentAIKey = nil;
  [self.aiCache removeAllObjects];
  [self syncSettings:YES];
}

- (NSString *)currentKey {
  return RBSuggestionsKeyFor(RBActiveAgent);
}

- (NSArray<NSString *> *)cachedForKey:(NSString *)key {
  NSDictionary *cached = [self.aiCache objectForKey:key];
  if (cached && -[cached[@"at"] timeIntervalSinceNow] < RBSuggestionsCacheTTL) return cached[@"items"];
  return nil;
}

- (void)refresh {
  UIView *input = self.input;
  if (!input || !input.window || !input.isFirstResponder || !RBConnection.shared.isPaired || self.sending) {
    [self hide];
    return;
  }
  if (RBSuggestionsInputText(input).length && RBSuggestionsTrim(RBSuggestionsInputText(input)).length) {
    [self hide];
    return;
  }
  if (!self.enabled) {
    [self hide];
    return;
  }
  NSString *key = [self currentKey];
  if ([key isEqualToString:self.dismissedKey ?: @""]) {
    [self hide];
    return;
  }
  NSArray<NSString *> *ai = @[];
  if (self.aiEnabled && RBActiveAgent.length) {
    NSArray<NSString *> *cached = [self cachedForKey:key];
    if (cached) {
      self.currentAI = cached;
      self.currentAIKey = key;
    } else if (![key isEqualToString:self.fetchingKey ?: @""] &&
               !([key isEqualToString:self.failedKey ?: @""] && -self.failedAt.timeIntervalSinceNow < RBSuggestionsFailureBackoff)) {
      [self fetchForKey:key agent:RBActiveAgent];
    }
    // Never show suggestions that belong to another bot or an earlier turn.
    if ([self.currentAIKey isEqualToString:key]) ai = self.currentAI ?: @[];
  }
  NSArray<NSDictionary *> *items = RBSuggestionsMergeItems(self.phrases, ai);
  if (!items.count) {
    [self hide];
    return;
  }
  [self showItems:items];
}

- (NSString *)newRequestId:(NSString *)kind seq:(NSUInteger)seq {
  NSString *nonce = [NSUUID.UUID.UUIDString.lowercaseString substringToIndex:8];
  return [NSString stringWithFormat:@"ios-%@-%lu-%@", kind, (unsigned long)seq, nonce];
}

- (void)fetchForKey:(NSString *)key agent:(NSString *)agent {
  NSUInteger seq = ++self.fetchSeq;
  self.fetchingKey = key;
  self.fetchingAt = NSDate.date;
  NSString *requestId = [self newRequestId:@"f" seq:seq];
  RBHostRequest(@"POST", @"/local/suggestions", RBSuggestionsRequestBody(agent, RBSuggestionsLocale(), requestId, NO),
                RBSuggestionsTimeout, ^(NSInteger status, id json, NSError *error) {
                  // Late or foreign responses (bot switched, newer request, echo mismatch) are dropped.
                  if (seq != self.fetchSeq) return;
                  if (!RBSuggestionsAcceptResponse(json, agent, requestId, RBActiveAgent, seq, self.fetchSeq)) {
                    self.fetchingKey = nil;
                    self.fetchingAt = nil;
                    self.failedKey = key;
                    self.failedAt = NSDate.date;
                    return;
                  }
                  self.fetchingAt = nil;
                  NSArray<NSString *> *ai = status == 200 ? RBSuggestionsAIFromResponse(json) : @[];
                  if (status == 200 && [json isKindOfClass:NSDictionary.class]) [self applySettings:json];
                  // Never cache failures or empty results; a later focus retries (after a short backoff on errors).
                  if (ai.count) [self.aiCache setObject:@{ @"items" : ai, @"at" : NSDate.date } forKey:key];
                  if (status != 200) {
                    self.failedKey = key;
                    self.failedAt = NSDate.date;
                  }
                  self.currentAI = ai;
                  self.currentAIKey = key;
                  [self refresh];
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
                  NSArray<NSString *> *ai = RBSuggestionsAIFromResponse(json);
                  if (!ai.count) return;
                  [self.aiCache setObject:@{ @"items" : ai, @"at" : NSDate.date } forKey:key];
                  if ([key isEqualToString:[self currentKey]] && self.input) [self refresh];
                });
}

- (void)activateAgent:(NSString *)agent turn:(BOOL)turn {
  if (!agent.length) return;
  BOOL changed = ![agent isEqualToString:RBActiveAgent ?: @""];
  RBActiveAgent = RBSuggestionsResolveAgent(RBActiveAgent, agent, turn ? RBSuggestionsSignalTurn : RBSuggestionsSignalActivate);
  if (turn) RBSuggestionsBumpGeneration(agent);
  if (changed) {
    // Switching bots clears the old bot's suggestions immediately and orphans its in-flight request.
    self.currentAI = @[];
    self.currentAIKey = nil;
    self.fetchingKey = nil;
    self.fetchSeq++;
    [self hide];
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
  if (![agent isEqualToString:RBActiveAgent ?: @""]) return;
  [self prefetchAgent:agent];
  [self refresh];
}

- (void)showItems:(NSArray<NSDictionary *> *)items {
  UIWindow *window = self.input.window;
  if (!window) return;
  if (!self.bar) {
    self.bar = [[RBSuggestionsBar alloc] initWithFrame:CGRectZero];
    __weak typeof(self) weak = self;
    self.bar.onTap = ^(NSDictionary *item) { [weak send:item[@"text"]]; };
    self.bar.onClose = ^{
      weak.dismissedKey = [weak currentKey];
      [weak hide];
    };
  }
  if (self.bar.superview != window) [window addSubview:self.bar];
  [self.bar bindItems:items];
  [self reposition];
  if (self.bar.hidden || self.bar.alpha < 1) {
    self.bar.hidden = NO;
    [UIView animateWithDuration:0.16 animations:^{ self.bar.alpha = 1; }];
  }
  if (!self.link) {
    self.link = [CADisplayLink displayLinkWithTarget:self selector:@selector(reposition)];
    self.link.preferredFrameRateRange = CAFrameRateRangeMake(20, 60, 30);
    [self.link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  }
}

- (void)reposition {
  UIView *input = self.input;
  if (!input.window || !self.bar.superview) {
    [self hide];
    return;
  }
  CGRect anchor = RBSuggestionsAnchorRect(input);
  // Compact single row (26pt chips) hugging the composer so it covers as little of the last message as possible.
  CGFloat height = RBSuggestionsChipHeight() + 4;
  CGFloat y = MAX(input.window.safeAreaInsets.top + 4, CGRectGetMinY(anchor) - height - 2);
  CGRect frame = CGRectMake(0, y, input.window.bounds.size.width, height);
  if (!CGRectEqualToRect(self.bar.frame, frame)) self.bar.frame = frame;
  [self.bar.superview bringSubviewToFront:self.bar];
}

- (void)hide {
  [self.link invalidate];
  self.link = nil;
  if (self.bar && !self.bar.hidden) {
    self.bar.hidden = YES;
    self.bar.alpha = 0;
  }
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
  [self hide];
  UIImpactFeedbackGenerator *haptic = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
  [haptic impactOccurred];
  RBHostRequest(@"POST", @"/api/sendPrompt", RBSuggestionsSendBody(agent, text, nil), 30,
                ^(NSInteger status, id json, NSError *error) {
                  self.sending = NO;
                  if (status >= 200 && status < 300) {
                    RBSuggestionsBumpGeneration(agent);
                    self.currentAI = @[];
                    self.currentAIKey = nil;
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
  [self hide];
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
  UIView *enabledRow = [self switchRowTitle:RBL(@"输入建议", @"Input Suggestions")
                                   subtitle:RBL(@"输入框聚焦时显示常用语与快捷建议，点击直接发送", @"Show quick phrases and smart replies on focus; tap to send")
                                    control:self.enabledSwitch];
  self.aiRow = [self switchRowTitle:RBL(@"AI 生成建议", @"AI-Generated Suggestions")
                           subtitle:RBL(@"根据当前对话上下文由模型自动生成回复建议，空会话只显示常用语", @"Generate contextual replies from conversation history; empty chats show quick phrases only")
                            control:self.aiSwitch];
  [self.stack addArrangedSubview:[self sectionHeader:RBL(@"开关", @"Switches")]];
  [self.stack addArrangedSubview:[self card:@[enabledRow, self.aiRow]]];
  [self.stack setCustomSpacing:22 afterView:self.stack.arrangedSubviews.lastObject];

  [self.stack addArrangedSubview:[self sectionHeader:RBL(@"自定义常用语", @"Quick Phrases")]];
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
}

- (void)switchChanged:(UISwitch *)sender {
  [self applyEnabledState];
  NSDictionary *body = @{ @"enabled" : @(self.enabledSwitch.on), @"aiEnabled" : @(self.aiSwitch.on) };
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
