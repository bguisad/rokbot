#import "RBCanvas.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBHostAPI.h"
#import "RBLocalize.h"
#import "RBTheme.h"
#import "RBDiagnostics.h"
#import <WebKit/WebKit.h>

// Canvases inside the app, after the official Pages stage and share sheet:
// - a chat link `<host>/canvas/app/<id>` opens RBCanvasStage (返回聊天, title with 私有 / 公开, 刷新,
//   分享, 关闭) instead of Safari;
// - the canvas page is read with this device's credential (GET /canvas/app/<id>/frame) and shown in
//   a WKWebView with a non-persistent store, a content rule that blocks every network load and no
//   script bridge, so the canvas stays offline as it is on the desktop;
// - the share sheet switches 公开访问 (official PRIVATE / PUBLIC) with a drawn switch and offers
//   复制链接, 在浏览器中打开 and 重新生成链接 (the old public link stops working).

static NSRegularExpression *RBCanvasRegex(NSString *pattern) {
  return [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:nil];
}

static BOOL RBCanvasIsId(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return NO;
  static NSRegularExpression *re;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ re = RBCanvasRegex(@"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"); });
  return [re numberOfMatchesInString:value options:0 range:NSMakeRange(0, value.length)] == 1;
}

NSString *RBCanvasAppLinkId(NSURL *url) {
  if (![url isKindOfClass:NSURL.class] || url.absoluteString.length > 2048) return nil;
  NSString *scheme = url.scheme.lowercaseString;
  if (!([scheme isEqual:@"http"] || [scheme isEqual:@"https"]) || !url.host.length || url.user.length || url.password.length) return nil;
  NSArray<NSString *> *parts = [url.path componentsSeparatedByString:@"/"];
  NSMutableArray<NSString *> *segments = [NSMutableArray array];
  for (NSString *part in parts) if (part.length) [segments addObject:part];
  if (segments.count != 3 || ![segments[0] isEqual:@"canvas"] || ![segments[1] isEqual:@"app"]) return nil;
  NSString *canvasId = segments[2].lowercaseString;
  return RBCanvasIsId(canvasId) ? canvasId : nil;
}

static BOOL RBCanvasIsPublicLink(NSString *value) {
  NSURL *url = [NSURL URLWithString:value ?: @""];
  NSString *scheme = url.scheme.lowercaseString;
  if (!([scheme isEqual:@"http"] || [scheme isEqual:@"https"]) || url.user.length) return NO;
  static NSRegularExpression *re;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ re = RBCanvasRegex(@"^/canvas/[A-Za-z0-9_-]{43}/?$"); });
  NSString *path = url.path ?: @"";
  return [re numberOfMatchesInString:path options:0 range:NSMakeRange(0, path.length)] == 1;
}

NSString *RBCanvasShortTime(double ms, double nowMs, BOOL chinese) {
  if (ms <= 0) return @"";
  NSCalendar *cal = [[NSCalendar alloc] initWithCalendarIdentifier:NSCalendarIdentifierGregorian];
  cal.timeZone = [NSTimeZone timeZoneWithName:@"Asia/Shanghai"];
  NSCalendarUnit units = NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay | NSCalendarUnitHour | NSCalendarUnitMinute;
  NSDateComponents *at = [cal components:units fromDate:[NSDate dateWithTimeIntervalSince1970:ms / 1000.0]];
  NSDateComponents *now = [cal components:units fromDate:[NSDate dateWithTimeIntervalSince1970:nowMs / 1000.0]];
  NSString *time = [NSString stringWithFormat:@"%02ld:%02ld", (long)at.hour, (long)at.minute];
  if (at.year == now.year && at.month == now.month && at.day == now.day)
    return chinese ? [@"今天 " stringByAppendingString:time] : [@"Today " stringByAppendingString:time];
  if (at.year == now.year)
    return chinese ? [NSString stringWithFormat:@"%ld月%ld日 %@", (long)at.month, (long)at.day, time]
                   : [NSString stringWithFormat:@"%ld/%ld %@", (long)at.month, (long)at.day, time];
  return chinese ? [NSString stringWithFormat:@"%ld年%ld月%ld日", (long)at.year, (long)at.month, (long)at.day]
                 : [NSString stringWithFormat:@"%ld/%ld/%ld", (long)at.year, (long)at.month, (long)at.day];
}

static UIColor *RBCanvasOk(void) {
  return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
    return t.userInterfaceStyle == UIUserInterfaceStyleDark ? [UIColor colorWithRed:0.24 green:0.84 blue:0.55 alpha:1]
                                                            : [UIColor colorWithRed:0.10 green:0.56 blue:0.36 alpha:1];
  }];
}

