#import "RBGroupCreate.h"
#import <TargetConditionals.h>

const NSUInteger RBGroupMaxBots = 6;
const NSUInteger RBGroupMaxNameLength = 72;

static NSString *RBGroupString(id value) {
  if (![value isKindOfClass:NSString.class]) return @"";
  return [(NSString *)value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

NSString *RBGroupNormalizeName(NSString *raw) {
  NSString *trimmed = RBGroupString(raw);
  if (!trimmed.length) return @"";
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  for (NSString *part in [trimmed componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet])
    if (part.length) [parts addObject:part];
  NSString *collapsed = [parts componentsJoinedByString:@" "];
  if (collapsed.length <= RBGroupMaxNameLength) return collapsed;
  NSRange safe = [collapsed rangeOfComposedCharacterSequencesForRange:NSMakeRange(0, RBGroupMaxNameLength)];
  NSUInteger end = NSMaxRange(safe) > RBGroupMaxNameLength ? safe.location : NSMaxRange(safe);
  if (end == 0) end = RBGroupMaxNameLength;
  return RBGroupString([collapsed substringToIndex:MIN(end, collapsed.length)]);
}

NSString *RBGroupNormalizeForMatch(NSString *raw) {
  if (![raw isKindOfClass:NSString.class] || !raw.length) return @"";
  NSString *decomposed = raw.decomposedStringWithCompatibilityMapping;
  NSCharacterSet *marks = NSCharacterSet.nonBaseCharacterSet;
  NSCharacterSet *alnum = NSCharacterSet.alphanumericCharacterSet;
  NSMutableString *out = [NSMutableString string];
  __block BOOL pendingSpace = NO;
  [decomposed enumerateSubstringsInRange:NSMakeRange(0, decomposed.length)
                                 options:NSStringEnumerationByComposedCharacterSequences
                              usingBlock:^(NSString *sequence, NSRange r, NSRange e, BOOL *stop) {
    NSMutableString *base = [NSMutableString string];
    for (NSUInteger i = 0; i < sequence.length; i++) {
      unichar c = [sequence characterAtIndex:i];
      if ([marks characterIsMember:c]) continue;
      [base appendFormat:@"%C", c];
    }
    if (!base.length) return;
    unichar first = [base characterAtIndex:0];
    BOOL letterOrDigit = [alnum characterIsMember:first] || CFStringIsSurrogateHighCharacter(first);
    if (!letterOrDigit) {
      pendingSpace = YES;
      return;
    }
    if (pendingSpace && out.length) [out appendString:@" "];
    pendingSpace = NO;
    [out appendString:base.lowercaseString];
  }];
  return out;
}

static BOOL RBGroupBool(id value) {
  return [value isKindOfClass:NSNumber.class] && [value boolValue];
}

NSArray<NSDictionary *> *RBGroupEligibleBots(id response) {
  NSArray *list = nil;
  if ([response isKindOfClass:NSArray.class]) list = response;
  else if ([response isKindOfClass:NSDictionary.class] && [response[@"agents"] isKindOfClass:NSArray.class]) list = response[@"agents"];
  NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  for (id raw in list ?: @[]) {
    if (![raw isKindOfClass:NSDictionary.class]) continue;
    if (RBGroupBool(raw[@"isGroup"]) || RBGroupBool(raw[@"isHiddenFromSidebar"])) continue;
    NSString *agentId = RBGroupString(raw[@"id"]);
    if (!agentId.length || [seen containsObject:agentId]) continue;
    [seen addObject:agentId];
    NSString *name = RBGroupString(raw[@"name"]);
    NSString *title = RBGroupString(raw[@"title"]);
    NSString *description = RBGroupString(raw[@"description"]);
    NSString *avatar = RBGroupString(raw[@"avatarDataUrl"]);
    if (!avatar.length && [raw[@"avatar"] isKindOfClass:NSDictionary.class]) avatar = RBGroupString(raw[@"avatar"][@"dataUrl"]);
    [out addObject:@{
      @"id" : agentId,
      @"name" : name.length ? name : agentId,
      @"subtitle" : title.length ? title : description,
      @"avatarDataUrl" : avatar,
    }];
  }
  return out;
}

NSDictionary *RBGroupRecipientFromBot(NSDictionary *bot) {
  return @{ @"isNewBot" : @NO, @"id" : RBGroupString(bot[@"id"]), @"name" : RBGroupString(bot[@"name"]),
            @"avatarDataUrl" : RBGroupString(bot[@"avatarDataUrl"]) };
}

NSDictionary *RBGroupRecipientNewBot(NSString *rawName) {
  return @{ @"isNewBot" : @YES, @"id" : @"", @"name" : RBGroupNormalizeName(rawName), @"avatarDataUrl" : @"" };
}

static BOOL RBGroupIsDuplicate(NSArray<NSDictionary *> *selected, NSDictionary *candidate) {
  BOOL candidateNew = RBGroupBool(candidate[@"isNewBot"]);
  NSString *candidateNorm = RBGroupNormalizeForMatch(candidate[@"name"]);
  for (NSDictionary *recipient in selected ?: @[]) {
    BOOL recipientNew = RBGroupBool(recipient[@"isNewBot"]);
    if (!candidateNew && !recipientNew) {
      if ([recipient[@"id"] isEqual:candidate[@"id"]]) return YES;
    } else if (candidateNorm.length && [candidateNorm isEqualToString:RBGroupNormalizeForMatch(recipient[@"name"])]) {
      return YES;
    }
  }
  return NO;
}

BOOL RBGroupCanAddRecipient(NSArray<NSDictionary *> *selected, NSDictionary *candidate) {
  if (!candidate) return NO;
  if (RBGroupBool(candidate[@"isNewBot"]) ? !RBGroupString(candidate[@"name"]).length : !RBGroupString(candidate[@"id"]).length)
    return NO;
  if (selected.count >= RBGroupMaxBots) return NO;
  return !RBGroupIsDuplicate(selected, candidate);
}

static NSInteger RBGroupScore(NSString *name, NSString *subtitle, NSString *query, NSArray<NSString *> *tokens) {
  NSInteger total = 0;
  for (NSString *token in tokens) {
    if (!token.length) continue;
    NSInteger best = -1;
    if ([name isEqualToString:token]) best = 100;
    else if ([name hasPrefix:token]) best = 80;
    else if ([name containsString:[@" " stringByAppendingString:token]]) best = 65;
    else if ([name containsString:token]) best = 50;
    else if (subtitle.length && [subtitle containsString:token]) best = 20;
    if (best < 0) return -1;
    total += best;
  }
  if ([name isEqualToString:query]) total += 150;
  else if ([name hasPrefix:query]) total += 60;
  else if ([name containsString:query]) total += 30;
  return total;
}

NSArray<NSDictionary *> *RBGroupFilterCandidates(NSArray<NSDictionary *> *eligible, NSArray<NSDictionary *> *selected,
                                                 NSString *query) {
  NSMutableSet<NSString *> *selectedIds = [NSMutableSet set];
  for (NSDictionary *recipient in selected ?: @[])
    if (!RBGroupBool(recipient[@"isNewBot"]) && RBGroupString(recipient[@"id"]).length) [selectedIds addObject:recipient[@"id"]];
  NSMutableArray<NSDictionary *> *remaining = [NSMutableArray array];
  for (NSDictionary *bot in eligible ?: @[])
    if (![selectedIds containsObject:bot[@"id"]]) [remaining addObject:bot];
  NSString *normalized = RBGroupNormalizeForMatch(query);
  if (!normalized.length) return remaining;
  NSArray<NSString *> *tokens = [normalized componentsSeparatedByString:@" "];
  NSMutableArray<NSDictionary *> *scored = [NSMutableArray array];
  [remaining enumerateObjectsUsingBlock:^(NSDictionary *bot, NSUInteger index, BOOL *stop) {
    NSInteger score = RBGroupScore(RBGroupNormalizeForMatch(bot[@"name"]), RBGroupNormalizeForMatch(bot[@"subtitle"]),
                                   normalized, tokens);
    if (score >= 0) [scored addObject:@{ @"bot" : bot, @"score" : @(score), @"index" : @(index) }];
  }];
  [scored sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    NSComparisonResult byScore = [b[@"score"] compare:a[@"score"]];
    return byScore != NSOrderedSame ? byScore : [a[@"index"] compare:b[@"index"]];
  }];
  NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
  for (NSDictionary *entry in scored) [out addObject:entry[@"bot"]];
  return out;
}

BOOL RBGroupCanOfferNewBot(NSArray<NSDictionary *> *eligible, NSArray<NSDictionary *> *selected, NSString *query) {
  if (selected.count >= RBGroupMaxBots) return NO;
  NSString *normalized = RBGroupNormalizeForMatch(query);
  if (!normalized.length) return NO;
  for (NSDictionary *bot in eligible ?: @[])
    if ([normalized isEqualToString:RBGroupNormalizeForMatch(bot[@"name"])]) return NO;
  for (NSDictionary *recipient in selected ?: @[])
    if ([normalized isEqualToString:RBGroupNormalizeForMatch(recipient[@"name"])]) return NO;
  return YES;
}

NSString *RBGroupFormatList(NSArray<NSString *> *items, BOOL chinese, BOOL narrow) {
  NSMutableArray<NSString *> *clean = [NSMutableArray array];
  for (id item in items ?: @[]) {
    NSString *text = RBGroupString(item);
    if (text.length) [clean addObject:text];
  }
  if (!clean.count) return @"";
  if (clean.count == 1) return clean.firstObject;
  if (narrow) return [clean componentsJoinedByString:chinese ? @"、" : @", "];
  if (clean.count == 2) return [NSString stringWithFormat:chinese ? @"%@和%@" : @"%@ and %@", clean[0], clean[1]];
  NSMutableString *out = [NSMutableString string];
  for (NSUInteger i = 0; i < clean.count; i++) {
    if (i == clean.count - 1) [out appendString:chinese ? @"和" : @", and "];
    else if (i > 0) [out appendString:chinese ? @"、" : @", "];
    [out appendString:clean[i]];
  }
  return out;
}

static NSArray<NSString *> *RBGroupNames(NSArray<NSDictionary *> *recipients) {
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  for (NSDictionary *recipient in recipients ?: @[]) {
    NSString *name = RBGroupString(recipient[@"name"]);
    if (name.length) [names addObject:name];
  }
  return names;
}

NSString *RBGroupComposerNames(NSArray<NSDictionary *> *recipients, BOOL chinese) {
  return RBGroupFormatList(RBGroupNames(recipients), chinese, NO);
}

NSString *RBGroupAutoName(NSArray<NSDictionary *> *recipients, NSString *accountName, BOOL chinese) {
  NSArray<NSString *> *names = RBGroupNames(recipients);
  if (!names.count) return @"";
  NSString *account = RBGroupString(accountName);
  if (!account.length) return RBGroupNormalizeName(RBGroupFormatList(names, chinese, NO));
  NSMutableArray<NSString *> *combined = [NSMutableArray array];
  if (names.count == 1) {
    [combined addObject:names.firstObject];
    [combined addObject:account];
  } else {
    [combined addObject:account];
    [combined addObjectsFromArray:names];
  }
  return RBGroupNormalizeName(RBGroupFormatList(combined, chinese, YES));
}

BOOL RBGroupCanSubmit(NSArray<NSDictionary *> *recipients, BOOL submitting) {
  return !submitting && recipients.count > 0 && recipients.count <= RBGroupMaxBots;
}

NSString *RBGroupCreatedId(id response) {
  if (![response isKindOfClass:NSDictionary.class]) return @"";
  if ([response[@"agent"] isKindOfClass:NSDictionary.class]) {
    NSString *nested = RBGroupString(response[@"agent"][@"id"]);
    if (nested.length) return nested;
  }
  return RBGroupString(response[@"id"]);
}

NSDictionary *RBGroupCreateBody(NSString *name, NSArray<NSString *> *memberIds) {
  NSMutableArray<NSString *> *members = [NSMutableArray array];
  for (id raw in memberIds ?: @[]) {
    NSString *memberId = RBGroupString(raw);
    if (memberId.length && ![members containsObject:memberId]) [members addObject:memberId];
  }
  return @{ @"name" : RBGroupString(name), @"description" : @"", @"memberAgentIds" : members };
}

BOOL RBGroupIsNewChatLabel(NSString *label) {
  NSString *trimmed = RBGroupString(label);
  if (!trimmed.length) return NO;
  static NSSet<NSString *> *labels;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    labels = [NSSet setWithArray:@[@"新建对话", @"新增聊天", @"新建聊天", @"new chat", @"新建 bot", @"new bot"]];
  });
  return [labels containsObject:trimmed.lowercaseString];
}

