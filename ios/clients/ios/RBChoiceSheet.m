#import "RBChoiceSheet.h"
#import "RBLocalize.h"
#import "RBTheme.h"

static const NSInteger RBChoiceRowTagBase = 1000;

@implementation RBChoiceOption
+ (instancetype)optionWithValue:(NSString *)value title:(NSString *)title subtitle:(NSString *)subtitle {
  RBChoiceOption *option = [self new];
  option.value = value ?: @"";
  option.title = title ?: @"";
  option.subtitle = subtitle.length ? subtitle : nil;
  return option;
}
@end

NSUInteger RBChoiceSelectedIndex(NSArray<RBChoiceOption *> *options, NSString *value) {
  if (!value) return NSNotFound;
  for (NSUInteger i = 0; i < options.count; i++)
    if ([options[i].value isEqualToString:value]) return i;
  return NSNotFound;
}

NSArray<NSString *> *RBChoiceToggle(NSArray<RBChoiceOption *> *options, NSArray<NSString *> *selected,
                                    NSString *value, NSUInteger limit) {
  NSMutableSet<NSString *> *set = [NSMutableSet setWithArray:selected ?: @[]];
  if ([set containsObject:value]) [set removeObject:value];
  else if (limit == 0 || set.count < limit) [set addObject:value];
  NSMutableArray<NSString *> *ordered = [NSMutableArray array];
  // Keep previously chosen order first, then newly added items in option order.
  for (NSString *existing in selected ?: @[])
    if ([set containsObject:existing] && ![ordered containsObject:existing]) [ordered addObject:existing];
  for (RBChoiceOption *option in options)
    if ([set containsObject:option.value] && ![ordered containsObject:option.value]) [ordered addObject:option.value];
  return ordered;
}

@interface RBChoiceSheet () <UIGestureRecognizerDelegate>
@property(nonatomic, copy) NSString *sheetTitle;
@property(nonatomic, copy) NSString *message;
@property(nonatomic, copy, readwrite) NSArray<RBChoiceOption *> *options;
@property(nonatomic, strong) NSMutableArray<NSString *> *ordered;
@property(nonatomic, assign, readwrite) BOOL multiple;
@property(nonatomic, copy) void (^onSelect)(RBChoiceOption *option);
@property(nonatomic, copy) void (^onDone)(NSArray<NSString *> *values);
@property(nonatomic, strong) UIView *scrim;
@property(nonatomic, strong) UIView *panel;
@property(nonatomic, strong) UIScrollView *scroll;
@property(nonatomic, strong) NSMutableArray<UIControl *> *rows;
@property(nonatomic, strong) NSLayoutConstraint *panelBottom;
@property(nonatomic, assign) BOOL closing;
@end

@implementation RBChoiceSheet

+ (instancetype)sheetWithTitle:(NSString *)title message:(NSString *)message options:(NSArray<RBChoiceOption *> *)options
                      selected:(NSString *)selected onSelect:(void (^)(RBChoiceOption *))onSelect {
  RBChoiceSheet *sheet = [self new];
  sheet.sheetTitle = title ?: @"";
  sheet.message = message;
  sheet.options = options ?: @[];
  sheet.ordered = selected ? [NSMutableArray arrayWithObject:selected] : [NSMutableArray array];
  sheet.onSelect = onSelect;
  return sheet;
}

+ (instancetype)multiSheetWithTitle:(NSString *)title message:(NSString *)message options:(NSArray<RBChoiceOption *> *)options
                           selected:(NSArray<NSString *> *)selected onDone:(void (^)(NSArray<NSString *> *))onDone {
  RBChoiceSheet *sheet = [self new];
  sheet.sheetTitle = title ?: @"";
  sheet.message = message;
  sheet.options = options ?: @[];
  sheet.ordered = [selected ?: @[] mutableCopy];
  sheet.multiple = YES;
  sheet.onDone = onDone;
  return sheet;
}