// Line icons on a 16-unit grid (no SF Symbols), drawn like the desktop canvas icons.
static UIImage *RBCanvasIcon(NSString *name, CGFloat size) {
  UIGraphicsImageRenderer *r = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(size, size)];
  UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
    CGFloat s = size / 16.0;
    UIBezierPath *p = [UIBezierPath bezierPath];
    p.lineWidth = 1.4 * s;
    p.lineCapStyle = kCGLineCapRound;
    p.lineJoinStyle = kCGLineJoinRound;
    [UIColor.blackColor setStroke];
    [UIColor.blackColor setFill];
    #define M(x, y) [p moveToPoint:CGPointMake((x) * s, (y) * s)]
    #define L(x, y) [p addLineToPoint:CGPointMake((x) * s, (y) * s)]
    if ([name isEqual:@"page"]) {
      M(4.5, 2.5); L(9.5, 2.5); L(12.5, 5.5); L(12.5, 13.5); L(3.5, 13.5); L(3.5, 2.5); [p closePath];
      M(9.5, 2.5); L(9.5, 5.5); L(12.5, 5.5); M(5.75, 8.5); L(10.25, 8.5); M(5.75, 11); L(8.75, 11);
    } else if ([name isEqual:@"lock"]) {
      [p appendPath:[UIBezierPath bezierPathWithRoundedRect:CGRectMake(3.5 * s, 7.5 * s, 9 * s, 6.5 * s) cornerRadius:1.2 * s]];
      M(5.75, 7.5); L(5.75, 5.25);
      [p addArcWithCenter:CGPointMake(8 * s, 5.25 * s) radius:2.25 * s startAngle:M_PI endAngle:0 clockwise:YES];
      L(10.25, 7.5);
    } else if ([name isEqual:@"globe"]) {
      [p appendPath:[UIBezierPath bezierPathWithOvalInRect:CGRectMake(1.75 * s, 1.75 * s, 12.5 * s, 12.5 * s)]];
      [p appendPath:[UIBezierPath bezierPathWithOvalInRect:CGRectMake(5.5 * s, 1.75 * s, 5 * s, 12.5 * s)]];
      M(1.75, 8); L(14.25, 8);
    } else if ([name isEqual:@"refresh"]) {
      [p addArcWithCenter:CGPointMake(8 * s, 8 * s) radius:5.25 * s startAngle:-0.7 endAngle:-0.7 + 5.4 clockwise:YES];
      M(13.25, 2.75); L(13.25, 5.75); L(10.25, 5.75);
    } else if ([name isEqual:@"share"]) {
      M(8, 10); L(8, 2.25); M(5.25, 5); L(8, 2.25); L(10.75, 5); M(3.75, 8.5); L(3.75, 13.75); L(12.25, 13.75); L(12.25, 8.5);
    } else if ([name isEqual:@"close"]) {
      M(4, 4); L(12, 12); M(12, 4); L(4, 12);
    } else if ([name isEqual:@"back"]) {
      M(10, 3.5); L(5.5, 8); L(10, 12.5);
    } else if ([name isEqual:@"copy"]) {
      [p appendPath:[UIBezierPath bezierPathWithRoundedRect:CGRectMake(2.75 * s, 5.5 * s, 7.75 * s, 7.75 * s) cornerRadius:1.2 * s]];
      M(5.5, 5.5); L(5.5, 2.75); L(13.25, 2.75); L(13.25, 10.5); L(10.5, 10.5);
    } else if ([name isEqual:@"external"]) {
      M(9.5, 2.75); L(13.25, 2.75); L(13.25, 6.5); M(13.25, 2.75); L(7.5, 8.5);
      M(11.5, 9.5); L(11.5, 13.25); L(2.75, 13.25); L(2.75, 4.5); L(6.5, 4.5);
    } else if ([name isEqual:@"rotate"]) {
      [p addArcWithCenter:CGPointMake(8 * s, 8 * s) radius:5.25 * s startAngle:M_PI endAngle:M_PI + 2.4 clockwise:YES];
      M(13.25, 2.75); L(13.25, 5.75); L(10.25, 5.75);
      [p moveToPoint:CGPointMake(13.25 * s, 8 * s)];
      [p addArcWithCenter:CGPointMake(8 * s, 8 * s) radius:5.25 * s startAngle:0 endAngle:2.4 clockwise:YES];
      M(2.75, 13.25); L(2.75, 10.25); L(5.75, 10.25);
    } else if ([name isEqual:@"check"]) {
      M(3.5, 8.5); L(6.5, 11.5); L(12.5, 4.5);
    } else if ([name isEqual:@"more"]) {
      for (NSNumber *x in @[ @3.5, @8, @12.5 ])
        [[UIBezierPath bezierPathWithOvalInRect:CGRectMake((x.doubleValue - 1.2) * s, 6.8 * s, 2.4 * s, 2.4 * s)] fill];
    }
    #undef M
    #undef L
    [p stroke];
    (void)ctx;
  }];
  return [image imageWithRenderingMode:UIImageRenderingModeAlwaysTemplate];
}