#if TARGET_OS_IOS

#import "RBChoiceSheet.h"
#import "RBConnection.h"
#import "RBDeepLinks.h"
#import "RBHostAPI.h"
#import "RBLocalize.h"
#import "RBTheme.h"
#import <UIKit/UIKit.h>

#pragma mark - Flow layout for recipient chips

@interface RBGroupFlowView : UIView
@property(nonatomic, assign) CGFloat spacing;
@property(nonatomic, assign) CGFloat minLastWidth;
@end

@implementation RBGroupFlowView
- (CGSize)layoutFor:(CGFloat)width apply:(BOOL)apply {
  CGFloat x = 0, y = 0, lineHeight = 0;
  NSArray<UIView *> *views = self.subviews;
  for (NSUInteger i = 0; i < views.count; i++) {
    UIView *view = views[i];
    BOOL last = i == views.count - 1;
    CGSize size = [view systemLayoutSizeFittingSize:UILayoutFittingCompressedSize];
    size.width = MIN(size.width, width);
    if (last) size.width = MAX(self.minLastWidth, size.width);
    if (x > 0 && x + size.width > width) {
      x = 0;
      y += lineHeight + self.spacing;
      lineHeight = 0;
    }
    if (last) size.width = MAX(size.width, width - x);
    if (apply) view.frame = CGRectMake(x, y, MIN(size.width, width), size.height);
    x += size.width + self.spacing;
    lineHeight = MAX(lineHeight, size.height);
  }
  return CGSizeMake(width, y + lineHeight);
}
- (void)layoutSubviews {
  [super layoutSubviews];
  [self layoutFor:self.bounds.size.width apply:YES];
  [self invalidateIntrinsicContentSize];
}
- (CGSize)intrinsicContentSize {
  CGFloat width = self.bounds.size.width > 0 ? self.bounds.size.width : UIScreen.mainScreen.bounds.size.width - 80;
  return [self layoutFor:width apply:NO];
}
@end