- (instancetype)init {
  self = [super initWithNibName:nil bundle:nil];
  if (self) {
    self.modalPresentationStyle = UIModalPresentationOverFullScreen;
    self.modalTransitionStyle = UIModalTransitionStyleCrossDissolve;
    _rows = [NSMutableArray array];
  }
  return self;
}

- (NSSet<NSString *> *)selectedValues { return [NSSet setWithArray:self.ordered]; }

- (void)presentFrom:(UIViewController *)presenter {
  UIViewController *top = presenter;
  while (top.presentedViewController && !top.presentedViewController.isBeingDismissed)
    top = top.presentedViewController;
  [top presentViewController:self animated:NO completion:nil];
}

- (UILabel *)labelWithFont:(UIFont *)font color:(UIColor *)color {
  UILabel *label = [UILabel new];
  label.font = font;
  label.textColor = color;
  label.numberOfLines = 0;
  label.adjustsFontForContentSizeCategory = YES;
  return label;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.clearColor;
  self.view.accessibilityViewIsModal = YES;

  self.scrim = [UIView new];
  self.scrim.translatesAutoresizingMaskIntoConstraints = NO;
  self.scrim.backgroundColor = RBThemeScrim();
  self.scrim.alpha = 0;
  self.scrim.accessibilityLabel = RBL(@"关闭", @"Close");
  self.scrim.isAccessibilityElement = YES;
  [self.scrim addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(cancel)]];
  [self.view addSubview:self.scrim];

  self.panel = [UIView new];
  self.panel.translatesAutoresizingMaskIntoConstraints = NO;
  self.panel.backgroundColor = RBThemeChrome();
  self.panel.layer.cornerRadius = 24;
  self.panel.layer.cornerCurve = kCACornerCurveContinuous;
  self.panel.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
  self.panel.accessibilityIdentifier = @"rokbot.choice.sheet";
  [self.view addSubview:self.panel];
  UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(pan:)];
  pan.delegate = self;
  [self.panel addGestureRecognizer:pan];

  UIView *grabber = [UIView new];
  grabber.translatesAutoresizingMaskIntoConstraints = NO;
  grabber.backgroundColor = RBThemeBorder();
  grabber.layer.cornerRadius = 2.5;
  [self.panel addSubview:grabber];

  UILabel *title = [self labelWithFont:RBThemeFont(18, UIFontWeightSemibold) color:RBThemeTextPrimary()];
  title.text = self.sheetTitle;
  title.accessibilityTraits = UIAccessibilityTraitHeader;
  UIStackView *header = [[UIStackView alloc] initWithArrangedSubviews:@[title]];
  header.axis = UILayoutConstraintAxisVertical;
  header.spacing = 4;
  header.translatesAutoresizingMaskIntoConstraints = NO;
  if (self.message.length) {
    UILabel *message = [self labelWithFont:RBThemeFont(13, UIFontWeightRegular) color:RBThemeTextSecondary()];
    message.text = self.message;
    [header addArrangedSubview:message];
  }
  UIView *headerRow = [UIView new];
  headerRow.translatesAutoresizingMaskIntoConstraints = NO;
  [headerRow addSubview:header];
  [self.panel addSubview:headerRow];
  UIButton *done = nil;
  if (self.multiple) {
    done = [UIButton buttonWithType:UIButtonTypeSystem];
    done.translatesAutoresizingMaskIntoConstraints = NO;
    RBThemeStyleButton(done, RBL(@"完成", @"Done"), YES);
    done.accessibilityIdentifier = @"rokbot.choice.done";
    [done addTarget:self action:@selector(finishMultiple) forControlEvents:UIControlEventTouchUpInside];
    [headerRow addSubview:done];
  }

  self.scroll = [UIScrollView new];
  self.scroll.translatesAutoresizingMaskIntoConstraints = NO;
  self.scroll.alwaysBounceVertical = NO;
  [self.panel addSubview:self.scroll];

  UIView *card = RBThemeCard(18);
  card.translatesAutoresizingMaskIntoConstraints = NO;
  [self.scroll addSubview:card];
  UIStackView *list = [UIStackView new];
  list.axis = UILayoutConstraintAxisVertical;
  list.translatesAutoresizingMaskIntoConstraints = NO;
  [card addSubview:list];
  for (NSUInteger i = 0; i < self.options.count; i++) {
    if (i > 0) {
      UIView *line = [UIView new];
      line.backgroundColor = RBThemeBorder();
      line.translatesAutoresizingMaskIntoConstraints = NO;
      UIView *wrap = [UIView new];
      [wrap addSubview:line];
      [NSLayoutConstraint activateConstraints:@[
        [line.leadingAnchor constraintEqualToAnchor:wrap.leadingAnchor constant:16],
        [line.trailingAnchor constraintEqualToAnchor:wrap.trailingAnchor],
        [line.topAnchor constraintEqualToAnchor:wrap.topAnchor],
        [line.bottomAnchor constraintEqualToAnchor:wrap.bottomAnchor],
        [line.heightAnchor constraintEqualToConstant:1.0 / UIScreen.mainScreen.scale],
      ]];
      [list addArrangedSubview:wrap];
    }
    UIControl *row = [self rowForOption:self.options[i] index:i];
    [self.rows addObject:row];
    [list addArrangedSubview:row];
  }

  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  self.panelBottom = [self.panel.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor constant:800];
  NSLayoutConstraint *scrollHeight = [self.scroll.heightAnchor constraintEqualToAnchor:card.heightAnchor constant:4];
  scrollHeight.priority = UILayoutPriorityDefaultHigh;
  NSMutableArray *constraints = [@[
    [self.scrim.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [self.scrim.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [self.scrim.topAnchor constraintEqualToAnchor:self.view.topAnchor],
    [self.scrim.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [self.panel.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [self.panel.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    self.panelBottom,
    [self.panel.heightAnchor constraintLessThanOrEqualToAnchor:self.view.heightAnchor multiplier:0.62 constant:0],
    [grabber.topAnchor constraintEqualToAnchor:self.panel.topAnchor constant:8],
    [grabber.centerXAnchor constraintEqualToAnchor:self.panel.centerXAnchor],
    [grabber.widthAnchor constraintEqualToConstant:36],
    [grabber.heightAnchor constraintEqualToConstant:5],
    [headerRow.topAnchor constraintEqualToAnchor:grabber.bottomAnchor constant:14],
    [headerRow.leadingAnchor constraintEqualToAnchor:self.panel.leadingAnchor constant:20],
    [headerRow.trailingAnchor constraintEqualToAnchor:self.panel.trailingAnchor constant:-20],
    [header.leadingAnchor constraintEqualToAnchor:headerRow.leadingAnchor],
    [header.topAnchor constraintEqualToAnchor:headerRow.topAnchor],
    [header.bottomAnchor constraintEqualToAnchor:headerRow.bottomAnchor],
    [self.scroll.topAnchor constraintEqualToAnchor:headerRow.bottomAnchor constant:14],
    [self.scroll.leadingAnchor constraintEqualToAnchor:self.panel.leadingAnchor constant:16],
    [self.scroll.trailingAnchor constraintEqualToAnchor:self.panel.trailingAnchor constant:-16],
    [self.scroll.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-12],
    scrollHeight,
    [card.topAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.topAnchor],
    [card.leadingAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.leadingAnchor],
    [card.trailingAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.trailingAnchor],
    [card.bottomAnchor constraintEqualToAnchor:self.scroll.contentLayoutGuide.bottomAnchor constant:-4],
    [card.widthAnchor constraintEqualToAnchor:self.scroll.frameLayoutGuide.widthAnchor],
    [list.topAnchor constraintEqualToAnchor:card.topAnchor constant:4],
    [list.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-4],
    [list.leadingAnchor constraintEqualToAnchor:card.leadingAnchor],
    [list.trailingAnchor constraintEqualToAnchor:card.trailingAnchor],
  ] mutableCopy];
  if (done) {
    [constraints addObjectsFromArray:@[
      [done.trailingAnchor constraintEqualToAnchor:headerRow.trailingAnchor],
      [done.centerYAnchor constraintEqualToAnchor:headerRow.centerYAnchor],
      [header.trailingAnchor constraintLessThanOrEqualToAnchor:done.leadingAnchor constant:-12],
    ]];
  } else {
    [constraints addObject:[header.trailingAnchor constraintEqualToAnchor:headerRow.trailingAnchor]];
  }
  [NSLayoutConstraint activateConstraints:constraints];
}

- (UIControl *)rowForOption:(RBChoiceOption *)option index:(NSUInteger)index {
  UIControl *row = [UIControl new];
  // Offset so viewWithTag: lookups for the title (1) and check (2) never match the row itself.
  row.tag = RBChoiceRowTagBase + (NSInteger)index;
  row.accessibilityIdentifier = [@"rokbot.choice." stringByAppendingString:option.value];
  row.isAccessibilityElement = YES;
  row.accessibilityLabel = option.subtitle.length ? [NSString stringWithFormat:@"%@, %@", option.title, option.subtitle] : option.title;
  [row addTarget:self action:@selector(rowDown:) forControlEvents:UIControlEventTouchDown | UIControlEventTouchDragEnter];
  [row addTarget:self action:@selector(rowUp:) forControlEvents:UIControlEventTouchUpOutside | UIControlEventTouchCancel | UIControlEventTouchDragExit];
  [row addTarget:self action:@selector(rowTapped:) forControlEvents:UIControlEventTouchUpInside];
  [row.heightAnchor constraintGreaterThanOrEqualToConstant:52].active = YES;

  UILabel *title = [self labelWithFont:RBThemeFont(15, UIFontWeightRegular)
                                 color:option.destructive ? RBThemeDanger() : RBThemeTextPrimary()];
  title.text = option.title;
  title.tag = 1;
  UIStackView *texts = [[UIStackView alloc] initWithArrangedSubviews:@[title]];
  texts.axis = UILayoutConstraintAxisVertical;
  texts.spacing = 2;
  texts.userInteractionEnabled = NO;
  if (option.subtitle.length) {
    UILabel *subtitle = [self labelWithFont:RBThemeFont(12.5, UIFontWeightRegular) color:RBThemeTextSecondary()];
    subtitle.text = option.subtitle;
    [texts addArrangedSubview:subtitle];
  }
  UIImageView *check = [[UIImageView alloc] initWithImage:RBGlyphImage(RBGlyphCheck, 20, 2.2)];
  check.tintColor = RBThemeAccent();
  check.tag = 2;
  check.contentMode = UIViewContentModeCenter;
  [check setContentHuggingPriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  UIStackView *line = [[UIStackView alloc] initWithArrangedSubviews:@[texts, check]];
  line.alignment = UIStackViewAlignmentCenter;
  line.spacing = 12;
  line.userInteractionEnabled = NO;
  line.translatesAutoresizingMaskIntoConstraints = NO;
  [row addSubview:line];
  [NSLayoutConstraint activateConstraints:@[
    [line.leadingAnchor constraintEqualToAnchor:row.leadingAnchor constant:16],
    [line.trailingAnchor constraintEqualToAnchor:row.trailingAnchor constant:-16],
    [line.topAnchor constraintEqualToAnchor:row.topAnchor constant:12],
    [line.bottomAnchor constraintEqualToAnchor:row.bottomAnchor constant:-12],
    [check.widthAnchor constraintEqualToConstant:22],
  ]];
  [self applySelectionToRow:row];
  return row;
}

- (void)applySelectionToRow:(UIControl *)row {
  RBChoiceOption *option = self.options[(NSUInteger)(row.tag - RBChoiceRowTagBase)];
  BOOL selected = [self.ordered containsObject:option.value];
  UILabel *title = [row viewWithTag:1];
  title.font = RBThemeFont(15, selected ? UIFontWeightSemibold : UIFontWeightRegular);
  [row viewWithTag:2].alpha = selected ? 1 : 0;
  row.accessibilityTraits = UIAccessibilityTraitButton | (selected ? UIAccessibilityTraitSelected : 0);
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  [self.view layoutIfNeeded];
  NSUInteger index = self.ordered.count ? RBChoiceSelectedIndex(self.options, self.ordered.firstObject) : NSNotFound;
  if (index != NSNotFound && index < self.rows.count) {
    CGRect frame = [self.rows[index] convertRect:self.rows[index].bounds toView:self.scroll];
    [self.scroll scrollRectToVisible:CGRectInset(frame, 0, -40) animated:NO];
  }
  self.panelBottom.constant = 0;
  [UIView animateWithDuration:0.32 delay:0 usingSpringWithDamping:0.92 initialSpringVelocity:0.4
                      options:UIViewAnimationOptionCurveEaseOut animations:^{
    self.scrim.alpha = 1;
    [self.view layoutIfNeeded];
  } completion:nil];
  UIAccessibilityPostNotification(UIAccessibilityScreenChangedNotification, self.panel);
}

- (void)closeThen:(void (^)(void))after {
  if (self.closing) return;
  self.closing = YES;
  self.panelBottom.constant = self.panel.bounds.size.height + 40;
  [UIView animateWithDuration:0.22 animations:^{
    self.scrim.alpha = 0;
    [self.view layoutIfNeeded];
  } completion:^(BOOL finished) {
    [self.presentingViewController dismissViewControllerAnimated:NO completion:^{
      if (after) after();
    }];
  }];
}

- (BOOL)accessibilityPerformEscape {
  [self cancel];
  return YES;
}

- (void)cancel {
  if (self.multiple) {
    [self finishMultiple];
    return;
  }
  [self closeThen:nil];
}

- (void)finishMultiple {
  NSArray<NSString *> *values = [self.ordered copy];
  void (^done)(NSArray<NSString *> *) = self.onDone;
  [self closeThen:^{ if (done) done(values); }];
}

- (void)rowDown:(UIControl *)row { row.backgroundColor = RBThemeHover(); }
- (void)rowUp:(UIControl *)row { row.backgroundColor = UIColor.clearColor; }

- (void)rowTapped:(UIControl *)row {
  RBChoiceOption *option = self.options[(NSUInteger)(row.tag - RBChoiceRowTagBase)];
  if (self.multiple) {
    row.backgroundColor = UIColor.clearColor;
    self.ordered = [RBChoiceToggle(self.options, self.ordered, option.value, 8) mutableCopy];
    for (UIControl *each in self.rows) [self applySelectionToRow:each];
    return;
  }
  self.ordered = [NSMutableArray arrayWithObject:option.value];
  for (UIControl *each in self.rows) [self applySelectionToRow:each];
  void (^select)(RBChoiceOption *) = self.onSelect;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.08 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [self closeThen:^{ if (select) select(option); }];
  });
}

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)gesture {
  if (![gesture isKindOfClass:UIPanGestureRecognizer.class]) return YES;
  CGPoint velocity = [(UIPanGestureRecognizer *)gesture velocityInView:self.panel];
  return velocity.y > fabs(velocity.x) && self.scroll.contentOffset.y <= 0;
}

- (void)pan:(UIPanGestureRecognizer *)pan {
  CGFloat dy = MAX(0, [pan translationInView:self.view].y);
  if (pan.state == UIGestureRecognizerStateChanged) {
    self.panelBottom.constant = dy;
    self.scrim.alpha = MAX(0, 1 - dy / MAX(1, self.panel.bounds.size.height));
  } else if (pan.state == UIGestureRecognizerStateEnded || pan.state == UIGestureRecognizerStateCancelled) {
    if (dy > self.panel.bounds.size.height * 0.28 || [pan velocityInView:self.view].y > 900) {
      [self cancel];
    } else {
      self.panelBottom.constant = 0;
      [UIView animateWithDuration:0.2 animations:^{
        self.scrim.alpha = 1;
        [self.view layoutIfNeeded];
      }];
    }
  }
}

@end