static NSString *RBCanvasVisibilityLabel(NSString *visibility) {
  return [visibility isEqual:@"public"] ? RBL(@"公开", @"Public") : RBL(@"私有", @"Private");
}

static UIViewController *RBCanvasTop(void) {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)scene).windows)
        if (w.isKeyWindow) top = w.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}

static UIButton *RBCanvasButton(NSString *icon, NSString *title, BOOL filled, id target, SEL action) {
  UIButtonConfiguration *c = filled ? UIButtonConfiguration.filledButtonConfiguration : UIButtonConfiguration.plainButtonConfiguration;
  c.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  c.baseForegroundColor = filled ? RBThemeOnPrimaryButton() : RBThemeTextPrimary();
  if (filled) c.baseBackgroundColor = RBThemePrimaryButton();
  if (icon) c.image = RBCanvasIcon(icon, 16);
  c.imagePadding = 6;
  if (title) {
    c.attributedTitle = [[NSAttributedString alloc] initWithString:title attributes:@{NSFontAttributeName : RBThemeFont(14, UIFontWeightSemibold)}];
    c.contentInsets = NSDirectionalEdgeInsetsMake(8, 12, 8, 14);
  } else {
    c.contentInsets = NSDirectionalEdgeInsetsMake(8, 8, 8, 8);
  }
  UIButton *b = [UIButton buttonWithConfiguration:c primaryAction:nil];
  [b addTarget:target action:action forControlEvents:UIControlEventTouchUpInside];
  b.accessibilityLabel = title;
  if (!filled && title) {
    b.layer.cornerRadius = 18;
    b.layer.borderWidth = 1;
    b.layer.borderColor = RBThemeBorder().CGColor;
  }
  return b;
}

#pragma mark - Public access switch (drawn, switch semantics)

@interface RBCanvasSwitch : UIControl
@property(nonatomic, getter=isOn) BOOL on;
@end
@implementation RBCanvasSwitch {
  UIView *_knob;
}
- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:CGRectMake(0, 0, 46, 28)];
  self.layer.cornerRadius = 14;
  _knob = [[UIView alloc] initWithFrame:CGRectMake(3, 3, 22, 22)];
  _knob.backgroundColor = UIColor.whiteColor;
  _knob.layer.cornerRadius = 11;
  _knob.layer.shadowColor = UIColor.blackColor.CGColor;
  _knob.layer.shadowOpacity = 0.22;
  _knob.layer.shadowRadius = 2;
  _knob.layer.shadowOffset = CGSizeMake(0, 1);
  _knob.userInteractionEnabled = NO;
  [self addSubview:_knob];
  self.isAccessibilityElement = YES;
  self.accessibilityTraits = UIAccessibilityTraitButton;
  [self apply:NO];
  return self;
}
- (CGSize)intrinsicContentSize { return CGSizeMake(46, 28); }
- (void)apply:(BOOL)animated {
  void (^change)(void) = ^{
    self.backgroundColor = self.on ? RBCanvasOk() : RBThemeBorder();
    self->_knob.frame = CGRectMake(self.on ? 21 : 3, 3, 22, 22);
  };
  if (animated) [UIView animateWithDuration:0.16 animations:change]; else change();
  self.accessibilityValue = self.on ? RBL(@"已开启", @"On") : RBL(@"已关闭", @"Off");
  self.alpha = self.enabled ? 1 : 0.55;
}
- (void)setOn:(BOOL)on { _on = on; [self apply:YES]; }
- (void)setEnabled:(BOOL)enabled { [super setEnabled:enabled]; [self apply:NO]; }
- (void)endTrackingWithTouch:(UITouch *)touch withEvent:(UIEvent *)event {
  [super endTrackingWithTouch:touch withEvent:event];
  if (CGRectContainsPoint(CGRectInset(self.bounds, -12, -12), [touch locationInView:self]))
    [self sendActionsForControlEvents:UIControlEventValueChanged];
}
- (BOOL)accessibilityActivate { [self sendActionsForControlEvents:UIControlEventValueChanged]; return YES; }
@end

#pragma mark - Share sheet

