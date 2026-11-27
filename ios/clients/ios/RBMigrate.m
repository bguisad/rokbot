#import "RBMigrate.h"
#import <TargetConditionals.h>

// "Migrate from Grok Bot" on iOS. Physical migration of a Grok Bot data folder runs on the desktop
// clients and the Host web page; here the user copies the migration prompt (with a one-time upload
// URL), sees what Bots uploaded and confirms the import. No emoji; choices use RBChoiceSheet.

NSString *RBMigrateCountsLine(NSDictionary *counts, BOOL chinese) {
  if (![counts isKindOfClass:NSDictionary.class]) return @"";
  NSArray *keys = @[ @[ @"bots", @"个 Bot", @" Bots" ], @[ @"memory", @"条记忆", @" memories" ], @[ @"skills", @"个技能", @" skills" ],
                     @[ @"routines", @"个例程", @" routines" ], @[ @"files", @"个文件", @" files" ], @[ @"chatMessages", @"条聊天记录", @" messages" ] ];
  NSMutableArray *parts = [NSMutableArray array];
  for (NSArray *key in keys) {
    NSInteger value = [counts[key[0]] respondsToSelector:@selector(integerValue)] ? [counts[key[0]] integerValue] : 0;
    if (value > 0) [parts addObject:chinese ? [NSString stringWithFormat:@"%ld %@", (long)value, key[1]] : [NSString stringWithFormat:@"%ld%@", (long)value, key[2]]];
  }
  if (!parts.count) return chinese ? @"没有可导入的内容" : @"Nothing to import";
  return [parts componentsJoinedByString:@" · "];
}

NSDictionary *RBMigrateSelection(NSArray<NSDictionary *> *bots, NSSet<NSString *> *excluded, NSDictionary<NSString *, NSString *> *policies, BOOL includeChat) {
  NSMutableDictionary *chosen = [NSMutableDictionary dictionary];
  NSSet *allowed = [NSSet setWithArray:@[ @"rename", @"skip", @"overwrite" ]];
  for (NSDictionary *bot in bots) {
    NSString *key = [bot[@"key"] isKindOfClass:NSString.class] ? bot[@"key"] : nil;
    if (!key.length) continue;
    NSString *policy = [allowed containsObject:policies[key] ?: @""] ? policies[key] : @"rename";
    chosen[key] = @{ @"include" : @(![excluded containsObject:key]), @"conflict" : policy, @"chat" : @(includeChat) };
  }
  return @{ @"bots" : chosen };
}

#if TARGET_OS_IOS

#import <UIKit/UIKit.h>
#import "RBChoiceSheet.h"
#import "RBHostAPI.h"
#import "RBLocalize.h"
#import "RBTheme.h"

@interface RBMigrateController : UIViewController
@property(nonatomic, strong) UIStackView *stack;
@property(nonatomic, strong) UIStackView *tokens;
@property(nonatomic, strong) UIStackView *packages;
@property(nonatomic, strong) UIStackView *review;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, strong) UIButton *scopeButton;
@property(nonatomic, copy) NSString *scope;
@property(nonatomic, strong) NSMutableSet<NSString *> *excluded;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *policies;
@property(nonatomic, assign) BOOL includeChat;
@property(nonatomic, copy) NSDictionary *preview;
@end

@implementation RBMigrateController

- (BOOL)chinese { return [RBL(@"zh", @"en") isEqualToString:@"zh"]; }

- (UILabel *)label:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight color:(UIColor *)color {
  UILabel *label = [UILabel new];
  label.text = text;
  label.font = RBThemeFont(size, weight);
  label.textColor = color;
  label.numberOfLines = 0;
  label.adjustsFontForContentSizeCategory = YES;
  return label;
}

- (UIView *)header:(NSString *)text {
  UILabel *label = [self label:text size:13 weight:UIFontWeightSemibold color:RBThemeTextSecondary()];
  label.accessibilityTraits = UIAccessibilityTraitHeader;
  return label;
}