#pragma mark - Controller

static UIImage *RBGroupAvatarImage(NSString *dataUrl) {
  if (![dataUrl hasPrefix:@"data:image/"]) return nil;
  NSRange comma = [dataUrl rangeOfString:@","];
  if (comma.location == NSNotFound) return nil;
  NSData *data = [[NSData alloc] initWithBase64EncodedString:[dataUrl substringFromIndex:comma.location + 1]
                                                     options:NSDataBase64DecodingIgnoreUnknownCharacters];
  return data.length ? [UIImage imageWithData:data] : nil;
}

static UIView *RBGroupAvatarView(NSDictionary *item, CGFloat size, BOOL isNewBot) {
  UIView *well = [UIView new];
  well.backgroundColor = RBThemeSecondaryFill();
  well.layer.cornerRadius = size / 2;
  well.clipsToBounds = YES;
  [well.widthAnchor constraintEqualToConstant:size].active = YES;
  [well.heightAnchor constraintEqualToConstant:size].active = YES;
  UIImage *avatar = isNewBot ? nil : RBGroupAvatarImage(item[@"avatarDataUrl"]);
  UIImageView *image = [[UIImageView alloc] initWithImage:avatar ?: RBGlyphImage(isNewBot ? RBGlyphPlus : RBGlyphPerson, size * 0.62, MAX(1.4, size / 14))];
  image.contentMode = avatar ? UIViewContentModeScaleAspectFill : UIViewContentModeCenter;
  image.tintColor = RBThemeTextSecondary();
  image.translatesAutoresizingMaskIntoConstraints = NO;
  [well addSubview:image];
  [NSLayoutConstraint activateConstraints:@[
    [image.leadingAnchor constraintEqualToAnchor:well.leadingAnchor],
    [image.trailingAnchor constraintEqualToAnchor:well.trailingAnchor],
    [image.topAnchor constraintEqualToAnchor:well.topAnchor],
    [image.bottomAnchor constraintEqualToAnchor:well.bottomAnchor],
  ]];
  return well;
}

@interface RBGroupCreateController : UIViewController <UITextFieldDelegate, UITextViewDelegate>
@property(nonatomic, copy) NSArray<NSDictionary *> *eligible;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *recipients;
@property(nonatomic, copy) NSString *accountName;
@property(nonatomic, assign) BOOL submitting;
@property(nonatomic, assign) BOOL loading;
@property(nonatomic, copy) NSString *loadError;
@property(nonatomic, strong) UILabel *countLabel;
@property(nonatomic, strong) UIButton *createButton;
@property(nonatomic, strong) RBGroupFlowView *flow;
@property(nonatomic, strong) UIScrollView *flowScroll;
@property(nonatomic, strong) NSLayoutConstraint *flowHeight;
@property(nonatomic, strong) UITextField *search;
@property(nonatomic, strong) UIView *menu;
@property(nonatomic, strong) UIStackView *menuList;
@property(nonatomic, strong) UIView *banner;
@property(nonatomic, strong) UILabel *bannerText;
@property(nonatomic, strong) UIButton *bannerRetry;
@property(nonatomic, strong) UITextView *composer;
@property(nonatomic, strong) UILabel *composerPlaceholder;
@property(nonatomic, strong) UIButton *sendButton;
@property(nonatomic, assign) BOOL lastSubmitHadPrompt;
@end

@implementation RBGroupCreateController