@interface RBCanvasShareController : UIViewController
@property(nonatomic, copy) NSDictionary *canvas;
@property(nonatomic, copy) void (^changed)(NSDictionary *);
@property(nonatomic) BOOL pending;
@property(nonatomic) BOOL confirmRegenerate;
@property(nonatomic, copy) NSString *error;
@property(nonatomic, strong) UIStackView *stack;
@end
@implementation RBCanvasShareController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = RBThemeElevated();
  self.view.accessibilityIdentifier = @"canvas_share_sheet";
  self.stack = [UIStackView new];
  self.stack.axis = UILayoutConstraintAxisVertical;
  self.stack.spacing = 12;
  self.stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:self.stack];
  [NSLayoutConstraint activateConstraints:@[
    [self.stack.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:24],
    [self.stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:20],
    [self.stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-20],
  ]];
  [self render];
}
- (UILabel *)label:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight color:(UIColor *)color {
  UILabel *l = [UILabel new];
  l.text = text;
  l.font = RBThemeFont(size, weight);
  l.textColor = color;
  l.numberOfLines = 0;
  return l;
}
- (void)render {
  for (UIView *v in self.stack.arrangedSubviews) [v removeFromSuperview];
  NSString *title = self.canvas[@"title"] ?: RBL(@"画布", @"Canvas");
  BOOL isPublic = [self.canvas[@"visibility"] isEqual:@"public"];
  NSString *publicUrl = [self.canvas[@"publicUrl"] isKindOfClass:NSString.class] ? self.canvas[@"publicUrl"] : @"";
  UILabel *heading = [self label:[NSString stringWithFormat:RBL(@"分享“%@”", @"Share “%@”"), title] size:17 weight:UIFontWeightBold color:RBThemeTextPrimary()];
  heading.numberOfLines = 1;
  [self.stack addArrangedSubview:heading];
  [self.stack addArrangedSubview:[self label:RBL(@"谁可以访问", @"Who can access") size:12 weight:UIFontWeightMedium color:RBThemeTextMuted()]];

  UIView *row = [UIView new];
  row.backgroundColor = RBThemeSecondaryFill();
  row.layer.cornerRadius = 14;
  UIImageView *icon = [[UIImageView alloc] initWithImage:RBCanvasIcon(isPublic ? @"globe" : @"lock", 18)];
  icon.tintColor = isPublic ? RBCanvasOk() : RBThemeTextSecondary();
  icon.contentMode = UIViewContentModeCenter;
  icon.backgroundColor = RBThemeElevated();
  icon.layer.cornerRadius = 18;
  UILabel *name = [self label:RBL(@"公开访问", @"Public access") size:15 weight:UIFontWeightSemibold color:RBThemeTextPrimary()];
  NSString *desc = self.pending ? RBL(@"正在更新…", @"Updating…")
                   : isPublic ? RBL(@"知道链接的任何人 · 无需登录", @"Anyone with the link · No sign-in needed")
                              : RBL(@"仅你可见 · 只能在已登录的 RokBot 中打开", @"Private to you · Opens only in signed-in RokBot apps");
  UILabel *detail = [self label:desc size:12 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
  UIStackView *texts = [[UIStackView alloc] initWithArrangedSubviews:@[ name, detail ]];
  texts.axis = UILayoutConstraintAxisVertical;
  texts.spacing = 2;
  RBCanvasSwitch *toggle = [RBCanvasSwitch new];
  toggle.on = isPublic;
  toggle.enabled = !self.pending;
  toggle.accessibilityLabel = RBL(@"公开访问", @"Public access");
  toggle.accessibilityIdentifier = @"canvas_public_switch";
  [toggle addTarget:self action:@selector(togglePublic) forControlEvents:UIControlEventValueChanged];
  for (UIView *v in @[ icon, texts, toggle ]) { v.translatesAutoresizingMaskIntoConstraints = NO; [row addSubview:v]; }
  [NSLayoutConstraint activateConstraints:@[
    [icon.leadingAnchor constraintEqualToAnchor:row.leadingAnchor constant:12],
    [icon.centerYAnchor constraintEqualToAnchor:row.centerYAnchor],
    [icon.widthAnchor constraintEqualToConstant:36], [icon.heightAnchor constraintEqualToConstant:36],
    [texts.leadingAnchor constraintEqualToAnchor:icon.trailingAnchor constant:12],
    [texts.topAnchor constraintEqualToAnchor:row.topAnchor constant:12],
    [texts.bottomAnchor constraintEqualToAnchor:row.bottomAnchor constant:-12],
    [toggle.leadingAnchor constraintGreaterThanOrEqualToAnchor:texts.trailingAnchor constant:8],
    [toggle.trailingAnchor constraintEqualToAnchor:row.trailingAnchor constant:-12],
    [toggle.centerYAnchor constraintEqualToAnchor:row.centerYAnchor],
    [toggle.widthAnchor constraintEqualToConstant:46], [toggle.heightAnchor constraintEqualToConstant:28],
  ]];
  [self.stack addArrangedSubview:row];

  if (isPublic && publicUrl.length) {
    UILabel *link = [self label:publicUrl size:12 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
    link.font = [UIFont monospacedSystemFontOfSize:12 weight:UIFontWeightRegular];
    link.numberOfLines = 1;
    link.lineBreakMode = NSLineBreakByTruncatingMiddle;
    link.accessibilityIdentifier = @"canvas_public_url";
    UIView *box = [UIView new];
    box.layer.cornerRadius = 12;
    box.layer.borderWidth = 1;
    box.layer.borderColor = RBThemeBorder().CGColor;
    link.translatesAutoresizingMaskIntoConstraints = NO;
    [box addSubview:link];
    [NSLayoutConstraint activateConstraints:@[
      [link.leadingAnchor constraintEqualToAnchor:box.leadingAnchor constant:12],
      [link.trailingAnchor constraintEqualToAnchor:box.trailingAnchor constant:-12],
      [link.topAnchor constraintEqualToAnchor:box.topAnchor constant:10],
      [link.bottomAnchor constraintEqualToAnchor:box.bottomAnchor constant:-10],
    ]];
    [self.stack addArrangedSubview:box];
    UIStackView *actions = [[UIStackView alloc] initWithArrangedSubviews:@[
      RBCanvasButton(@"copy", RBL(@"复制链接", @"Copy link"), YES, self, @selector(copyLink:)),
      RBCanvasButton(@"external", RBL(@"在浏览器中打开", @"Open in browser"), NO, self, @selector(openInBrowser)),
    ]];
    actions.spacing = 8;
    actions.alignment = UIStackViewAlignmentLeading;
    UIView *spacer = [UIView new];
    [actions addArrangedSubview:spacer];
    [self.stack addArrangedSubview:actions];
    UIButton *regen = RBCanvasButton(@"rotate", RBL(@"重新生成链接", @"Regenerate link"), NO, self, @selector(askRegenerate));
    regen.enabled = !self.pending && !self.confirmRegenerate;
    UIStackView *regenRow = [[UIStackView alloc] initWithArrangedSubviews:@[ regen, [UIView new] ]];
    [self.stack addArrangedSubview:regenRow];
    if (self.confirmRegenerate) {
      UILabel *warn = [self label:RBL(@"生成新链接后，旧链接会立即失效，已经发出去的旧链接将无法再打开。",
                                      @"The old link stops working right away; anyone holding it can no longer open the canvas.")
                             size:12 weight:UIFontWeightRegular color:RBThemeTextSecondary()];
      UIButton *go = RBCanvasButton(nil, self.pending ? RBL(@"正在生成…", @"Regenerating…") : RBL(@"生成新链接", @"Regenerate"), YES, self, @selector(regenerate));
      UIButtonConfiguration *c = go.configuration;
      c.baseBackgroundColor = RBThemeDanger();
      c.baseForegroundColor = UIColor.whiteColor;
      go.configuration = c;
      UIButton *cancel = RBCanvasButton(nil, RBL(@"取消", @"Cancel"), NO, self, @selector(cancelRegenerate));
      UIStackView *buttons = [[UIStackView alloc] initWithArrangedSubviews:@[ go, cancel, [UIView new] ]];
      buttons.spacing = 8;
      UIStackView *confirm = [[UIStackView alloc] initWithArrangedSubviews:@[ warn, buttons ]];
      confirm.axis = UILayoutConstraintAxisVertical;
      confirm.spacing = 8;
      confirm.layoutMargins = UIEdgeInsetsMake(10, 12, 12, 12);
      confirm.layoutMarginsRelativeArrangement = YES;
      confirm.backgroundColor = [RBThemeDanger() colorWithAlphaComponent:0.1];
      confirm.layer.cornerRadius = 12;
      [self.stack addArrangedSubview:confirm];
    }
  } else {
    [self.stack addArrangedSubview:[self label:RBL(@"开启后会生成一个公开链接，拿到链接的人无需登录即可查看。关闭后该链接立即失效。",
                                                   @"Turning this on creates a public link anyone can open without signing in. Turning it off disables the link right away.")
                                          size:12 weight:UIFontWeightRegular color:RBThemeTextMuted()]];
  }
  if (self.error.length)
    [self.stack addArrangedSubview:[self label:self.error size:12 weight:UIFontWeightRegular color:RBThemeDanger()]];
}
- (void)apply:(NSDictionary *)json {
  NSDictionary *next = [json isKindOfClass:NSDictionary.class] ? json[@"canvas"] : nil;
  if ([next isKindOfClass:NSDictionary.class]) {
    self.canvas = next;
    if (self.changed) self.changed(next);
  }
}
- (void)togglePublic {
  if (self.pending) return;
  BOOL makePublic = ![self.canvas[@"visibility"] isEqual:@"public"];
  self.pending = YES; self.error = nil; [self render];
  NSString *path = [NSString stringWithFormat:@"/local/canvases/%@/visibility", RBHostPathSegment(self.canvas[@"id"] ?: @"")];
  RBHostRequest(@"POST", path, @{@"visibility" : makePublic ? @"public" : @"private"}, 20, ^(NSInteger status, id json, NSError *error) {
    self.pending = NO;
    if (status == 200) [self apply:json];
    else self.error = RBL(@"无法更新访问权限，请稍后再试。", @"Couldn’t update access. Try again later.");
    [self render];
  });
}
- (void)askRegenerate { self.confirmRegenerate = YES; [self render]; }
- (void)cancelRegenerate { self.confirmRegenerate = NO; [self render]; }
- (void)regenerate {
  if (self.pending) return;
  self.pending = YES; self.error = nil; [self render];
  NSString *path = [NSString stringWithFormat:@"/local/canvases/%@/link", RBHostPathSegment(self.canvas[@"id"] ?: @"")];
  RBHostRequest(@"POST", path, @{}, 20, ^(NSInteger status, id json, NSError *error) {
    self.pending = NO;
    if (status == 200) { self.confirmRegenerate = NO; [self apply:json]; }
    else self.error = RBL(@"无法重新生成链接，请稍后再试。", @"Could not regenerate the link. Try again later.");
    [self render];
  });
}
- (void)copyLink:(UIButton *)button {
  NSString *url = self.canvas[@"publicUrl"];
  if (![url isKindOfClass:NSString.class]) return;
  UIPasteboard.generalPasteboard.string = url;
  UIButtonConfiguration *c = button.configuration;
  c.image = RBCanvasIcon(@"check", 16);
  c.attributedTitle = [[NSAttributedString alloc] initWithString:RBL(@"已复制", @"Copied") attributes:@{NSFontAttributeName : RBThemeFont(14, UIFontWeightSemibold)}];
  button.configuration = c;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.6 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self render]; });
}
- (void)openInBrowser {
  NSString *url = self.canvas[@"publicUrl"];
  if (!RBCanvasIsPublicLink(url)) return;
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:url] options:@{} completionHandler:nil];
}
@end