- (UIButton *)button:(NSString *)title primary:(BOOL)primary action:(SEL)action {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(button, title, primary);
  [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
  return button;
}

- (UIStackView *)rowStack {
  UIStackView *row = [UIStackView new];
  row.axis = UILayoutConstraintAxisVertical;
  row.spacing = 6;
  row.layoutMargins = UIEdgeInsetsMake(14, 16, 14, 16);
  row.layoutMarginsRelativeArrangement = YES;
  return row;
}

- (UIView *)card:(UIStackView *)content {
  UIView *card = RBThemeCard(16);
  content.translatesAutoresizingMaskIntoConstraints = NO;
  [card addSubview:content];
  [NSLayoutConstraint activateConstraints:@[
    [content.leadingAnchor constraintEqualToAnchor:card.leadingAnchor], [content.trailingAnchor constraintEqualToAnchor:card.trailingAnchor],
    [content.topAnchor constraintEqualToAnchor:card.topAnchor], [content.bottomAnchor constraintEqualToAnchor:card.bottomAnchor],
  ]];
  return card;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"从 Grok Bot 迁移", @"Migrate from Grok Bot");
  self.view.backgroundColor = RBThemeChrome();
  self.scope = @"single";
  self.excluded = [NSMutableSet set];
  self.policies = [NSMutableDictionary dictionary];
  if (self.navigationController.viewControllers.firstObject == self) {
    UIBarButtonItem *close = [[UIBarButtonItem alloc] initWithImage:RBGlyphImage(RBGlyphClose, 22, 2) style:UIBarButtonItemStylePlain target:self action:@selector(close)];
    close.accessibilityLabel = RBL(@"关闭", @"Close");
    self.navigationItem.leftBarButtonItem = close;
  }
  UIScrollView *scroll = [UIScrollView new];
  scroll.translatesAutoresizingMaskIntoConstraints = NO;
  scroll.alwaysBounceVertical = YES;
  [self.view addSubview:scroll];
  self.stack = [UIStackView new];
  self.stack.axis = UILayoutConstraintAxisVertical;
  self.stack.spacing = 10;
  self.stack.translatesAutoresizingMaskIntoConstraints = NO;
  [scroll addSubview:self.stack];
  [NSLayoutConstraint activateConstraints:@[
    [scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor], [scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [scroll.topAnchor constraintEqualToAnchor:self.view.topAnchor], [scroll.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [self.stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:16],
    [self.stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-16],
    [self.stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:16],
    [self.stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-28],
    [self.stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-32],
  ]];
  [self.stack addArrangedSubview:[self label:RBL(@"把迁移 prompt 发给 Grok Bot 里的 Bot，它会把档案、记忆、技能、例程和参考资料整理成文件上传到你的 Host，然后在下方预览并确认导入。读取电脑上的 Grok Bot 数据目录请使用桌面客户端或 Host 网页。",
                                                 @"Send the migration prompt to your Grok Bot Bots. They upload their profile, memories, skills, routines and files to your Host; review and import them below. To read a Grok Bot data folder on a computer, use the desktop client or the Host web page.")
                                            size:13 weight:UIFontWeightRegular color:RBThemeTextSecondary()]];
  self.status = [self label:@"" size:12.5 weight:UIFontWeightRegular color:RBThemeDanger()];
  self.status.hidden = YES;
  [self.stack addArrangedSubview:self.status];

  [self.stack addArrangedSubview:[self header:RBL(@"迁移 prompt", @"Migration prompt")]];
  UIStackView *prompt = [self rowStack];
  self.scopeButton = [self button:@"" primary:NO action:@selector(chooseScope)];
  [self updateScopeTitle];
  [prompt addArrangedSubview:self.scopeButton];
  UIButton *create = [self button:RBL(@"生成上传地址并复制 prompt", @"Create URL & copy prompt") primary:YES action:@selector(createToken)];
  create.accessibilityIdentifier = @"rokbot.migrate.copyPrompt";
  [prompt addArrangedSubview:create];
  [prompt addArrangedSubview:[self button:RBL(@"只复制 prompt（不带上传地址）", @"Copy prompt only") primary:NO action:@selector(copyOffline)]];
  [prompt addArrangedSubview:[self label:RBL(@"上传地址 24 小时内有效、可多次上传、可随时撤销。Bot 无法访问地址时，会把文件发给你，再到 Host 网页上传。",
                                             @"Upload URLs last 24 hours, accept several uploads and can be revoked. If a Bot cannot reach the URL it sends you the file to upload on the Host web page.")
                                     size:12 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
  [self.stack addArrangedSubview:[self card:prompt]];

  [self.stack addArrangedSubview:[self header:RBL(@"上传地址", @"Upload URLs")]];
  self.tokens = [UIStackView new];
  self.tokens.axis = UILayoutConstraintAxisVertical;
  [self.stack addArrangedSubview:[self card:self.tokens]];
  [self.stack addArrangedSubview:[self header:RBL(@"待导入", @"Pending")]];
  self.packages = [UIStackView new];
  self.packages.axis = UILayoutConstraintAxisVertical;
  self.packages.accessibilityIdentifier = @"rokbot.migrate.pending";
  [self.stack addArrangedSubview:[self card:self.packages]];
  self.review = [UIStackView new];
  self.review.axis = UILayoutConstraintAxisVertical;
  self.review.spacing = 10;
  [self.stack addArrangedSubview:self.review];
  [self refresh];
}

- (void)close { [self dismissViewControllerAnimated:YES completion:nil]; }

- (void)fail:(id)json error:(NSError *)error status:(NSInteger)status {
  self.status.text = RBHostErrorMessage(json, error, status);
  self.status.hidden = NO;
}

- (void)copyText:(NSString *)text {
  UIPasteboard.generalPasteboard.string = text ?: @"";
  self.status.hidden = YES;
  UIAlertController *done = [UIAlertController alertControllerWithTitle:RBL(@"已复制迁移 prompt", @"Migration prompt copied")
                                                                message:RBL(@"发给 Grok Bot 即可，上传后会出现在「待导入」。", @"Send it to Grok Bot; uploads appear under Pending.")
                                                         preferredStyle:UIAlertControllerStyleAlert];
  [done addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK") style:UIAlertActionStyleDefault handler:nil]];
  [self presentViewController:done animated:YES completion:nil];
}

- (void)updateScopeTitle {
  NSString *title = [self.scope isEqualToString:@"all"] ? RBL(@"导出范围：所有 Bot", @"Scope: all Bots") : RBL(@"导出范围：当前 Bot", @"Scope: this Bot");
  RBThemeStyleButton(self.scopeButton, title, NO);
}

- (void)chooseScope {
  NSArray *options = @[ [RBChoiceOption optionWithValue:@"single" title:RBL(@"当前 Bot", @"This Bot") subtitle:RBL(@"发给每个 Bot，各自导出自己", @"Send to each Bot")],
                        [RBChoiceOption optionWithValue:@"all" title:RBL(@"所有 Bot", @"All Bots") subtitle:RBL(@"发给一个能看到所有 Bot 的总管 Bot", @"Send to one coordinating Bot")] ];
  __weak typeof(self) weak = self;
  [[RBChoiceSheet sheetWithTitle:RBL(@"导出范围", @"Scope") message:nil options:options selected:self.scope onSelect:^(RBChoiceOption *option) {
    weak.scope = option.value;
    [weak updateScopeTitle];
  }] presentFrom:self];
}

- (void)createToken {
  NSDictionary *body = @{ @"label" : [self.scope isEqualToString:@"all"] ? RBL(@"所有 Bot", @"All Bots") : RBL(@"单个 Bot", @"One Bot"), @"scope" : self.scope };
  RBHostRequest(@"POST", @"/local/migrate/tokens", body, 15, ^(NSInteger status, id json, NSError *error) {
    if (status != 201 && status != 200) { [self fail:json error:error status:status]; return; }
    [self copyText:json[@"prompt"]];
    [self refresh];
  });
}

- (void)copyOffline {
  NSString *path = [@"/local/migrate/prompt?scope=" stringByAppendingString:RBHostPathSegment(self.scope)];
  RBHostRequest(@"GET", path, nil, 15, ^(NSInteger status, id json, NSError *error) {
    if (status != 200) { [self fail:json error:error status:status]; return; }
    [self copyText:json[@"prompt"]];
  });
}

- (void)refresh {
  RBHostRequest(@"GET", @"/local/migrate", nil, 15, ^(NSInteger status, id json, NSError *error) {
    if (status != 200 || ![json isKindOfClass:NSDictionary.class]) { [self fail:json error:error status:status]; return; }
    self.status.hidden = YES;
    [self renderTokens:json[@"tokens"]];
    [self renderPackages:json[@"packages"]];
  });
}

- (void)clear:(UIStackView *)stack {
  for (UIView *view in stack.arrangedSubviews.copy) { [stack removeArrangedSubview:view]; [view removeFromSuperview]; }
}

- (NSString *)when:(id)value {
  if (![value respondsToSelector:@selector(doubleValue)] || [value doubleValue] <= 0) return @"";
  NSDateFormatter *format = [NSDateFormatter new];
  format.dateFormat = @"MM-dd HH:mm";
  return [format stringFromDate:[NSDate dateWithTimeIntervalSince1970:[value doubleValue] / 1000.0]];
}

- (void)renderTokens:(NSArray *)tokens {
  [self clear:self.tokens];
  NSUInteger shown = 0;
  for (NSDictionary *token in [tokens isKindOfClass:NSArray.class] ? tokens : @[]) {
    if (![token isKindOfClass:NSDictionary.class] || shown >= 6) continue;
    shown++;
    BOOL active = [token[@"active"] boolValue];
    UIStackView *row = [self rowStack];
    NSString *state = active ? RBL(@"有效", @"Active") : (token[@"revokedAt"] == NSNull.null ? RBL(@"已过期", @"Expired") : RBL(@"已撤销", @"Revoked"));
    [row addArrangedSubview:[self label:[NSString stringWithFormat:@"%@ · %@", token[@"label"] ?: @"", state] size:15 weight:UIFontWeightMedium color:active ? RBThemeTextPrimary() : RBThemeTextMuted()]];
    NSString *meta = [NSString stringWithFormat:@"%@%@ · %@%@", active ? RBL(@"有效期至 ", @"Expires ") : RBL(@"创建于 ", @"Created "),
                      [self when:active ? token[@"expiresAt"] : token[@"createdAt"]], RBL(@"已上传 ", @"uploads: "), token[@"uploads"] ?: @0];
    [row addArrangedSubview:[self label:meta size:12 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
    if (active) {
      NSString *tokenId = token[@"id"];
      UIStackView *line = [UIStackView new];
      line.spacing = 8;
      line.distribution = UIStackViewDistributionFillEqually;
      UIButton *copy = [UIButton buttonWithType:UIButtonTypeSystem];
      RBThemeStyleButton(copy, RBL(@"复制 prompt", @"Copy prompt"), NO);
      [copy addAction:[UIAction actionWithHandler:^(__kindof UIAction *action) {
        NSString *path = [NSString stringWithFormat:@"/local/migrate/prompt?scope=%@&tokenId=%@", RBHostPathSegment(self.scope), RBHostPathSegment(tokenId)];
        RBHostRequest(@"GET", path, nil, 15, ^(NSInteger status, id json, NSError *error) {
          if (status != 200) { [self fail:json error:error status:status]; return; }
          [self copyText:json[@"prompt"]];
        });
      }] forControlEvents:UIControlEventTouchUpInside];
      UIButton *revoke = [UIButton buttonWithType:UIButtonTypeSystem];
      RBThemeStyleButton(revoke, RBL(@"撤销", @"Revoke"), NO);
      [revoke setTitleColor:RBThemeDanger() forState:UIControlStateNormal];
      [revoke addAction:[UIAction actionWithHandler:^(__kindof UIAction *action) {
        RBHostRequest(@"DELETE", [@"/local/migrate/tokens/" stringByAppendingString:RBHostPathSegment(tokenId)], nil, 15, ^(NSInteger status, id json, NSError *error) {
          if (status != 200) { [self fail:json error:error status:status]; return; }
          [self refresh];
        });
      }] forControlEvents:UIControlEventTouchUpInside];
      [line addArrangedSubview:copy];
      [line addArrangedSubview:revoke];
      [row addArrangedSubview:line];
    }
    [self.tokens addArrangedSubview:row];
  }
  if (!shown) {
    UIStackView *row = [self rowStack];
    [row addArrangedSubview:[self label:RBL(@"还没有上传地址。", @"No upload URLs yet.") size:13 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
    [self.tokens addArrangedSubview:row];
  }
}

- (void)renderPackages:(NSArray *)packages {
  [self clear:self.packages];
  NSUInteger shown = 0;
  for (NSDictionary *item in [packages isKindOfClass:NSArray.class] ? packages : @[]) {
    if (![item isKindOfClass:NSDictionary.class]) continue;
    shown++;
    NSString *source = item[@"source"];
    NSString *sourceLabel = [source isEqual:@"inbox"] ? RBL(@"Bot 上传", @"From a Bot") : [source isEqual:@"device"] ? RBL(@"桌面端", @"Desktop") : RBL(@"网页上传", @"Web upload");
    BOOL imported = [item[@"status"] isEqual:@"imported"];
    UIStackView *row = [self rowStack];
    [row addArrangedSubview:[self label:item[@"label"] ?: @"" size:15 weight:UIFontWeightMedium color:RBThemeTextPrimary()]];
    [row addArrangedSubview:[self label:[NSString stringWithFormat:@"%@ · %@ · %@", sourceLabel, imported ? RBL(@"已导入", @"Imported") : RBL(@"待导入", @"Pending"), [self when:item[@"createdAt"]]]
                                   size:12 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
    [row addArrangedSubview:[self label:RBMigrateCountsLine(item[@"counts"], self.chinese) size:12 weight:UIFontWeightRegular color:RBThemeTextSecondary()]];
    NSString *packageId = item[@"id"];
    UIButton *open = [UIButton buttonWithType:UIButtonTypeSystem];
    RBThemeStyleButton(open, imported ? RBL(@"再次导入", @"Import again") : RBL(@"预览并导入", @"Review"), !imported);
    [open addAction:[UIAction actionWithHandler:^(__kindof UIAction *action) {
      RBHostRequest(@"GET", [@"/local/migrate/packages/" stringByAppendingString:RBHostPathSegment(packageId)], nil, 30, ^(NSInteger status, id json, NSError *error) {
        if (status != 200) { [self fail:json error:error status:status]; return; }
        [self showReview:json];
      });
    }] forControlEvents:UIControlEventTouchUpInside];
    [row addArrangedSubview:open];
    [self.packages addArrangedSubview:row];
  }
  if (!shown) {
    UIStackView *row = [self rowStack];
    [row addArrangedSubview:[self label:RBL(@"暂无待导入的迁移包。", @"Nothing waiting to be imported.") size:13 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
    [self.packages addArrangedSubview:row];
  }
}

- (void)showReview:(NSDictionary *)preview {
  self.preview = preview;
  [self.excluded removeAllObjects];
  [self.policies removeAllObjects];
  self.includeChat = NO;
  [self renderReview];
}

- (void)renderReview {
  [self clear:self.review];
  NSDictionary *preview = self.preview;
  [self.review addArrangedSubview:[self header:[RBL(@"预览：", @"Review: ") stringByAppendingString:preview[@"label"] ?: @""]]];
  UIStackView *list = [UIStackView new];
  list.axis = UILayoutConstraintAxisVertical;
  NSArray *bots = [preview[@"bots"] isKindOfClass:NSArray.class] ? preview[@"bots"] : @[];
  for (NSDictionary *bot in bots) {
    NSString *key = bot[@"key"];
    BOOL included = ![self.excluded containsObject:key];
    UIStackView *row = [self rowStack];
    UIButton *toggle = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *config = UIButtonConfiguration.plainButtonConfiguration;
    config.title = bot[@"name"];
    config.image = included ? RBGlyphImage(RBGlyphCheck, 16, 2.2) : nil;
    config.imagePadding = 8;
    config.baseForegroundColor = included ? RBThemeTextPrimary() : RBThemeTextMuted();
    config.contentInsets = NSDirectionalEdgeInsetsZero;
    toggle.configuration = config;
    toggle.contentHorizontalAlignment = UIControlContentHorizontalAlignmentLeading;
    toggle.accessibilityValue = included ? RBL(@"已选", @"Selected") : RBL(@"未选", @"Not selected");
    [toggle addAction:[UIAction actionWithHandler:^(__kindof UIAction *action) {
      if ([self.excluded containsObject:key]) [self.excluded removeObject:key]; else [self.excluded addObject:key];
      [self renderReview];
    }] forControlEvents:UIControlEventTouchUpInside];
    [row addArrangedSubview:toggle];
    NSString *status = bot[@"status"];
    NSString *detail = [status isEqual:@"imported"] ? RBL(@"已迁移过，将补充新增内容", @"Imported before; adds new items only")
                       : [status isEqual:@"conflict"] ? RBL(@"已有同名 Bot", @"A Bot with this name exists") : RBL(@"新建", @"New");
    NSDictionary *c = bot[@"counts"];
    if ([c isKindOfClass:NSDictionary.class])
      detail = [NSString stringWithFormat:@"%@ · %@%@ · %@%@ · %@%@", detail, RBL(@"记忆 ", @"memories "), c[@"memory"], RBL(@"技能 ", @"skills "), c[@"skills"], RBL(@"例程 ", @"routines "), c[@"routines"]];
    [row addArrangedSubview:[self label:detail size:12 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
    if ([status isEqual:@"conflict"] && included) {
      NSString *policy = self.policies[key] ?: @"rename";
      NSString *title = [policy isEqual:@"skip"] ? RBL(@"处理方式：跳过", @"Skip") : [policy isEqual:@"overwrite"] ? RBL(@"处理方式：覆盖现有 Bot", @"Merge into existing")
                        : [NSString stringWithFormat:RBL(@"处理方式：重命名为「%@」", @"Rename to \"%@\""), bot[@"renameTo"] ?: @""];
      UIButton *choose = [UIButton buttonWithType:UIButtonTypeSystem];
      RBThemeStyleButton(choose, title, NO);
      [choose addAction:[UIAction actionWithHandler:^(__kindof UIAction *action) {
        NSArray *options = @[ [RBChoiceOption optionWithValue:@"rename" title:RBL(@"重命名", @"Rename") subtitle:bot[@"renameTo"]],
                              [RBChoiceOption optionWithValue:@"skip" title:RBL(@"跳过", @"Skip") subtitle:RBL(@"保留现有 Bot，不导入这个", @"Keep the existing Bot")],
                              [RBChoiceOption optionWithValue:@"overwrite" title:RBL(@"覆盖", @"Merge") subtitle:RBL(@"合并到现有 Bot 并更新资料", @"Merge into the existing Bot")] ];
        [[RBChoiceSheet sheetWithTitle:RBL(@"同名 Bot", @"Same-name Bot") message:nil options:options selected:policy onSelect:^(RBChoiceOption *option) {
          self.policies[key] = option.value;
          [self renderReview];
        }] presentFrom:self];
      }] forControlEvents:UIControlEventTouchUpInside];
      [row addArrangedSubview:choose];
    }
    [list addArrangedSubview:row];
  }
  UIStackView *options = [self rowStack];
  UIButton *chat = [UIButton buttonWithType:UIButtonTypeSystem];
  RBThemeStyleButton(chat, self.includeChat ? RBL(@"聊天记录：导入（保存为资料库文件）", @"Chat history: import") : RBL(@"聊天记录：不导入", @"Chat history: skip"), NO);
  [chat addAction:[UIAction actionWithHandler:^(__kindof UIAction *action) { self.includeChat = !self.includeChat; [self renderReview]; }] forControlEvents:UIControlEventTouchUpInside];
  [options addArrangedSubview:chat];
  NSMutableArray *names = [NSMutableArray array];
  for (NSDictionary *secret in [preview[@"secrets"] isKindOfClass:NSArray.class] ? preview[@"secrets"] : @[])
    if ([secret isKindOfClass:NSDictionary.class] && [secret[@"name"] isKindOfClass:NSString.class]) [names addObject:secret[@"name"]];
  if (names.count)
    [options addArrangedSubview:[self label:[RBL(@"需要重新填写：", @"Re-enter after import: ") stringByAppendingString:[names componentsJoinedByString:@"、"]] size:12 weight:UIFontWeightRegular color:RBThemeDanger()]];
  [options addArrangedSubview:[self label:RBL(@"导入的内容只作为数据保存，不会执行其中的指令；例程导入后全部暂停，需要手动启用。", @"Imported content is stored as data and never run; routines arrive paused.")
                                     size:12 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
  UIButton *confirm = [self button:RBL(@"确认导入", @"Import") primary:YES action:@selector(confirmImport)];
  confirm.accessibilityIdentifier = @"rokbot.migrate.confirm";
  [options addArrangedSubview:confirm];
  [list addArrangedSubview:options];
  [self.review addArrangedSubview:[self card:list]];
}

- (void)confirmImport {
  NSDictionary *preview = self.preview;
  NSDictionary *selection = RBMigrateSelection([preview[@"bots"] isKindOfClass:NSArray.class] ? preview[@"bots"] : @[], self.excluded, self.policies, self.includeChat);
  NSString *path = [NSString stringWithFormat:@"/local/migrate/packages/%@/import", RBHostPathSegment(preview[@"id"] ?: @"")];
  RBHostRequest(@"POST", path, selection, 600, ^(NSInteger status, id json, NSError *error) {
    if (status != 200) { [self fail:json error:error status:status]; return; }
    [self showReport:json];
    [self refresh];
  });
}

- (void)showReport:(NSDictionary *)report {
  [self clear:self.review];
  [self.review addArrangedSubview:[self header:RBL(@"导入结果", @"Result")]];
  UIStackView *list = [UIStackView new];
  list.axis = UILayoutConstraintAxisVertical;
  NSDictionary *actions = @{ @"created" : RBL(@"已新建", @"Created"), @"updated" : RBL(@"已更新", @"Updated"), @"overwritten" : RBL(@"已覆盖同名 Bot", @"Merged"),
                             @"skipped" : RBL(@"已跳过", @"Skipped"), @"failed" : RBL(@"失败", @"Failed") };
  for (NSDictionary *bot in [report[@"bots"] isKindOfClass:NSArray.class] ? report[@"bots"] : @[]) {
    UIStackView *row = [self rowStack];
    NSString *target = [bot[@"targetName"] isKindOfClass:NSString.class] ? bot[@"targetName"] : @"";
    [row addArrangedSubview:[self label:target.length && ![target isEqual:bot[@"name"]] ? [NSString stringWithFormat:@"%@ -> %@", bot[@"name"], target] : bot[@"name"]
                                   size:15 weight:UIFontWeightMedium color:RBThemeTextPrimary()]];
    NSDictionary *added = [bot[@"added"] isKindOfClass:NSDictionary.class] ? bot[@"added"] : nil;
    NSString *detail = actions[bot[@"action"]] ?: @"";
    if (added) detail = [NSString stringWithFormat:@"%@ · %@%@ · %@%@ · %@%@", detail, RBL(@"记忆 +", @"memories +"), added[@"memory"], RBL(@"技能 +", @"skills +"), added[@"skills"], RBL(@"例程 +", @"routines +"), added[@"routines"]];
    else if ([bot[@"error"] isKindOfClass:NSString.class]) detail = [NSString stringWithFormat:@"%@ · %@", detail, bot[@"error"]];
    [row addArrangedSubview:[self label:detail size:12 weight:UIFontWeightRegular color:[bot[@"action"] isEqual:@"failed"] ? RBThemeDanger() : RBThemeTextMuted()]];
    [list addArrangedSubview:row];
  }
  NSArray *secrets = [report[@"secrets"] isKindOfClass:NSArray.class] ? report[@"secrets"] : @[];
  if (secrets.count) {
    UIStackView *row = [self rowStack];
    [row addArrangedSubview:[self label:[RBL(@"需要重新填写：", @"Re-enter: ") stringByAppendingString:[secrets componentsJoinedByString:@"、"]] size:12 weight:UIFontWeightRegular color:RBThemeDanger()]];
    [list addArrangedSubview:row];
  }
  [self.review addArrangedSubview:[self card:list]];
}

@end

void RBShowMigrateFrom(UIViewController *presenter) {
  RBMigrateController *controller = [RBMigrateController new];
  if (presenter.navigationController) {
    [presenter.navigationController pushViewController:controller animated:YES];
    return;
  }
  if (!presenter) return;
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:controller];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  nav.sheetPresentationController.detents = @[ UISheetPresentationControllerDetent.largeDetent ];
  nav.sheetPresentationController.prefersGrabberVisible = YES;
  [presenter presentViewController:nav animated:YES completion:nil];
}

#endif // TARGET_OS_IOS