- (UILabel *)label:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight color:(UIColor *)color {
  UILabel *label = [UILabel new];
  label.text = text;
  label.font = RBThemeFont(size, weight);
  label.textColor = color;
  label.adjustsFontForContentSizeCategory = YES;
  return label;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.recipients = [NSMutableArray array];
  self.eligible = @[];
  self.view.backgroundColor = RBThemeChrome();
  self.navigationController.navigationBarHidden = YES;

  UIButton *back = [UIButton buttonWithType:UIButtonTypeSystem];
  [back setImage:RBGlyphImage(RBGlyphBack, 24, 2) forState:UIControlStateNormal];
  back.tintColor = RBThemeTextPrimary();
  back.accessibilityLabel = RBL(@"返回", @"Back");
  back.accessibilityIdentifier = @"rokbot.group.back";
  [back addTarget:self action:@selector(close) forControlEvents:UIControlEventTouchUpInside];
  [back.widthAnchor constraintEqualToConstant:40].active = YES;
  [back.heightAnchor constraintEqualToConstant:40].active = YES;
  UILabel *title = [self label:RBL(@"创建群聊", @"New Group Chat") size:18 weight:UIFontWeightSemibold color:RBThemeTextPrimary()];
  title.accessibilityTraits = UIAccessibilityTraitHeader;
  self.countLabel = [self label:@"0/6" size:12 weight:UIFontWeightMedium color:RBThemeTextSecondary()];
  self.countLabel.accessibilityIdentifier = @"rokbot.group.count";
  self.createButton = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(self.createButton, RBL(@"创建", @"Create"), YES);
  self.createButton.accessibilityIdentifier = @"rokbot.group.create";
  [self.createButton addTarget:self action:@selector(createTapped) forControlEvents:UIControlEventTouchUpInside];
  [self.createButton setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  UIView *spacer = [UIView new];
  UIStackView *top = [[UIStackView alloc] initWithArrangedSubviews:@[back, title, self.countLabel, spacer, self.createButton]];
  top.alignment = UIStackViewAlignmentCenter;
  top.spacing = 8;
  top.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:top];

  UIView *toBar = [UIView new];
  toBar.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:toBar];
  UIView *toLine = [UIView new];
  toLine.backgroundColor = RBThemeBorder();
  toLine.translatesAutoresizingMaskIntoConstraints = NO;
  [toBar addSubview:toLine];
  UILabel *to = [self label:RBL(@"收件人：", @"To:") size:15 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
  to.translatesAutoresizingMaskIntoConstraints = NO;
  [to setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [to setContentCompressionResistancePriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  [toBar addSubview:to];
  self.flowScroll = [UIScrollView new];
  self.flowScroll.translatesAutoresizingMaskIntoConstraints = NO;
  [toBar addSubview:self.flowScroll];
  self.flow = [RBGroupFlowView new];
  self.flow.spacing = 6;
  self.flow.minLastWidth = 120;
  self.flow.translatesAutoresizingMaskIntoConstraints = NO;
  [self.flowScroll addSubview:self.flow];
  self.search = [UITextField new];
  self.search.font = RBThemeFont(15, UIFontWeightRegular);
  self.search.adjustsFontForContentSizeCategory = YES;
  self.search.textColor = RBThemeTextPrimary();
  self.search.placeholder = RBL(@"搜索 Bot 或输入新 Bot 名称…", @"Start a chat with…");
  self.search.autocorrectionType = UITextAutocorrectionTypeNo;
  self.search.returnKeyType = UIReturnKeyDone;
  self.search.delegate = self;
  self.search.accessibilityIdentifier = @"rokbot.group.search";
  [self.search addTarget:self action:@selector(searchChanged) forControlEvents:UIControlEventEditingChanged];
  [self.search.heightAnchor constraintGreaterThanOrEqualToConstant:30].active = YES;
  self.flowHeight = [self.flowScroll.heightAnchor constraintEqualToConstant:30];

  self.menu = RBThemeCard(14);
  self.menu.translatesAutoresizingMaskIntoConstraints = NO;
  self.menu.layer.shadowColor = UIColor.blackColor.CGColor;
  self.menu.accessibilityIdentifier = @"rokbot.group.candidates";
  [self.view addSubview:self.menu];
  UIScrollView *menuScroll = [UIScrollView new];
  menuScroll.translatesAutoresizingMaskIntoConstraints = NO;
  menuScroll.keyboardDismissMode = UIScrollViewKeyboardDismissModeInteractive;
  [self.menu addSubview:menuScroll];
  self.menuList = [UIStackView new];
  self.menuList.axis = UILayoutConstraintAxisVertical;
  self.menuList.spacing = 2;
  self.menuList.translatesAutoresizingMaskIntoConstraints = NO;
  [menuScroll addSubview:self.menuList];

  self.banner = RBThemeCard(12);
  self.banner.translatesAutoresizingMaskIntoConstraints = NO;
  self.banner.hidden = YES;
  self.banner.layer.borderColor = RBThemeDanger().CGColor;
  self.bannerText = [self label:@"" size:13 weight:UIFontWeightRegular color:RBThemeTextPrimary()];
  self.bannerText.numberOfLines = 0;
  self.bannerRetry = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(self.bannerRetry, RBL(@"重试创建群组", @"Retry group creation"), YES);
  [self.bannerRetry addTarget:self action:@selector(retryTapped) forControlEvents:UIControlEventTouchUpInside];
  UIButton *bannerBack = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(bannerBack, RBL(@"返回聊天", @"Back to chats"), NO);
  [bannerBack addTarget:self action:@selector(close) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *bannerButtons = [[UIStackView alloc] initWithArrangedSubviews:@[self.bannerRetry, bannerBack]];
  bannerButtons.spacing = 8;
  UIStackView *bannerStack = [[UIStackView alloc] initWithArrangedSubviews:@[self.bannerText, bannerButtons]];
  bannerStack.axis = UILayoutConstraintAxisVertical;
  bannerStack.spacing = 10;
  bannerStack.alignment = UIStackViewAlignmentLeading;
  bannerStack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.banner addSubview:bannerStack];
  [self.view addSubview:self.banner];

  UIView *composerBox = [UIView new];
  composerBox.translatesAutoresizingMaskIntoConstraints = NO;
  composerBox.backgroundColor = RBThemeElevated();
  composerBox.layer.cornerRadius = 22;
  composerBox.layer.borderWidth = 1.0 / UIScreen.mainScreen.scale;
  composerBox.layer.borderColor = RBThemeBorder().CGColor;
  [self.view addSubview:composerBox];
  self.composer = [UITextView new];
  self.composer.translatesAutoresizingMaskIntoConstraints = NO;
  self.composer.backgroundColor = UIColor.clearColor;
  self.composer.font = RBThemeFont(15, UIFontWeightRegular);
  self.composer.adjustsFontForContentSizeCategory = YES;
  self.composer.textColor = RBThemeTextPrimary();
  self.composer.scrollEnabled = NO;
  self.composer.delegate = self;
  self.composer.textContainerInset = UIEdgeInsetsMake(11, 2, 11, 2);
  self.composer.accessibilityIdentifier = @"rokbot.group.message";
  [composerBox addSubview:self.composer];
  self.composerPlaceholder = [self label:@"" size:15 weight:UIFontWeightRegular color:RBThemeTextMuted()];
  self.composerPlaceholder.translatesAutoresizingMaskIntoConstraints = NO;
  self.composerPlaceholder.userInteractionEnabled = NO;
  [composerBox addSubview:self.composerPlaceholder];
  self.sendButton = [UIButton buttonWithType:UIButtonTypeCustom];
  self.sendButton.translatesAutoresizingMaskIntoConstraints = NO;
  [self.sendButton setImage:RBGlyphImage(RBGlyphSend, 20, 2.2) forState:UIControlStateNormal];
  self.sendButton.layer.cornerRadius = 16;
  self.sendButton.accessibilityLabel = RBL(@"创建并发送", @"Create and send");
  self.sendButton.accessibilityIdentifier = @"rokbot.group.send";
  [self.sendButton addTarget:self action:@selector(sendTapped) forControlEvents:UIControlEventTouchUpInside];
  [composerBox addSubview:self.sendButton];

  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  NSLayoutConstraint *menuBottom = [self.menu.bottomAnchor constraintLessThanOrEqualToAnchor:self.banner.topAnchor constant:-10];
  NSLayoutConstraint *menuHeight = [menuScroll.heightAnchor constraintEqualToAnchor:self.menuList.heightAnchor constant:12];
  menuHeight.priority = UILayoutPriorityDefaultHigh;
  [NSLayoutConstraint activateConstraints:@[
    [top.topAnchor constraintEqualToAnchor:safe.topAnchor constant:4],
    [top.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:8],
    [top.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-14],
    [top.heightAnchor constraintGreaterThanOrEqualToConstant:52],
    [toBar.topAnchor constraintEqualToAnchor:top.bottomAnchor constant:2],
    [toBar.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor],
    [toBar.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
    [toBar.heightAnchor constraintGreaterThanOrEqualToConstant:50],
    [toLine.leadingAnchor constraintEqualToAnchor:toBar.leadingAnchor],
    [toLine.trailingAnchor constraintEqualToAnchor:toBar.trailingAnchor],
    [toLine.bottomAnchor constraintEqualToAnchor:toBar.bottomAnchor],
    [toLine.heightAnchor constraintEqualToConstant:1.0 / UIScreen.mainScreen.scale],
    [to.leadingAnchor constraintEqualToAnchor:toBar.leadingAnchor constant:16],
    [to.topAnchor constraintEqualToAnchor:toBar.topAnchor constant:15],
    [self.flowScroll.leadingAnchor constraintEqualToAnchor:to.trailingAnchor constant:8],
    [self.flowScroll.trailingAnchor constraintEqualToAnchor:toBar.trailingAnchor constant:-16],
    [self.flowScroll.topAnchor constraintEqualToAnchor:toBar.topAnchor constant:10],
    [self.flowScroll.bottomAnchor constraintEqualToAnchor:toBar.bottomAnchor constant:-10],
    self.flowHeight,
    [self.flow.leadingAnchor constraintEqualToAnchor:self.flowScroll.contentLayoutGuide.leadingAnchor],
    [self.flow.trailingAnchor constraintEqualToAnchor:self.flowScroll.contentLayoutGuide.trailingAnchor],
    [self.flow.topAnchor constraintEqualToAnchor:self.flowScroll.contentLayoutGuide.topAnchor],
    [self.flow.bottomAnchor constraintEqualToAnchor:self.flowScroll.contentLayoutGuide.bottomAnchor],
    [self.flow.widthAnchor constraintEqualToAnchor:self.flowScroll.frameLayoutGuide.widthAnchor],
    [self.menu.topAnchor constraintEqualToAnchor:toBar.bottomAnchor constant:10],
    [self.menu.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:12],
    [self.menu.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
    menuBottom,
    [menuScroll.leadingAnchor constraintEqualToAnchor:self.menu.leadingAnchor],
    [menuScroll.trailingAnchor constraintEqualToAnchor:self.menu.trailingAnchor],
    [menuScroll.topAnchor constraintEqualToAnchor:self.menu.topAnchor],
    [menuScroll.bottomAnchor constraintEqualToAnchor:self.menu.bottomAnchor],
    menuHeight,
    [self.menuList.leadingAnchor constraintEqualToAnchor:menuScroll.contentLayoutGuide.leadingAnchor constant:6],
    [self.menuList.trailingAnchor constraintEqualToAnchor:menuScroll.contentLayoutGuide.trailingAnchor constant:-6],
    [self.menuList.topAnchor constraintEqualToAnchor:menuScroll.contentLayoutGuide.topAnchor constant:6],
    [self.menuList.bottomAnchor constraintEqualToAnchor:menuScroll.contentLayoutGuide.bottomAnchor constant:-6],
    [self.menuList.widthAnchor constraintEqualToAnchor:menuScroll.frameLayoutGuide.widthAnchor constant:-12],
    [self.banner.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:12],
    [self.banner.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
    [self.banner.bottomAnchor constraintEqualToAnchor:composerBox.topAnchor constant:-10],
    [bannerStack.leadingAnchor constraintEqualToAnchor:self.banner.leadingAnchor constant:14],
    [bannerStack.trailingAnchor constraintEqualToAnchor:self.banner.trailingAnchor constant:-14],
    [bannerStack.topAnchor constraintEqualToAnchor:self.banner.topAnchor constant:12],
    [bannerStack.bottomAnchor constraintEqualToAnchor:self.banner.bottomAnchor constant:-12],
    [composerBox.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:12],
    [composerBox.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-12],
    [composerBox.bottomAnchor constraintEqualToAnchor:self.view.keyboardLayoutGuide.topAnchor constant:-10],
    [self.composer.leadingAnchor constraintEqualToAnchor:composerBox.leadingAnchor constant:12],
    [self.composer.topAnchor constraintEqualToAnchor:composerBox.topAnchor],
    [self.composer.bottomAnchor constraintEqualToAnchor:composerBox.bottomAnchor],
    [self.composer.heightAnchor constraintLessThanOrEqualToConstant:140],
    [self.composer.trailingAnchor constraintEqualToAnchor:self.sendButton.leadingAnchor constant:-6],
    [self.composerPlaceholder.leadingAnchor constraintEqualToAnchor:self.composer.leadingAnchor constant:7],
    [self.composerPlaceholder.trailingAnchor constraintEqualToAnchor:self.composer.trailingAnchor],
    [self.composerPlaceholder.topAnchor constraintEqualToAnchor:self.composer.topAnchor constant:11],
    [self.sendButton.trailingAnchor constraintEqualToAnchor:composerBox.trailingAnchor constant:-6],
    [self.sendButton.bottomAnchor constraintEqualToAnchor:composerBox.bottomAnchor constant:-6],
    [self.sendButton.widthAnchor constraintEqualToConstant:32],
    [self.sendButton.heightAnchor constraintEqualToConstant:32],
  ]];
  [self renderAll];
  [self load];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  if (!self.recipients.count) [self.search becomeFirstResponder];
}

- (void)traitCollectionDidChange:(UITraitCollection *)previous {
  [super traitCollectionDidChange:previous];
  self.banner.layer.borderColor = RBThemeDanger().CGColor;
  self.menu.layer.borderColor = RBThemeBorder().CGColor;
  [self renderAll];
}

- (void)close {
  [self.view endEditing:YES];
  if (self.navigationController.viewControllers.firstObject == self || !self.navigationController)
    [self dismissViewControllerAnimated:YES completion:nil];
  else
    [self.navigationController popViewControllerAnimated:YES];
}

- (void)load {
  self.loading = YES;
  self.loadError = nil;
  [self renderMenu];
  RBHostRequest(@"POST", @"/api/listAgents", @{}, 20, ^(NSInteger status, id json, NSError *error) {
    self.loading = NO;
    if (status < 200 || status >= 300) {
      self.loadError = [RBL(@"加载 Bot 列表失败：", @"Failed to load Bots: ") stringByAppendingString:RBHostErrorMessage(json, error, status)];
    } else {
      self.eligible = RBGroupEligibleBots(json);
    }
    [self renderMenu];
  });
  RBHostRequest(@"GET", @"/local/profile", nil, 10, ^(NSInteger status, id json, NSError *error) {
    if (status == 200 && [json isKindOfClass:NSDictionary.class]) {
      NSString *name = [json[@"displayName"] isKindOfClass:NSString.class] ? json[@"displayName"] : @"";
      self.accountName = [name stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    }
  });
}

- (void)renderAll {
  [self renderChips];
  [self renderMenu];
  [self renderComposer];
}

- (UIView *)chipFor:(NSDictionary *)recipient index:(NSUInteger)index {
  UIView *chip = [UIView new];
  chip.backgroundColor = RBThemeSecondaryFill();
  chip.layer.cornerRadius = 15;
  BOOL isNew = [recipient[@"isNewBot"] boolValue];
  UIView *avatar = RBGroupAvatarView(recipient, 20, isNew);
  UILabel *name = [self label:recipient[@"name"] size:13 weight:UIFontWeightMedium color:RBThemeTextPrimary()];
  name.lineBreakMode = NSLineBreakByTruncatingTail;
  UIButton *remove = [UIButton buttonWithType:UIButtonTypeSystem];
  [remove setImage:RBGlyphImage(RBGlyphClose, 14, 1.6) forState:UIControlStateNormal];
  remove.tintColor = RBThemeTextSecondary();
  remove.accessibilityLabel = [RBL(@"移除 ", @"Remove ") stringByAppendingString:recipient[@"name"]];
  [remove.widthAnchor constraintEqualToConstant:20].active = YES;
  [remove.heightAnchor constraintEqualToConstant:20].active = YES;
  __weak typeof(self) weak = self;
  [remove addAction:[UIAction actionWithHandler:^(UIAction *a) { [weak removeRecipientAt:index]; }]
     forControlEvents:UIControlEventTouchUpInside];
  remove.enabled = !self.submitting;
  UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[avatar, name, remove]];
  row.alignment = UIStackViewAlignmentCenter;
  row.spacing = 6;
  row.translatesAutoresizingMaskIntoConstraints = NO;
  [chip addSubview:row];
  [NSLayoutConstraint activateConstraints:@[
    [row.leadingAnchor constraintEqualToAnchor:chip.leadingAnchor constant:5],
    [row.trailingAnchor constraintEqualToAnchor:chip.trailingAnchor constant:-5],
    [row.topAnchor constraintEqualToAnchor:chip.topAnchor constant:5],
    [row.bottomAnchor constraintEqualToAnchor:chip.bottomAnchor constant:-5],
  ]];
  chip.accessibilityIdentifier = @"rokbot.group.chip";
  return chip;
}

- (void)renderChips {
  for (UIView *view in self.flow.subviews) [view removeFromSuperview];
  for (NSUInteger i = 0; i < self.recipients.count; i++) [self.flow addSubview:[self chipFor:self.recipients[i] index:i]];
  BOOL atLimit = self.recipients.count >= RBGroupMaxBots;
  self.search.placeholder = atLimit ? RBL(@"已达人数上限（6）", @"Maximum 6 Bots reached")
                                    : (self.recipients.count ? RBL(@"继续添加 Bot…", @"Add another Bot…")
                                                             : RBL(@"搜索 Bot 或输入新 Bot 名称…", @"Start a chat with…"));
  self.search.enabled = !atLimit && !self.submitting;
  [self.flow addSubview:self.search];
  [self.flow setNeedsLayout];
  CGFloat width = self.flowScroll.bounds.size.width > 0 ? self.flowScroll.bounds.size.width : self.view.bounds.size.width - 110;
  CGFloat height = [self.flow layoutFor:width apply:NO].height;
  self.flowHeight.constant = MIN(124, MAX(30, height));
  self.flowScroll.scrollEnabled = height > 124;
  self.countLabel.text = [NSString stringWithFormat:@"%lu/%lu", (unsigned long)self.recipients.count, (unsigned long)RBGroupMaxBots];
  self.countLabel.accessibilityLabel = [NSString stringWithFormat:RBL(@"已选 %lu 个，最多 %lu 个", @"%lu of %lu selected"),
                                        (unsigned long)self.recipients.count, (unsigned long)RBGroupMaxBots];
  [self updateActions];
}

- (UIControl *)menuRowTitle:(NSString *)title subtitle:(NSString *)subtitle avatar:(UIView *)avatar
                 identifier:(NSString *)identifier action:(void (^)(void))action {
  UIControl *row = [UIControl new];
  row.layer.cornerRadius = 8;
  row.isAccessibilityElement = YES;
  row.accessibilityLabel = subtitle.length ? [NSString stringWithFormat:@"%@, %@", title, subtitle] : title;
  row.accessibilityTraits = UIAccessibilityTraitButton;
  row.accessibilityIdentifier = identifier;
  [row.heightAnchor constraintGreaterThanOrEqualToConstant:48].active = YES;
  UILabel *t = [self label:title size:14.5 weight:UIFontWeightMedium color:RBThemeTextPrimary()];
  t.numberOfLines = 1;
  UIStackView *texts = [[UIStackView alloc] initWithArrangedSubviews:@[t]];
  texts.axis = UILayoutConstraintAxisVertical;
  texts.spacing = 1;
  if (subtitle.length) {
    UILabel *s = [self label:subtitle size:12.5 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
    s.numberOfLines = 1;
    [texts addArrangedSubview:s];
  }
  UIStackView *line = [[UIStackView alloc] initWithArrangedSubviews:@[avatar, texts]];
  line.alignment = UIStackViewAlignmentCenter;
  line.spacing = 10;
  line.userInteractionEnabled = NO;
  line.translatesAutoresizingMaskIntoConstraints = NO;
  [row addSubview:line];
  [NSLayoutConstraint activateConstraints:@[
    [line.leadingAnchor constraintEqualToAnchor:row.leadingAnchor constant:10],
    [line.trailingAnchor constraintEqualToAnchor:row.trailingAnchor constant:-10],
    [line.topAnchor constraintEqualToAnchor:row.topAnchor constant:8],
    [line.bottomAnchor constraintEqualToAnchor:row.bottomAnchor constant:-8],
  ]];
  [row addAction:[UIAction actionWithHandler:^(UIAction *a) { row.backgroundColor = RBThemeHover(); }]
      forControlEvents:UIControlEventTouchDown | UIControlEventTouchDragEnter];
  [row addAction:[UIAction actionWithHandler:^(UIAction *a) { row.backgroundColor = UIColor.clearColor; }]
      forControlEvents:UIControlEventTouchUpOutside | UIControlEventTouchCancel | UIControlEventTouchDragExit];
  [row addAction:[UIAction actionWithHandler:^(UIAction *a) {
    row.backgroundColor = UIColor.clearColor;
    action();
  }] forControlEvents:UIControlEventTouchUpInside];
  row.enabled = !self.submitting;
  return row;
}

- (void)menuMessage:(NSString *)text color:(UIColor *)color {
  UILabel *label = [self label:text size:13 weight:UIFontWeightRegular color:color];
  label.numberOfLines = 0;
  label.textAlignment = NSTextAlignmentCenter;
  UIView *wrap = [UIView new];
  label.translatesAutoresizingMaskIntoConstraints = NO;
  [wrap addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.leadingAnchor constraintEqualToAnchor:wrap.leadingAnchor constant:10],
    [label.trailingAnchor constraintEqualToAnchor:wrap.trailingAnchor constant:-10],
    [label.topAnchor constraintEqualToAnchor:wrap.topAnchor constant:14],
    [label.bottomAnchor constraintEqualToAnchor:wrap.bottomAnchor constant:-14],
  ]];
  [self.menuList addArrangedSubview:wrap];
}

- (void)renderMenu {
  for (UIView *view in self.menuList.arrangedSubviews) [view removeFromSuperview];
  __weak typeof(self) weak = self;
  NSString *query = self.search.text ?: @"";
  if (self.recipients.count >= RBGroupMaxBots) {
    [self menuMessage:RBL(@"群聊最多可添加 6 个 Bot", @"Group chats support up to 6 Bots") color:RBThemeTextSecondary()];
    return;
  }
  if (RBGroupCanOfferNewBot(self.eligible, self.recipients, query)) {
    NSString *name = RBGroupNormalizeName(query);
    NSString *title = [NSString stringWithFormat:RBL(@"将“%@”添加为新 Bot", @"Add “%@” as a new Bot"), name];
    [self.menuList addArrangedSubview:[self menuRowTitle:title subtitle:nil avatar:RBGroupAvatarView(@{}, 28, YES)
                                              identifier:@"rokbot.group.new-bot"
                                                  action:^{ [weak addRecipient:RBGroupRecipientNewBot(name)]; }]];
  }
  if (self.loading) {
    [self menuMessage:RBL(@"正在加载 Bot…", @"Loading Bots…") color:RBThemeTextSecondary()];
    return;
  }
  if (self.loadError.length) {
    [self menuMessage:self.loadError color:RBThemeDanger()];
    return;
  }
  NSArray<NSDictionary *> *candidates = RBGroupFilterCandidates(self.eligible, self.recipients, query);
  for (NSDictionary *bot in candidates) {
    [self.menuList addArrangedSubview:[self menuRowTitle:bot[@"name"] subtitle:bot[@"subtitle"]
                                                  avatar:RBGroupAvatarView(bot, 28, NO)
                                              identifier:[@"rokbot.group.bot." stringByAppendingString:bot[@"id"]]
                                                  action:^{ [weak addRecipient:RBGroupRecipientFromBot(bot)]; }]];
  }
  if (!candidates.count && !self.menuList.arrangedSubviews.count)
    [self menuMessage:self.eligible.count ? RBL(@"没有匹配的 Bot", @"No matching Bots") : RBL(@"还没有可添加的 Bot，输入名称即可新建", @"No Bots yet. Type a name to create one")
                color:RBThemeTextSecondary()];
}

- (void)renderComposer {
  BOOL zh = RBIsChinese();
  NSString *names = RBGroupComposerNames(self.recipients, zh);
  self.composerPlaceholder.text = names.length ? [NSString stringWithFormat:RBL(@"发消息给 %@", @"Message %@"), names]
                                               : RBL(@"发消息给 Bot", @"Message Bot");
  self.composerPlaceholder.hidden = self.composer.text.length > 0;
  [self updateActions];
}

- (void)updateActions {
  BOOL canSubmit = RBGroupCanSubmit(self.recipients, self.submitting);
  NSString *prompt = [self.composer.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  self.createButton.enabled = canSubmit;
  self.createButton.alpha = canSubmit ? 1 : 0.4;
  RBThemeStyleButton(self.createButton, self.submitting ? RBL(@"创建中…", @"Creating…") : RBL(@"创建", @"Create"), YES);
  BOOL canSend = canSubmit && prompt.length > 0;
  self.sendButton.enabled = canSend;
  self.sendButton.backgroundColor = canSend ? RBThemePrimaryButton() : RBThemeSecondaryFill();
  self.sendButton.tintColor = canSend ? RBThemeOnPrimaryButton() : RBThemeTextMuted();
  self.composer.editable = !self.submitting;
}

- (void)searchChanged {
  [self renderMenu];
}

- (BOOL)textFieldShouldReturn:(UITextField *)textField {
  NSString *query = textField.text ?: @"";
  NSArray<NSDictionary *> *candidates = RBGroupFilterCandidates(self.eligible, self.recipients, query);
  if (RBGroupNormalizeForMatch(query).length && candidates.count &&
      [RBGroupNormalizeForMatch(candidates.firstObject[@"name"]) isEqualToString:RBGroupNormalizeForMatch(query)]) {
    [self addRecipient:RBGroupRecipientFromBot(candidates.firstObject)];
  } else if (RBGroupCanOfferNewBot(self.eligible, self.recipients, query)) {
    [self addRecipient:RBGroupRecipientNewBot(query)];
  } else {
    [self.composer becomeFirstResponder];
  }
  return NO;
}

- (BOOL)textField:(UITextField *)textField shouldChangeCharactersInRange:(NSRange)range replacementString:(NSString *)string {
  if (!string.length && range.location == 0 && range.length == 0 && !textField.text.length && self.recipients.count) {
    [self removeRecipientAt:self.recipients.count - 1];
    return NO;
  }
  return YES;
}

- (void)textViewDidChange:(UITextView *)textView {
  [self renderComposer];
  BOOL tall = [textView sizeThatFits:CGSizeMake(textView.bounds.size.width, CGFLOAT_MAX)].height > 140;
  if (textView.scrollEnabled != tall) textView.scrollEnabled = tall;
}

- (void)addRecipient:(NSDictionary *)recipient {
  if (self.submitting || !RBGroupCanAddRecipient(self.recipients, recipient)) return;
  [self.recipients addObject:recipient];
  self.search.text = @"";
  [self hideBanner];
  [self renderAll];
  UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification,
                                  [NSString stringWithFormat:RBL(@"已添加 %@", @"Added %@"), recipient[@"name"]]);
  if (self.recipients.count >= RBGroupMaxBots) [self.composer becomeFirstResponder];
}

- (void)removeRecipientAt:(NSUInteger)index {
  if (self.submitting || index >= self.recipients.count) return;
  [self.recipients removeObjectAtIndex:index];
  [self renderAll];
}

- (void)showBanner:(NSString *)message retry:(BOOL)retry {
  self.bannerText.text = message;
  self.bannerRetry.hidden = !retry;
  self.banner.hidden = NO;
  UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification, message);
}

- (void)hideBanner {
  self.banner.hidden = YES;
}

- (void)createTapped { [self submit:NO]; }
- (void)sendTapped { [self submit:YES]; }
- (void)retryTapped { [self submit:self.lastSubmitHadPrompt]; }

- (void)rollback:(NSArray<NSString *> *)ids completion:(void (^)(BOOL clean))completion {
  if (!ids.count) {
    completion(YES);
    return;
  }
  RBHostRequest(@"POST", @"/api/deleteAgents", @{ @"ids" : ids }, 30, ^(NSInteger status, id json, NSError *error) {
    NSUInteger stuck = 0;
    if ([json isKindOfClass:NSDictionary.class]) {
      for (NSString *key in @[@"refusedAgentIds", @"failedAgentIds"])
        if ([json[key] isKindOfClass:NSArray.class]) stuck += [json[key] count];
    }
    completion(status >= 200 && status < 300 && stuck == 0);
  });
}

- (void)failWithDetail:(NSString *)detail created:(NSArray<NSString *> *)created {
  [self rollback:created completion:^(BOOL clean) {
    self.submitting = NO;
    [self renderAll];
    NSString *base = clean
        ? RBL(@"无法创建群组。你的草稿和收件人已保存。请检查收件人后重试。",
              @"The group could not be created. Your draft and recipients are saved. Review the recipients and try again.")
        : RBL(@"无法创建群组，且部分新 Bot 无法移除。你的草稿已保存。请先检查聊天，再创建其他群组。",
              @"The group could not be created, and some new Bots could not be removed. Your draft is saved. Check your chats before creating another group.");
    [self showBanner:detail.length ? [NSString stringWithFormat:@"%@\n%@", base, detail] : base retry:clean];
  }];
}

- (void)submit:(BOOL)withPrompt {
  if (!RBGroupCanSubmit(self.recipients, self.submitting)) return;
  NSString *prompt = [self.composer.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (withPrompt && !prompt.length) return;
  NSArray<NSDictionary *> *snapshot = [self.recipients copy];
  NSString *groupName = RBGroupAutoName(snapshot, self.accountName, RBIsChinese());
  self.submitting = YES;
  self.lastSubmitHadPrompt = withPrompt;
  [self hideBanner];
  [self.view endEditing:YES];
  [self renderAll];
  [self createStep:0 snapshot:snapshot members:[NSMutableArray array] created:[NSMutableArray array]
                name:groupName prompt:withPrompt ? prompt : nil];
}

- (void)createStep:(NSUInteger)index snapshot:(NSArray<NSDictionary *> *)snapshot members:(NSMutableArray<NSString *> *)members
           created:(NSMutableArray<NSString *> *)created name:(NSString *)groupName prompt:(NSString *)prompt {
  if (index < snapshot.count) {
    NSDictionary *recipient = snapshot[index];
    if (![recipient[@"isNewBot"] boolValue]) {
      [members addObject:recipient[@"id"]];
      [self createStep:index + 1 snapshot:snapshot members:members created:created name:groupName prompt:prompt];
      return;
    }
    RBHostRequest(@"POST", @"/api/createAgent", @{ @"name" : recipient[@"name"], @"description" : @"" }, 30,
                  ^(NSInteger status, id json, NSError *error) {
                    NSString *newId = status >= 200 && status < 300 ? RBGroupCreatedId(json) : @"";
                    if (!newId.length) {
                      [self failWithDetail:RBHostErrorMessage(json, error, status) created:created];
                      return;
                    }
                    [members addObject:newId];
                    [created addObject:newId];
                    [self createStep:index + 1 snapshot:snapshot members:members created:created name:groupName prompt:prompt];
                  });
    return;
  }
  RBHostRequest(@"POST", @"/api/createGroup", RBGroupCreateBody(groupName, members), 30,
                ^(NSInteger status, id json, NSError *error) {
                  NSString *groupId = status >= 200 && status < 300 ? RBGroupCreatedId(json) : @"";
                  if (!groupId.length) {
                    [self failWithDetail:RBHostErrorMessage(json, error, status) created:created];
                    return;
                  }
                  void (^finish)(void) = ^{
                    self.submitting = NO;
                    UIViewController *presenter = self.navigationController.presentingViewController ?: self.presentingViewController;
                    void (^open)(void) = ^{ RBOpenAgent(groupId); };
                    if (presenter) [presenter dismissViewControllerAnimated:YES completion:open];
                    else open();
                  };
                  if (!prompt.length) {
                    finish();
                    return;
                  }
                  // Same as Desktop intent "send": the group exists even if the first message fails.
                  RBHostRequest(@"POST", @"/api/sendPrompt", @{
                    @"agentId" : groupId,
                    @"clientNonce" : NSUUID.UUID.UUIDString.lowercaseString,
                    @"prompt" : prompt,
                    @"directAddressedAcceptance" : @YES,
                  }, 30, ^(NSInteger s, id j, NSError *e) { finish(); });
                });
}

@end

void RBShowCreateGroupFrom(UIViewController *presenter) {
  if (!RBConnection.shared.isPaired) {
    [RBConnection.shared show];
    return;
  }
  RBGroupCreateController *controller = [RBGroupCreateController new];
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:controller];
  nav.navigationBarHidden = YES;
  nav.modalPresentationStyle = UIModalPresentationFullScreen;
  UIViewController *top = presenter ?: RBTopController();
  while (top.presentedViewController && !top.presentedViewController.isBeingDismissed) top = top.presentedViewController;
  [top presentViewController:nav animated:YES completion:nil];
}

void RBShowNewChatChooser(UIViewController *presenter, void (^newBot)(void)) {
  NSArray<RBChoiceOption *> *options = @[
    [RBChoiceOption optionWithValue:@"bot" title:RBL(@"新建 Bot", @"New Bot")
                           subtitle:RBL(@"创建一个新的 Bot 并开始对话", @"Create a Bot and start chatting")],
    [RBChoiceOption optionWithValue:@"group" title:RBL(@"新建群聊", @"New Group Chat")
                           subtitle:RBL(@"选择最多 6 个 Bot 在同一个群聊里协作", @"Bring up to 6 Bots into one chat")],
  ];
  UIViewController *top = presenter ?: RBTopController();
  RBChoiceSheet *sheet = [RBChoiceSheet sheetWithTitle:RBL(@"新建", @"New")
                                               message:nil
                                               options:options
                                              selected:nil
                                              onSelect:^(RBChoiceOption *option) {
                                                if ([option.value isEqualToString:@"group"]) RBShowCreateGroupFrom(top);
                                                else if (newBot) newBot();
                                              }];
  [sheet presentFrom:top];
}

@interface RBNewChatEntry : NSObject
@end
@implementation RBNewChatEntry
+ (void)open {
  RBShowNewChatChooser(RBTopController(), ^{ RBOpenAppRoute(@"new-chat"); });
}
@end

BOOL RBReplaceNewChatView(UIView *view, NSString *label) {
  CGSize size = view.bounds.size;
  if (!RBConnection.shared.isPaired || !RBGroupIsNewChatLabel(label) || size.width < 24 || size.height < 24 ||
      size.width > 72 || size.height > 72)
    return NO;
  if (RBHasAncestorPluginTag(view, 731995)) return NO;
  RBRemoveDescendantPluginTag(view, 731995);
  UIButton *button = (UIButton *)[view viewWithTag:731995];
  if (button && button.superview != view) button = nil;
  if (!button) {
    button = [UIButton buttonWithType:UIButtonTypeCustom];
    button.tag = 731995;
    button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    button.accessibilityIdentifier = @"rokbot.new-chat";
    [button addTarget:RBNewChatEntry.class action:@selector(open) forControlEvents:UIControlEventTouchUpInside];
    if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
    [view addSubview:button];
    RBTrackModifiedView(view);
  }
  if (!CGRectEqualToRect(button.frame, view.bounds)) button.frame = view.bounds;
  NSString *localized = RBL(@"新建", @"New");
  if (![button.accessibilityLabel isEqualToString:localized]) button.accessibilityLabel = localized;
  return YES;
}

#endif // TARGET_OS_IOS