void RBPresentCanvasShare(UIViewController *presenter, NSDictionary *canvas, void (^changed)(NSDictionary *)) {
  if (![canvas isKindOfClass:NSDictionary.class] || !presenter) return;
  RBCanvasShareController *vc = [RBCanvasShareController new];
  vc.canvas = canvas;
  vc.changed = changed;
  vc.modalPresentationStyle = UIModalPresentationPageSheet;
  UISheetPresentationController *sheet = vc.sheetPresentationController;
  sheet.detents = @[ UISheetPresentationControllerDetent.mediumDetent, UISheetPresentationControllerDetent.largeDetent ];
  sheet.prefersGrabberVisible = YES;
  sheet.preferredCornerRadius = 22;
  [presenter presentViewController:vc animated:YES completion:nil];
}

#pragma mark - Stage

@interface RBCanvasStage : UIViewController <WKNavigationDelegate>
@property(nonatomic, copy) NSString *canvasId;
@property(nonatomic, copy) NSString *initialTitle;
@property(nonatomic, copy) NSDictionary *canvas;
@property(nonatomic, strong) WKWebView *web;
@property(nonatomic, strong) UILabel *titleLabel;
@property(nonatomic, strong) UIButton *mark;
@property(nonatomic, strong) UIButton *share;
@property(nonatomic, strong) UILabel *message;
@property(nonatomic) NSInteger generation;
@end

static WKContentRuleList *RBCanvasRules;

@implementation RBCanvasStage
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = RBThemeChrome();
  self.view.accessibilityIdentifier = @"canvas_stage";
  UIButton *back = RBCanvasButton(@"back", nil, NO, self, @selector(close));
  back.accessibilityLabel = RBL(@"返回聊天", @"Back to chat");
  UIImageView *glyph = [[UIImageView alloc] initWithImage:RBCanvasIcon(@"page", 16)];
  glyph.tintColor = RBThemeTextSecondary();
  glyph.contentMode = UIViewContentModeCenter;
  glyph.backgroundColor = RBThemeSecondaryFill();
  glyph.layer.cornerRadius = 7;
  self.titleLabel = [UILabel new];
  self.titleLabel.font = RBThemeFont(16, UIFontWeightSemibold);
  self.titleLabel.textColor = RBThemeTextPrimary();
  self.titleLabel.text = self.initialTitle.length ? self.initialTitle : RBL(@"画布", @"Canvas");
  [self.titleLabel setContentCompressionResistancePriority:UILayoutPriorityDefaultLow forAxis:UILayoutConstraintAxisHorizontal];
  self.mark = [UIButton buttonWithType:UIButtonTypeSystem];
  self.mark.userInteractionEnabled = NO;
  self.mark.hidden = YES;
  UIButton *refresh = RBCanvasButton(@"refresh", nil, NO, self, @selector(load));
  refresh.accessibilityLabel = RBL(@"刷新", @"Refresh");
  self.share = RBCanvasButton(@"share", RBL(@"分享", @"Share"), NO, self, @selector(openShare));
  self.share.enabled = NO;
  UIButton *close = RBCanvasButton(@"close", nil, NO, self, @selector(close));
  close.accessibilityLabel = RBL(@"关闭", @"Close");
  UIStackView *bar = [[UIStackView alloc] initWithArrangedSubviews:@[ back, glyph, self.titleLabel, self.mark, refresh, self.share, close ]];
  bar.spacing = 6;
  bar.alignment = UIStackViewAlignmentCenter;
  [bar setCustomSpacing:8 afterView:glyph];
  [glyph.widthAnchor constraintEqualToConstant:28].active = YES;
  [glyph.heightAnchor constraintEqualToConstant:28].active = YES;
  UIView *line = [UIView new];
  line.backgroundColor = RBThemeBorder();

  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
  config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
  if (RBCanvasRules) [config.userContentController addContentRuleList:RBCanvasRules];
  self.web = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
  self.web.navigationDelegate = self;
  self.web.opaque = NO;
  self.web.backgroundColor = RBThemeChrome();
  self.web.accessibilityIdentifier = @"canvas_webview";
  self.message = [UILabel new];
  self.message.numberOfLines = 0;
  self.message.textAlignment = NSTextAlignmentCenter;
  self.message.font = RBThemeFont(14, UIFontWeightRegular);
  self.message.textColor = RBThemeTextSecondary();
  for (UIView *v in @[ bar, line, self.web, self.message ]) { v.translatesAutoresizingMaskIntoConstraints = NO; [self.view addSubview:v]; }
  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [bar.topAnchor constraintEqualToAnchor:safe.topAnchor constant:6],
    [bar.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:8],
    [bar.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-8],
    [bar.heightAnchor constraintEqualToConstant:44],
    [line.topAnchor constraintEqualToAnchor:bar.bottomAnchor constant:6],
    [line.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [line.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [line.heightAnchor constraintEqualToConstant:1.0 / UIScreen.mainScreen.scale],
    [self.web.topAnchor constraintEqualToAnchor:line.bottomAnchor],
    [self.web.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [self.web.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [self.web.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [self.message.centerYAnchor constraintEqualToAnchor:self.web.centerYAnchor],
    [self.message.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:32],
    [self.message.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-32],
  ]];
  [self load];
}
- (void)close { [self dismissViewControllerAnimated:YES completion:nil]; }
- (void)applyCanvas:(NSDictionary *)canvas {
  self.canvas = canvas;
  if ([canvas[@"title"] isKindOfClass:NSString.class]) self.titleLabel.text = canvas[@"title"];
  BOOL isPublic = [canvas[@"visibility"] isEqual:@"public"];
  UIButtonConfiguration *c = UIButtonConfiguration.filledButtonConfiguration;
  c.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  c.image = RBCanvasIcon(isPublic ? @"globe" : @"lock", 12);
  c.imagePadding = 4;
  c.contentInsets = NSDirectionalEdgeInsetsMake(3, 8, 3, 9);
  c.attributedTitle = [[NSAttributedString alloc] initWithString:RBCanvasVisibilityLabel(canvas[@"visibility"]) attributes:@{NSFontAttributeName : RBThemeFont(12, UIFontWeightMedium)}];
  c.baseForegroundColor = isPublic ? RBCanvasOk() : RBThemeTextSecondary();
  c.baseBackgroundColor = isPublic ? [RBCanvasOk() colorWithAlphaComponent:0.12] : RBThemeSecondaryFill();
  self.mark.configuration = c;
  self.mark.hidden = NO;
  self.mark.accessibilityIdentifier = [@"canvas_visibility_" stringByAppendingString:isPublic ? @"public" : @"private"];
  self.share.enabled = YES;
}
- (void)showMessage:(NSString *)text {
  self.message.text = text;
  self.message.hidden = text == nil;
  self.web.hidden = text != nil;
}
- (void)load {
  NSInteger gen = ++self.generation;
  NSString *canvasId = self.canvasId;
  [self showMessage:RBL(@"正在打开画布…", @"Opening canvas…")];
  RBHostRequest(@"GET", [@"/local/canvases/" stringByAppendingString:canvasId], nil, 20, ^(NSInteger status, id json, NSError *error) {
    if (gen != self.generation) return;
    if (status == 200 && [json[@"canvas"] isKindOfClass:NSDictionary.class]) [self applyCanvas:json[@"canvas"]];
    else if (status == 404) { [self showMessage:RBL(@"这个画布已被删除，或者不在当前连接的 Host 上。", @"This canvas was deleted or is not on the connected Host.")]; return; }
  });
  NSString *base = RBConnection.shared.serverURL, *token = RBConnection.shared.deviceToken;
  BOOL dark = self.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
  NSURL *url = base.length ? [NSURL URLWithString:[NSString stringWithFormat:@"%@/canvas/app/%@/frame?theme=%@", base, canvasId, dark ? @"dark" : @"light"]] : nil;
  if (!url || !token.length) { [self showMessage:RBL(@"请先连接 Host。", @"Connect to Host first.")]; return; }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.timeoutInterval = 30;
  [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [request setValue:@"text/html" forHTTPHeaderField:@"Accept"];
  [[RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    NSInteger code = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
    NSString *html = code == 200 && data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (gen != self.generation) return;
      if (!html) {
        [self showMessage:code == 404 ? RBL(@"这个画布已被删除，或者不在当前连接的 Host 上。", @"This canvas was deleted or is not on the connected Host.")
                                      : RBL(@"无法打开画布，请检查与 Host 的连接后点刷新。", @"Could not open the canvas. Check the Host connection and tap Refresh.")];
        return;
      }
      [self showMessage:nil];
      // Without the response headers the sandbox CSP becomes a meta CSP (scripts by nonce, no network).
      NSRange nonce = [html rangeOfString:@"<script nonce=\"" options:0];
      NSString *scripts = @"'none'";
      if (nonce.location != NSNotFound) {
        NSUInteger start = NSMaxRange(nonce);
        NSRange end = [html rangeOfString:@"\"" options:0 range:NSMakeRange(start, MIN((NSUInteger)80, html.length - start))];
        if (end.location != NSNotFound) scripts = [NSString stringWithFormat:@"'nonce-%@'", [html substringWithRange:NSMakeRange(start, end.location - start)]];
      }
      NSString *meta = [NSString stringWithFormat:@"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src %@; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'\">", scripts];
      NSRange head = [html rangeOfString:@"<head>"];
      NSString *page = head.location != NSNotFound ? [html stringByReplacingCharactersInRange:head withString:[@"<head>" stringByAppendingString:meta]] : [meta stringByAppendingString:html];
      // A base URL on a reserved domain: no cookies or storage of the Host's origin.
      [self.web loadHTMLString:page baseURL:[NSURL URLWithString:@"https://canvas.rokbot.invalid/"]];
    });
  }] resume];
}
- (void)openShare {
  if (!self.canvas) return;
  __weak typeof(self) weak = self;
  RBPresentCanvasShare(self, self.canvas, ^(NSDictionary *next) { [weak applyCanvas:next]; });
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  NSURL *url = action.request.URL;
  if ([url.host isEqual:@"canvas.rokbot.invalid"] || [url.scheme isEqual:@"about"]) { decisionHandler(WKNavigationActionPolicyAllow); return; }
  decisionHandler(WKNavigationActionPolicyCancel);
  // Links in the canvas leave for the browser only after a tap; canvas links stay in the app.
  if (action.navigationType == WKNavigationTypeLinkActivated && ([url.scheme isEqual:@"http"] || [url.scheme isEqual:@"https"])) {
    if (!RBOpenCanvasURL(url)) [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
  }
}
@end

void RBPresentCanvas(NSString *canvasId, NSString *title) {
  if (!RBCanvasIsId(canvasId)) return;
  // The canvas makes no network loads: block them all before the first page.
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [WKContentRuleListStore.defaultStore compileContentRuleListForIdentifier:@"rokbot-canvas-offline"
        encodedContentRuleList:@"[{\"trigger\":{\"url-filter\":\"^(https?|wss?|ftp)://\"},\"action\":{\"type\":\"block\"}}]"
             completionHandler:^(WKContentRuleList *list, NSError *error) { RBCanvasRules = list; }];
  });
  dispatch_async(dispatch_get_main_queue(), ^{
    RBCanvasStage *stage = [RBCanvasStage new];
    stage.canvasId = canvasId.lowercaseString;
    stage.initialTitle = title;
    stage.modalPresentationStyle = UIModalPresentationFullScreen;
    RBDiagnosticsEvent(@"canvas.open", @{@"canvasId" : canvasId});
    [RBCanvasTop() presentViewController:stage animated:YES completion:nil];
  });
}

BOOL RBOpenCanvasURL(NSURL *url) {
  NSString *canvasId = RBCanvasAppLinkId(url);
  if (!canvasId || !RBConnection.shared.deviceToken.length) return NO;
  RBPresentCanvas(canvasId, nil);
  return YES;
}
