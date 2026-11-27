// The usage report (GET /local/usage/report, docs/usage-report.md): range, filters, totals with
// the change against the previous range, token mix, trend, breakdowns and the requests, plus a
// CSV export. A Host without the report (404) falls back to today's totals from /local/usage.
#import "RBUsage.h"
#import <QuartzCore/QuartzCore.h>
#import "RBChoiceSheet.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBLocalize.h"
#import "RBTheme.h"

static NSString *const RBUNone = @"(none)";
static const NSInteger RBUPageSize = 20;

#pragma mark - Values and formatting

static BOOL RBUHas(id value) { return [value isKindOfClass:NSNumber.class]; }
static double RBUNum(id value) { return RBUHas(value) ? [value doubleValue] : 0; }
static NSString *RBUStr(id value) { return [value isKindOfClass:NSString.class] && [value length] ? value : nil; }
static NSDictionary *RBUDict(id value) { return [value isKindOfClass:NSDictionary.class] ? value : nil; }
static NSArray *RBUArray(id value) { return [value isKindOfClass:NSArray.class] ? value : @[]; }
static NSString *RBUMissing(void) { return RBL(@"未记录", @"Not recorded"); }

static NSString *RBUExact(double value) {
  static NSNumberFormatter *zh, *en;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    zh = [NSNumberFormatter new]; zh.numberStyle = NSNumberFormatterDecimalStyle; zh.maximumFractionDigits = 0;
    zh.locale = [NSLocale localeWithLocaleIdentifier:@"zh_CN"];
    en = [NSNumberFormatter new]; en.numberStyle = NSNumberFormatterDecimalStyle; en.maximumFractionDigits = 0;
    en.locale = [NSLocale localeWithLocaleIdentifier:@"en_US"];
  });
  return [(RBIsChinese() ? zh : en) stringFromNumber:@(round(value))] ?: @"0";
}

static NSString *RBUTrim(double value, int digits) {
  NSString *text = [NSString stringWithFormat:@"%.*f", digits, value];
  if ([text containsString:@"."]) {
    while ([text hasSuffix:@"0"]) text = [text substringToIndex:text.length - 1];
    if ([text hasSuffix:@"."]) text = [text substringToIndex:text.length - 1];
  }
  return text;
}

// Same rules as host/server/public/usage-format.js: 1.23 万 / 3.2 亿, 12.3K / 320M.
static NSString *RBUCount(double value) {
  BOOL zh = RBIsChinese();
  double size = fabs(round(value));
  NSString *sign = value < 0 && size > 0 ? @"-" : @"";
  const double zhUnits[] = {1e4, 1e8, 1e12}, enUnits[] = {1e3, 1e6, 1e9, 1e12};
  NSArray<NSString *> *suffixes = zh ? @[@"万", @"亿", @"万亿"] : @[@"K", @"M", @"B", @"T"];
  const double *units = zh ? zhUnits : enUnits;
  NSInteger count = (NSInteger)suffixes.count;
  if (size < units[0]) return [sign stringByAppendingString:RBUExact(size)];
  for (NSInteger index = count - 1; index >= 0; index--) {
    if (size < units[index]) continue;
    double scaled = size / units[index];
    int digits = scaled < 10 ? 2 : 1;
    double rounded = round(scaled * pow(10, digits)) / pow(10, digits);
    if (index + 1 < count && rounded * units[index] >= units[index + 1])
      return RBUCount(value < 0 ? -units[index + 1] : units[index + 1]);
    return [NSString stringWithFormat:@"%@%@%@%@", sign, RBUTrim(rounded, digits), zh ? @" " : @"", suffixes[(NSUInteger)index]];
  }
  return [sign stringByAppendingString:RBUExact(size)];
}

static NSString *RBUDuration(id value) {
  if (!RBUHas(value)) return RBUMissing();
  double ms = [value doubleValue];
  if (ms < 1000) return [NSString stringWithFormat:@"%.0f ms", ms];
  if (ms < 60000) return [NSString stringWithFormat:@"%@ s", RBUTrim(ms / 1000, ms < 10000 ? 2 : 1)];
  long seconds = lround(ms / 1000);
  return RBIsChinese() ? [NSString stringWithFormat:@"%ld 分 %ld 秒", seconds / 60, seconds % 60]
                       : [NSString stringWithFormat:@"%ldm %lds", seconds / 60, seconds % 60];
}

static NSString *RBURate(id value) {
  if (!RBUHas(value)) return RBUMissing();
  double rate = [value doubleValue] * 100;
  return [NSString stringWithFormat:@"%@%%", RBUTrim(rate, rate > 0 && rate < 10 ? 2 : 1)];
}

// The report's currency (ISO 4217, from the Host's usage-prices.json), or nil for a plain number.
static NSString *RBUCurrency;
static NSString *RBUCost(id value) {
  if (!RBUHas(value)) return RBUMissing();
  double cost = [value doubleValue];
  if (RBUCurrency.length == 3) {
    NSNumberFormatter *format = [NSNumberFormatter new];
    format.numberStyle = NSNumberFormatterCurrencyStyle;
    format.currencyCode = RBUCurrency;
    format.minimumFractionDigits = 2;
    format.maximumFractionDigits = cost > 0 && cost < 1 ? 4 : 2;
    NSString *text = [format stringFromNumber:@(cost)];
    if (text.length) return text;
  }
  return [NSString stringWithFormat:@"%.*f", cost > 0 && cost < 1 ? 4 : 2, cost];
}

static NSString *RBUChangeText(id value) {
  if (!RBUHas(value)) return nil;
  double change = [value doubleValue] * 100;
  if (fabs(change) < 0.05) return @"0%";
  return [NSString stringWithFormat:@"%@%@%%", change > 0 ? @"+" : @"−", RBUTrim(fabs(change), 1)];
}

static NSString *RBUKindLabel(NSString *key) {
  static NSDictionary<NSString *, NSArray<NSString *> *> *names;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    names = @{ @"chat": @[@"对话", @"Chat"], @"suggestions": @[@"输入建议", @"Suggestions"],
               @"completion": @[@"输入补全", @"Completion"], @"autocomplete": @[@"输入补全", @"Completion"],
               @"title": @[@"标题", @"Titles"], @"test": @[@"测试", @"Tests"], @"summary": @[@"摘要", @"Summaries"],
               @"memory": @[@"记忆", @"Memory"], @"subagent": @[@"子任务", @"Subagents"],
               @"automation": @[@"自动化", @"Automations"], @"classifier": @[@"路由判断", @"Routing"],
               @"review": @[@"自动审查", @"Auto review"] };
  });
  NSArray<NSString *> *pair = names[key];
  return pair ? RBL(pair[0], pair[1]) : key;
}

static NSString *RBUStatusLabel(NSString *key) {
  if ([key isEqual:@"ok"]) return RBL(@"成功", @"Succeeded");
  if ([key isEqual:@"error"]) return RBL(@"失败", @"Failed");
  if ([key isEqual:@"cancelled"]) return RBL(@"已取消", @"Cancelled");
  return key;
}

static NSArray<NSString *> *RBUDimensions(void) { return @[@"model", @"provider", @"profile", @"kind", @"agent"]; }
static NSArray<NSString *> *RBUFilterKeys(void) { return @[@"model", @"provider", @"profile", @"kind", @"agent", @"status"]; }
static NSString *RBUDimensionName(NSString *dimension) {
  if ([dimension isEqual:@"model"]) return RBL(@"模型", @"Model");
  if ([dimension isEqual:@"provider"]) return RBL(@"服务商", @"Provider");
  if ([dimension isEqual:@"profile"]) return RBL(@"配置", @"Profile");
  if ([dimension isEqual:@"kind"]) return RBL(@"场景", @"Scene");
  if ([dimension isEqual:@"agent"]) return @"Bot";
  return RBL(@"状态", @"Status");
}

// The display name of a breakdown key: "(none)" is "not recorded", scenes and statuses are translated.
static NSString *RBUValueLabel(NSString *dimension, NSString *key, id label) {
  if (!key.length || [key isEqual:RBUNone]) return RBUMissing();
  if ([dimension isEqual:@"kind"]) return RBUKindLabel(key);
  if ([dimension isEqual:@"status"]) return RBUStatusLabel(key);
  return RBUStr(label) ?: key;
}

#pragma mark - Dates

static NSDateFormatter *RBUFormatter(NSString *format, NSTimeZone *zone) {
  NSDateFormatter *formatter = [NSDateFormatter new];
  formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  formatter.calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
  formatter.timeZone = zone;
  formatter.dateFormat = format;
  return formatter;
}

static NSDate *RBUParseDay(NSString *day) {
  if (day.length < 7) return nil;
  NSString *text = day.length == 7 ? [day stringByAppendingString:@"-01"] : [day substringToIndex:10];
  return [RBUFormatter(@"yyyy-MM-dd", [NSTimeZone timeZoneForSecondsFromGMT:0]) dateFromString:text];
}

static NSString *RBUDayText(NSDate *date, NSString *template) {
  if (!date) return @"";
  NSDateFormatter *formatter = [NSDateFormatter new];
  formatter.locale = [NSLocale localeWithLocaleIdentifier:RBIsChinese() ? @"zh_CN" : @"en_US"];
  formatter.calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  [formatter setLocalizedDateFormatFromTemplate:template];
  return [formatter stringFromDate:date];
}

// "11月21日" (with the year when it is not this year's), for "YYYY-MM-DD".
static NSString *RBUDay(NSString *day, NSString *today) {
  BOOL sameYear = day.length >= 4 && today.length >= 4 && [[day substringToIndex:4] isEqual:[today substringToIndex:4]];
  return RBUDayText(RBUParseDay(day), sameYear ? @"MMMd" : @"yMMMd");
}

// A bucket start ("2026-11-27T13", "2026-11-21", "2026-11"), short for the axis or long for the tip.
static NSString *RBUBucketLabel(NSString *start, NSString *unit, BOOL full) {
  if (!start.length) return @"";
  if ([unit isEqual:@"hour"] && start.length >= 13) {
    NSInteger hour = [[start substringWithRange:NSMakeRange(11, 2)] integerValue];
    return full ? [NSString stringWithFormat:@"%02ld:00–%02ld:00", (long)hour, (long)(hour + 1) % 24]
                : [NSString stringWithFormat:@"%02ld:00", (long)hour];
  }
  if ([unit isEqual:@"month"]) return RBUDayText(RBUParseDay(start), full ? @"yMMMM" : @"yMMM");
  return RBUDayText(RBUParseDay(start), full ? @"yMMMdEEE" : @"Md");
}

static NSDate *RBUParseInstant(NSString *text) {
  if (!text.length) return nil;
  static NSISO8601DateFormatter *fractional, *plain;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    fractional = [NSISO8601DateFormatter new];
    fractional.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    plain = [NSISO8601DateFormatter new];
  });
  return [fractional dateFromString:text] ?: [plain dateFromString:text];
}

#pragma mark - Colours

static UIColor *RBUHex(uint32_t hex) {
  return [UIColor colorWithRed:((hex >> 16) & 0xff) / 255.0 green:((hex >> 8) & 0xff) / 255.0 blue:(hex & 0xff) / 255.0 alpha:1];
}
static UIColor *RBUDynamic(uint32_t light, uint32_t dark) {
  UIColor *lightColor = RBUHex(light), *darkColor = RBUHex(dark);
  return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *traits) {
    return traits.userInterfaceStyle == UIUserInterfaceStyleDark ? darkColor : lightColor;
  }];
}
// Series colours of host/server/public/usage-charts.css (--rok-usage-c0…c7), light and dark.
static UIColor *RBUSeries(NSInteger index) {
  static NSArray<UIColor *> *colors;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    colors = @[RBUDynamic(0xa9a8a2, 0x6b6a65), RBUDynamic(0x2a78d6, 0x3987e5), RBUDynamic(0xeb6834, 0xd95926),
               RBUDynamic(0x1baf7a, 0x199e70), RBUDynamic(0xeda100, 0xc98500), RBUDynamic(0xe87ba4, 0xd55181),
               RBUDynamic(0x008300, 0x008300), RBUDynamic(0x6250d6, 0x9085e9)];
  });
  return colors[(NSUInteger)(index >= 1 && index <= 7 ? index : 0)];
}
static UIColor *RBUFailColor(void) { return RBUDynamic(0xd23f31, 0xe5534b); }
static UIColor *RBUWarnColor(void) { return RBUDynamic(0xc4371f, 0xf0705f); }
static UIColor *RBUGoodColor(void) { return RBUDynamic(0x0f8a5f, 0x3fbf8a); }
static UIColor *RBUSurface(void) { return UIColor.secondarySystemGroupedBackgroundColor; }
static UIColor *RBUWash(void) { return UIColor.tertiarySystemFillColor; }

#pragma mark - Small views

static UILabel *RBULabel(NSString *text, CGFloat size, UIFontWeight weight, UIColor *color) {
  UILabel *label = [UILabel new];
  label.text = text;
  label.font = [UIFont systemFontOfSize:size weight:weight];
  label.textColor = color;
  label.adjustsFontForContentSizeCategory = YES;
  return label;
}
static UILabel *RBUNumberLabel(NSString *text, CGFloat size, UIFontWeight weight) {
  UILabel *label = RBULabel(text, size, weight, UIColor.labelColor);
  label.font = [UIFont monospacedDigitSystemFontOfSize:size weight:weight];
  label.adjustsFontSizeToFitWidth = YES;
  label.minimumScaleFactor = 0.6;
  return label;
}
static UIStackView *RBUStack(UILayoutConstraintAxis axis, CGFloat spacing, NSArray<UIView *> *views) {
  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:views];
  stack.axis = axis;
  stack.spacing = spacing;
  if (axis == UILayoutConstraintAxisHorizontal) stack.alignment = UIStackViewAlignmentCenter;
  return stack;
}
static UIView *RBUSpacer(void) {
  UIView *view = [UIView new];
  [view setContentHuggingPriority:1 forAxis:UILayoutConstraintAxisHorizontal];
  [view setContentCompressionResistancePriority:1 forAxis:UILayoutConstraintAxisHorizontal];
  return view;
}
static UIView *RBUHairline(void) {
  UIView *line = [UIView new];
  line.backgroundColor = UIColor.separatorColor;
  [line.heightAnchor constraintEqualToConstant:1 / UIScreen.mainScreen.scale].active = YES;
  return line;
}
static UIView *RBUDot(UIColor *color, CGFloat size) {
  UIView *dot = [UIView new];
  dot.backgroundColor = color;
  dot.layer.cornerRadius = size / 4;
  [dot.widthAnchor constraintEqualToConstant:size].active = YES;
  [dot.heightAnchor constraintEqualToConstant:size].active = YES;
  return dot;
}

@interface RBUCard : UIView
@property(nonatomic, readonly) UIStackView *stack;
@end
@implementation RBUCard
- (instancetype)initWithSpacing:(CGFloat)spacing {
  if (!(self = [super initWithFrame:CGRectZero])) return nil;
  self.backgroundColor = RBUSurface();
  self.layer.cornerRadius = 14;
  self.layer.cornerCurve = kCACornerCurveContinuous;
  _stack = RBUStack(UILayoutConstraintAxisVertical, spacing, @[]);
  _stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self addSubview:_stack];
  [NSLayoutConstraint activateConstraints:@[
    [_stack.topAnchor constraintEqualToAnchor:self.topAnchor constant:14],
    [_stack.bottomAnchor constraintEqualToAnchor:self.bottomAnchor constant:-14],
    [_stack.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:14],
    [_stack.trailingAnchor constraintEqualToAnchor:self.trailingAnchor constant:-14],
  ]];
  return self;
}
@end

static UIButton *RBUPillButton(NSString *title, BOOL filled) {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  [button setTitle:title forState:UIControlStateNormal];
  button.titleLabel.font = [UIFont systemFontOfSize:14 weight:UIFontWeightMedium];
  button.titleLabel.adjustsFontForContentSizeCategory = YES;
  button.tintColor = filled ? UIColor.systemBackgroundColor : UIColor.labelColor;
  button.backgroundColor = filled ? UIColor.labelColor : RBUWash();
  button.contentEdgeInsets = UIEdgeInsetsMake(7, 14, 7, 14);
  button.layer.cornerRadius = 16;
  button.layer.cornerCurve = kCACornerCurveContinuous;
  [button.heightAnchor constraintGreaterThanOrEqualToConstant:32].active = YES;
  return button;
}

static RBSegmentControl *RBUSegments(NSArray<NSString *> *titles, NSInteger selected) {
  RBSegmentControl *control = [[RBSegmentControl alloc] initWithItems:titles];
  control.selectedSegmentIndex = selected;
  return control;
}

// A pulsing placeholder block for the loading skeleton.
static UIView *RBUSkeleton(CGFloat height) {
  UIView *view = [UIView new];
  view.backgroundColor = RBUWash();
  view.layer.cornerRadius = 12;
  view.layer.cornerCurve = kCACornerCurveContinuous;
  [view.heightAnchor constraintEqualToConstant:height].active = YES;
  if (!UIAccessibilityIsReduceMotionEnabled()) {
    CABasicAnimation *pulse = [CABasicAnimation animationWithKeyPath:@"opacity"];
    pulse.fromValue = @1; pulse.toValue = @0.45; pulse.duration = 0.9;
    pulse.autoreverses = YES; pulse.repeatCount = HUGE_VALF;
    pulse.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
    [view.layer addAnimation:pulse forKey:@"pulse"];
  }
  view.isAccessibilityElement = YES;
  view.accessibilityLabel = RBL(@"正在加载", @"Loading");
  return view;
}

// "● name  ● name" legend that wraps.
static UILabel *RBULegend(NSArray<NSArray *> *items) {
  NSMutableAttributedString *text = [NSMutableAttributedString new];
  UIFont *font = [UIFont systemFontOfSize:12];
  for (NSArray *item in items) {
    if (text.length) [text appendAttributedString:[[NSAttributedString alloc] initWithString:@"    " attributes:@{NSFontAttributeName: font}]];
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:@"● " attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: item[1]}]];
    // Keep each bullet with its name when the legend wraps.
    NSString *name = [[item[0] stringByReplacingOccurrencesOfString:@" " withString:@" "] stringByReplacingOccurrencesOfString:@"-" withString:@"‑"];
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:name attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: UIColor.secondaryLabelColor}]];
  }
  NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
  paragraph.lineSpacing = 4;
  [text addAttribute:NSParagraphStyleAttributeName value:paragraph range:NSMakeRange(0, text.length)];
  UILabel *label = [UILabel new];
  label.attributedText = text;
  label.numberOfLines = 0;
  return label;
}

#pragma mark - Stacked bar and donut

// Horizontal stacked bar: segments are @[value, colour].
@interface RBUStackBar : UIView
@property(nonatomic, copy) NSArray<NSArray *> *segments;
@end
@implementation RBUStackBar
- (void)drawRect:(CGRect)rect {
  CGRect bounds = self.bounds;
  [[UIBezierPath bezierPathWithRoundedRect:bounds cornerRadius:bounds.size.height / 2] addClip];
  [RBUWash() setFill];
  UIRectFill(bounds);
  double sum = 0;
  for (NSArray *segment in self.segments) sum += RBUNum(segment[0]);
  if (sum <= 0) return;
  CGFloat x = 0;
  for (NSArray *segment in self.segments) {
    CGFloat width = (CGFloat)(RBUNum(segment[0]) / sum) * bounds.size.width;
    if (width <= 0) continue;
    [(UIColor *)segment[1] setFill];
    UIRectFill(CGRectMake(x, 0, width, bounds.size.height));
    x += width;
    if (x < bounds.size.width - 1) { [RBUSurface() setFill]; UIRectFill(CGRectMake(x, 0, 1.5, bounds.size.height)); x += 1.5; }
  }
}
- (void)traitCollectionDidChange:(UITraitCollection *)previous { [super traitCollectionDidChange:previous]; [self setNeedsDisplay]; }
@end

@interface RBUDonut : UIView
@property(nonatomic, copy) NSArray<NSArray *> *segments;
@property(nonatomic, copy) NSString *title, *value;
@end
@implementation RBUDonut
- (void)drawRect:(CGRect)rect {
  CGRect bounds = self.bounds;
  CGFloat line = 18, radius = MIN(bounds.size.width, bounds.size.height) / 2 - line / 2 - 1;
  CGPoint center = CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds));
  UIBezierPath *track = [UIBezierPath bezierPathWithArcCenter:center radius:radius startAngle:0 endAngle:2 * M_PI clockwise:YES];
  track.lineWidth = line;
  [RBUWash() setStroke];
  [track stroke];
  double sum = 0;
  for (NSArray *segment in self.segments) sum += RBUNum(segment[0]);
  if (sum > 0) {
    CGFloat angle = -M_PI_2, gap = self.segments.count > 1 ? 0.025 : 0;
    for (NSArray *segment in self.segments) {
      CGFloat sweep = (CGFloat)(RBUNum(segment[0]) / sum) * 2 * M_PI;
      if (sweep <= 0) continue;
      CGFloat drawn = MAX(sweep - gap, 0.004);
      UIBezierPath *arc = [UIBezierPath bezierPathWithArcCenter:center radius:radius startAngle:angle endAngle:angle + drawn clockwise:YES];
      arc.lineWidth = line;
      [(UIColor *)segment[1] setStroke];
      [arc stroke];
      angle += sweep;
    }
  }
  NSDictionary *valueAttributes = @{NSFontAttributeName: [UIFont monospacedDigitSystemFontOfSize:17 weight:UIFontWeightSemibold],
                                    NSForegroundColorAttributeName: UIColor.labelColor};
  NSDictionary *titleAttributes = @{NSFontAttributeName: [UIFont systemFontOfSize:11], NSForegroundColorAttributeName: UIColor.secondaryLabelColor};
  CGSize valueSize = [self.value ?: @"" sizeWithAttributes:valueAttributes], titleSize = [self.title ?: @"" sizeWithAttributes:titleAttributes];
  CGFloat top = center.y - (valueSize.height + titleSize.height) / 2;
  [self.title ?: @"" drawAtPoint:CGPointMake(center.x - titleSize.width / 2, top) withAttributes:titleAttributes];
  [self.value ?: @"" drawAtPoint:CGPointMake(center.x - valueSize.width / 2, top + titleSize.height) withAttributes:valueAttributes];
}
- (void)traitCollectionDidChange:(UITraitCollection *)previous { [super traitCollectionDidChange:previous]; [self setNeedsDisplay]; }
@end

#pragma mark - Trend chart

typedef NS_ENUM(NSInteger, RBUTrendMode) { RBUTrendModel = 0, RBUTrendType = 1, RBUTrendRequests = 2 };

@interface RBUTrend : UIView <UIGestureRecognizerDelegate>
@property(nonatomic, copy) NSArray<NSDictionary *> *buckets;
@property(nonatomic, copy) NSArray<NSString *> *series;
@property(nonatomic, copy) NSString *unit;
@property(nonatomic) RBUTrendMode mode;
@property(nonatomic) NSInteger selected;
@property(nonatomic, strong) NSArray<NSArray<NSArray *> *> *stacks; // per bucket: @[value, colour, name]
@property(nonatomic) double top;
@property(nonatomic, strong) UIView *tip;
@property(nonatomic, strong) UILabel *tipLabel;
@end

@implementation RBUTrend
- (instancetype)initWithFrame:(CGRect)frame {
  if (!(self = [super initWithFrame:frame])) return nil;
  self.backgroundColor = UIColor.clearColor;
  self.contentMode = UIViewContentModeRedraw;
  _selected = -1;
  [self addGestureRecognizer:[[UITapGestureRecognizer alloc] initWithTarget:self action:@selector(touched:)]];
  UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(touched:)];
  pan.delegate = self;
  [self addGestureRecognizer:pan];
  _tip = [UIView new];
  _tip.backgroundColor = UIColor.tertiarySystemBackgroundColor;
  _tip.layer.cornerRadius = 10;
  _tip.layer.shadowColor = UIColor.blackColor.CGColor;
  _tip.layer.shadowOpacity = 0.14;
  _tip.layer.shadowRadius = 8;
  _tip.layer.shadowOffset = CGSizeMake(0, 2);
  _tip.hidden = YES;
  _tip.userInteractionEnabled = NO;
  _tipLabel = [UILabel new];
  _tipLabel.numberOfLines = 0;
  [_tip addSubview:_tipLabel];
  [self addSubview:_tip];
  self.isAccessibilityElement = YES;
  self.accessibilityTraits = UIAccessibilityTraitImage;
  return self;
}
- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)recognizer {
  if (![recognizer isKindOfClass:UIPanGestureRecognizer.class]) return YES;
  CGPoint velocity = [(UIPanGestureRecognizer *)recognizer velocityInView:self];
  return fabs(velocity.x) > fabs(velocity.y);
}
- (CGRect)plot {
  return CGRectMake(46, 10, MAX(self.bounds.size.width - 50, 1), MAX(self.bounds.size.height - 32, 1));
}
- (void)prepare {
  NSMutableArray *stacks = [NSMutableArray array];
  double top = 0;
  NSString *others = RBL(@"其他模型", @"Other models");
  for (NSDictionary *bucket in self.buckets) {
    NSMutableArray *stack = [NSMutableArray array];
    if (self.mode == RBUTrendModel) {
      NSMutableDictionary<NSString *, NSNumber *> *models = [NSMutableDictionary dictionary];
      for (NSDictionary *item in RBUArray(bucket[@"models"])) {
        NSString *name = RBUStr(RBUDict(item)[@"model"]) ?: RBUNone;
        models[name] = @(models[name].doubleValue + RBUNum(RBUDict(item)[@"total"]));
      }
      double rest = 0;
      for (NSString *name in models) if (![self.series containsObject:name]) rest += models[name].doubleValue;
      [self.series enumerateObjectsUsingBlock:^(NSString *name, NSUInteger index, BOOL *stop) {
        [stack addObject:@[models[name] ?: @0, RBUSeries((NSInteger)index + 1), RBUValueLabel(@"model", name, nil)]];
      }];
      // Older buckets without "models" still show their total.
      if (!models.count && RBUNum(bucket[@"total"]) > 0) rest = RBUNum(bucket[@"total"]);
      [stack addObject:@[@(rest), RBUSeries(0), others]];
    } else if (self.mode == RBUTrendType) {
      double input = RBUNum(bucket[@"input"]), cached = RBUNum(bucket[@"cached"]);
      [stack addObject:@[@(cached), RBUSeries(3), RBL(@"缓存命中", @"Cache read")]];
      [stack addObject:@[@(MAX(0, input - cached)), RBUSeries(1), RBL(@"未命中输入", @"Uncached input")]];
      [stack addObject:@[@(RBUNum(bucket[@"output"])), RBUSeries(2), RBL(@"输出", @"Output")]];
    } else {
      double requests = RBUNum(bucket[@"requests"]), failed = MIN(RBUNum(bucket[@"failed"]), requests);
      [stack addObject:@[@(requests - failed), RBUSeries(1), RBL(@"成功及其他", @"Other requests")]];
      [stack addObject:@[@(failed), RBUFailColor(), RBL(@"失败", @"Failed")]];
    }
    double sum = 0;
    for (NSArray *segment in stack) sum += RBUNum(segment[0]);
    top = MAX(top, sum);
    [stacks addObject:stack];
  }
  // A round axis maximum: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^n.
  if (top > 0) {
    double magnitude = pow(10, floor(log10(top))), nice = magnitude;
    for (NSNumber *step in @[@1, @1.5, @2, @2.5, @3, @4, @5, @6, @8, @10]) { nice = step.doubleValue * magnitude; if (nice >= top) break; }
    top = nice;
  }
  self.stacks = stacks;
  self.top = top;
  self.selected = -1;
  self.tip.hidden = YES;
  double total = 0;
  for (NSDictionary *bucket in self.buckets) total += RBUNum(self.mode == RBUTrendRequests ? bucket[@"requests"] : bucket[@"total"]);
  self.accessibilityLabel = [NSString stringWithFormat:@"%@, %@ %@", RBL(@"趋势图", @"Trend chart"),
      self.mode == RBUTrendRequests ? RBL(@"请求", @"Requests") : @"Token", RBUCount(total)];
  [self setNeedsDisplay];
}
- (void)drawRect:(CGRect)rect {
  CGRect plot = self.plot;
  NSUInteger count = self.stacks.count;
  NSDictionary *axisText = @{NSFontAttributeName: [UIFont monospacedDigitSystemFontOfSize:10 weight:UIFontWeightRegular],
                             NSForegroundColorAttributeName: UIColor.tertiaryLabelColor};
  for (NSInteger line = 0; line <= 2; line++) {
    CGFloat y = CGRectGetMaxY(plot) - plot.size.height * line / 2;
    [(line ? UIColor.separatorColor : UIColor.opaqueSeparatorColor) setFill];
    UIRectFill(CGRectMake(plot.origin.x, y, plot.size.width, 1 / UIScreen.mainScreen.scale));
    NSString *text = RBUCount(self.top * line / 2);
    CGSize size = [text sizeWithAttributes:axisText];
    [text drawAtPoint:CGPointMake(plot.origin.x - size.width - 6, y - size.height / 2) withAttributes:axisText];
  }
  if (!count || self.top <= 0) return;
  CGFloat slot = plot.size.width / count;
  if (self.selected >= 0 && (NSUInteger)self.selected < count) {
    [RBUWash() setFill];
    [[UIBezierPath bezierPathWithRoundedRect:CGRectMake(plot.origin.x + slot * self.selected, plot.origin.y, slot, plot.size.height) cornerRadius:4] fill];
  }
  CGFloat (^yOf)(double) = ^CGFloat(double value) { return CGRectGetMaxY(plot) - (CGFloat)(value / self.top) * plot.size.height; };
  if (self.mode == RBUTrendType && count > 1) {
    NSUInteger layers = self.stacks.firstObject.count;
    double base[count], next[count];
    for (NSUInteger i = 0; i < count; i++) base[i] = 0;
    for (NSUInteger layer = 0; layer < layers; layer++) {
      UIBezierPath *area = [UIBezierPath bezierPath];
      for (NSUInteger i = 0; i < count; i++) {
        next[i] = base[i] + RBUNum(self.stacks[i][layer][0]);
        CGPoint point = CGPointMake(plot.origin.x + slot * (i + 0.5), yOf(next[i]));
        if (i == 0) [area moveToPoint:point]; else [area addLineToPoint:point];
      }
      for (NSInteger i = (NSInteger)count - 1; i >= 0; i--)
        [area addLineToPoint:CGPointMake(plot.origin.x + slot * (i + 0.5), yOf(base[i]))];
      [area closePath];
      UIColor *color = self.stacks.firstObject[layer][1];
      [[color colorWithAlphaComponent:0.78] setFill];
      [area fill];
      for (NSUInteger i = 0; i < count; i++) base[i] = next[i];
    }
    if (self.selected >= 0 && (NSUInteger)self.selected < count) {
      CGFloat x = plot.origin.x + slot * (self.selected + 0.5);
      [UIColor.labelColor setFill];
      UIRectFill(CGRectMake(x - 0.5, plot.origin.y, 1, plot.size.height));
    }
  } else {
    CGFloat width = MAX(1, MIN(slot * 0.68, 28));
    for (NSUInteger i = 0; i < count; i++) {
      CGFloat x = plot.origin.x + slot * i + (slot - width) / 2;
      double base = 0;
      BOOL dim = self.selected >= 0 && (NSUInteger)self.selected != i;
      for (NSArray *segment in self.stacks[i]) {
        double value = RBUNum(segment[0]);
        if (value <= 0) continue;
        CGFloat top = yOf(base + value), bottom = yOf(base);
        UIColor *color = segment[1];
        [(dim ? [color colorWithAlphaComponent:0.45] : color) setFill];
        UIRectFill(CGRectMake(x, top, width, MAX(bottom - top - (bottom - top > 2 ? 1 : 0), 0.5)));
        base += value;
      }
    }
  }
  NSMutableOrderedSet<NSNumber *> *ticks = [NSMutableOrderedSet orderedSetWithObject:@0];
  if (count > 2) [ticks addObject:@(count / 2)];
  if (count > 1) [ticks addObject:@(count - 1)];
  for (NSNumber *tick in ticks) {
    NSUInteger index = tick.unsignedIntegerValue;
    NSString *text = RBUBucketLabel(RBUStr(self.buckets[index][@"start"]), self.unit, NO);
    CGSize size = [text sizeWithAttributes:axisText];
    CGFloat x = plot.origin.x + slot * (index + 0.5) - size.width / 2;
    x = MAX(plot.origin.x, MIN(x, CGRectGetMaxX(plot) - size.width));
    [text drawAtPoint:CGPointMake(x, CGRectGetMaxY(plot) + 6) withAttributes:axisText];
  }
}
- (void)touched:(UIGestureRecognizer *)recognizer {
  NSUInteger count = self.stacks.count;
  if (!count || self.top <= 0) return;
  CGRect plot = self.plot;
  CGFloat x = [recognizer locationInView:self].x - plot.origin.x;
  NSInteger index = (NSInteger)floor(x / (plot.size.width / count));
  index = MAX(0, MIN(index, (NSInteger)count - 1));
  if ([recognizer isKindOfClass:UITapGestureRecognizer.class] && index == self.selected) index = -1;
  else if ([recognizer isKindOfClass:UIPanGestureRecognizer.class] && recognizer.state == UIGestureRecognizerStateEnded) return;
  if (index == self.selected) return;
  self.selected = index;
  [self showTip];
  [self setNeedsDisplay];
  if (index >= 0) UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification, self.tipLabel.attributedText.string);
}
- (void)showTip {
  if (self.selected < 0) { self.tip.hidden = YES; return; }
  NSDictionary *bucket = self.buckets[(NSUInteger)self.selected];
  NSArray<NSArray *> *stack = self.stacks[(NSUInteger)self.selected];
  NSMutableAttributedString *text = [NSMutableAttributedString new];
  UIFont *font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
  void (^line)(NSString *, UIColor *, NSString *, BOOL) = ^(NSString *name, UIColor *color, NSString *value, BOOL bold) {
    if (text.length) [text appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
    if (color) [text appendAttributedString:[[NSAttributedString alloc] initWithString:@"● " attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: color}]];
    UIFont *weight = bold ? [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightSemibold] : font;
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:name attributes:@{NSFontAttributeName: weight, NSForegroundColorAttributeName: bold ? UIColor.labelColor : UIColor.secondaryLabelColor}]];
    if (value) [text appendAttributedString:[[NSAttributedString alloc] initWithString:[@"  " stringByAppendingString:value] attributes:@{NSFontAttributeName: weight, NSForegroundColorAttributeName: UIColor.labelColor}]];
  };
  line(RBUBucketLabel(RBUStr(bucket[@"start"]), self.unit, YES), nil, nil, YES);
  if (self.mode == RBUTrendRequests) {
    line(RBL(@"请求", @"Requests"), nil, RBUExact(RBUNum(bucket[@"requests"])), NO);
    line(RBL(@"失败", @"Failed"), RBUFailColor(), RBUExact(RBUNum(bucket[@"failed"])), NO);
    line(RBL(@"平均耗时", @"Avg. duration"), nil, RBUDuration(bucket[@"avgDurationMs"]), NO);
  } else {
    line(RBL(@"总 Token", @"Total tokens"), nil, RBUCount(RBUNum(bucket[@"total"])), NO);
    NSUInteger shown = 0;
    for (NSArray *segment in stack) {
      if (RBUNum(segment[0]) <= 0) continue;
      if (++shown > 8) break;
      line(segment[2], segment[1], RBUCount(RBUNum(segment[0])), NO);
    }
    if (RBUHas(bucket[@"cost"])) line(RBL(@"花费", @"Cost"), nil, RBUCost(bucket[@"cost"]), NO);
  }
  self.tipLabel.attributedText = text;
  CGSize size = [self.tipLabel sizeThatFits:CGSizeMake(220, CGFLOAT_MAX)];
  CGRect plot = self.plot;
  CGFloat slot = plot.size.width / self.stacks.count;
  CGFloat center = plot.origin.x + slot * (self.selected + 0.5);
  CGFloat width = size.width + 20, height = size.height + 16;
  CGFloat x = center + 10 + width > self.bounds.size.width ? center - 10 - width : center + 10;
  self.tip.frame = CGRectMake(MAX(0, x), plot.origin.y, width, height);
  self.tipLabel.frame = CGRectMake(10, 8, size.width, size.height);
  self.tip.hidden = NO;
}
- (void)layoutSubviews { [super layoutSubviews]; if (self.selected >= 0) [self showTip]; }
- (void)traitCollectionDidChange:(UITraitCollection *)previous { [super traitCollectionDidChange:previous]; [self setNeedsDisplay]; }
@end

#pragma mark - Breakdown row

@interface RBURow : UIControl
@property(nonatomic, copy) NSString *dimension, *key;
@end
@implementation RBURow
- (void)setHighlighted:(BOOL)highlighted { [super setHighlighted:highlighted]; self.backgroundColor = highlighted ? RBUWash() : UIColor.clearColor; }
@end

#pragma mark - Controller

@interface RBUsageController : UIViewController
@property(nonatomic, strong) UIScrollView *scroll;
@property(nonatomic, strong) UIStackView *content;
@property(nonatomic, strong) UIBarButtonItem *exportItem;
@property(nonatomic, copy) NSString *range, *customFrom, *customTo;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *filters;
@property(nonatomic) NSInteger offset, dimension, trendMode;
@property(nonatomic, copy) NSString *sortKey;
@property(nonatomic) BOOL sortAscending, picking, loading, exporting;
@property(nonatomic, strong) NSDate *pickFrom, *pickTo;
@property(nonatomic, copy) NSDictionary *report, *legacy, *options;
@property(nonatomic, copy) NSString *failure;
@property(nonatomic) NSUInteger generation;
@end

@implementation RBUsageController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"用量", @"Usage");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose target:self action:@selector(close)];
  UIBarButtonItem *refresh = [[UIBarButtonItem alloc] initWithImage:[UIImage systemImageNamed:@"arrow.clockwise"] style:UIBarButtonItemStylePlain target:self action:@selector(reload)];
  refresh.accessibilityLabel = RBL(@"刷新", @"Refresh");
  refresh.accessibilityIdentifier = @"rokbot.usage.refresh";
  self.exportItem = [[UIBarButtonItem alloc] initWithImage:[UIImage systemImageNamed:@"square.and.arrow.up"] style:UIBarButtonItemStylePlain target:self action:@selector(exportCSV)];
  self.exportItem.accessibilityLabel = RBL(@"导出 CSV", @"Export CSV");
  self.exportItem.accessibilityIdentifier = @"rokbot.usage.export";
  self.navigationItem.rightBarButtonItems = @[refresh, self.exportItem];
  self.range = @"7d";
  self.filters = [NSMutableDictionary dictionary];
  self.sortKey = @"total";
  self.scroll = [UIScrollView new];
  self.scroll.alwaysBounceVertical = YES;
  self.scroll.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:self.scroll];
  self.content = RBUStack(UILayoutConstraintAxisVertical, 14, @[]);
  self.content.alignment = UIStackViewAlignmentFill;
  self.content.translatesAutoresizingMaskIntoConstraints = NO;
  [self.scroll addSubview:self.content];
  UILayoutGuide *frame = self.scroll.frameLayoutGuide, *area = self.scroll.contentLayoutGuide;
  UILayoutGuide *readable = self.view.readableContentGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.scroll.topAnchor constraintEqualToAnchor:self.view.topAnchor],
    [self.scroll.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [self.scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [self.scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [self.content.topAnchor constraintEqualToAnchor:area.topAnchor constant:12],
    [self.content.bottomAnchor constraintEqualToAnchor:area.bottomAnchor constant:-28],
    [self.content.leadingAnchor constraintEqualToAnchor:readable.leadingAnchor],
    [self.content.trailingAnchor constraintEqualToAnchor:readable.trailingAnchor],
    [area.widthAnchor constraintEqualToAnchor:frame.widthAnchor],
  ]];
  [self reload];
}
- (void)close { [self dismissViewControllerAnimated:YES completion:nil]; }

#pragma mark Requests

- (NSArray<NSURLQueryItem *> *)queryItems {
  NSMutableArray *items = [NSMutableArray arrayWithObjects:
      [NSURLQueryItem queryItemWithName:@"timeZone" value:NSTimeZone.localTimeZone.name ?: @"UTC"],
      [NSURLQueryItem queryItemWithName:@"range" value:self.range], nil];
  if ([self.range isEqual:@"custom"]) {
    [items addObject:[NSURLQueryItem queryItemWithName:@"from" value:self.customFrom ?: @""]];
    [items addObject:[NSURLQueryItem queryItemWithName:@"to" value:self.customTo ?: @""]];
  }
  for (NSString *key in RBUFilterKeys())
    if (self.filters[key]) [items addObject:[NSURLQueryItem queryItemWithName:key value:self.filters[key]]];
  return items;
}

- (NSMutableURLRequest *)requestFor:(NSString *)path items:(NSArray<NSURLQueryItem *> *)items {
  NSString *base = RBConnection.shared.serverURL, *token = RBConnection.shared.deviceToken;
  if (!base.length || !token.length) return nil;
  NSURLComponents *components = [NSURLComponents componentsWithString:[base stringByAppendingString:path]];
  components.queryItems = items;
  if (!components.URL) return nil;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:components.URL];
  request.timeoutInterval = 30;
  [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
  return request;
}

- (void)fetch:(NSURLRequest *)request done:(void (^)(NSInteger status, id value, NSError *error))done {
  NSString *token = RBConnection.shared.deviceToken;
  [[RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    id value = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![token isEqual:RBConnection.shared.deviceToken]) return;
      done(status, value, error);
    });
  }] resume];
}

// Reload everything; a new range or filter drops the shown report for the skeleton, a new page keeps it.
- (void)reloadKeeping:(BOOL)keep {
  if (!keep) self.report = nil;
  [self reload];
}
- (void)reload {
  NSUInteger generation = ++self.generation;
  self.loading = YES;
  self.failure = nil;
  NSMutableArray *items = [[self queryItems] mutableCopy];
  [items addObject:[NSURLQueryItem queryItemWithName:@"offset" value:[@(self.offset) stringValue]]];
  [items addObject:[NSURLQueryItem queryItemWithName:@"limit" value:[@(RBUPageSize) stringValue]]];
  NSMutableURLRequest *request = [self requestFor:@"/local/usage/report" items:items];
  if (!request) {
    self.loading = NO;
    self.failure = RBConnection.shared.deviceToken.length ? RBL(@"无法读取用量", @"Could not load usage") : RBL(@"请先连接 Host。", @"Connect to Host first.");
    [self render];
    return;
  }
  [self render];
  [self fetch:request done:^(NSInteger status, id value, NSError *error) {
    if (generation != self.generation) return;
    NSDictionary *report = RBUDict(value);
    if (status == 404 && !error) { [self loadLegacy:generation]; return; }
    self.loading = NO;
    if (!error && status == 200 && RBUNum(report[@"version"]) >= 2 && RBUDict(report[@"totals"])) {
      RBUCurrency = [report[@"currency"] isKindOfClass:NSString.class] ? report[@"currency"] : nil;
      self.report = report;
      self.legacy = nil;
      if (RBUDict(report[@"options"])) self.options = report[@"options"];
      NSInteger total = (NSInteger)RBUNum(RBUDict(report[@"requests"])[@"total"]);
      if (self.offset > 0 && self.offset >= total) { self.offset = MAX(0, (total - 1) / RBUPageSize * RBUPageSize); [self reload]; return; }
    } else if (status == 400 && RBUStr(report[@"error"])) {
      self.failure = [NSString stringWithFormat:@"%@: %@", RBL(@"参数无效", @"Invalid request"), report[@"error"]];
    } else {
      self.failure = status == 401 || status == 403 ? RBL(@"设备凭证已失效，请重新连接 Host。", @"The device credential is no longer valid. Reconnect to the Host.")
                                                    : RBL(@"无法读取用量", @"Could not load usage");
    }
    [self render];
  }];
}

// Hosts before the report only have today's totals.
- (void)loadLegacy:(NSUInteger)generation {
  NSMutableURLRequest *request = [self requestFor:@"/local/usage" items:@[[NSURLQueryItem queryItemWithName:@"timeZone" value:NSTimeZone.localTimeZone.name ?: @"UTC"]]];
  [self fetch:request done:^(NSInteger status, id value, NSError *error) {
    if (generation != self.generation) return;
    self.loading = NO;
    NSDictionary *usage = RBUDict(value);
    if (!error && status == 200 && RBUHas(usage[@"total"])) { self.legacy = usage; self.report = nil; }
    else self.failure = RBL(@"无法读取用量", @"Could not load usage");
    [self render];
  }];
}

- (void)exportCSV {
  if (self.exporting) return;
  if (self.legacy) { [self alert:RBL(@"当前 Host 版本不支持导出，请先升级 Host。", @"This Host cannot export usage. Update the Host first.")]; return; }
  NSMutableArray *items = [[self queryItems] mutableCopy];
  [items addObject:[NSURLQueryItem queryItemWithName:@"export" value:@"csv"]];
  NSMutableURLRequest *request = [self requestFor:@"/local/usage/report" items:items];
  if (!request) { [self alert:RBL(@"请先连接 Host。", @"Connect to Host first.")]; return; }
  request.timeoutInterval = 120;
  self.exporting = YES;
  self.exportItem.enabled = NO;
  [self fetch:request done:^(NSInteger status, id value, NSError *error) {
    self.exporting = NO;
    self.exportItem.enabled = YES;
    NSDictionary *result = RBUDict(value);
    NSString *csv = RBUStr(result[@"csv"]);
    if (error || status != 200 || !csv) {
      [self alert:status == 404 ? RBL(@"当前 Host 版本不支持导出，请先升级 Host。", @"This Host cannot export usage. Update the Host first.")
                                : RBL(@"导出失败，请稍后重试。", @"Could not export. Try again later.")];
      return;
    }
    NSString *name = [RBUStr(result[@"filename"]) ?: @"usage.csv" lastPathComponent];
    if (!name.length || [name hasPrefix:@"."]) name = @"usage.csv";
    NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:@"rokbot-usage"];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *file = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:name]];
    NSError *writeError;
    if (![csv writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:&writeError]) {
      [self alert:RBL(@"导出失败，无法写入文件。", @"Could not write the export file.")];
      return;
    }
    UIActivityViewController *share = [[UIActivityViewController alloc] initWithActivityItems:@[file] applicationActivities:nil];
    share.popoverPresentationController.barButtonItem = self.exportItem;
    share.completionWithItemsHandler = ^(UIActivityType type, BOOL completed, NSArray *returned, NSError *shareError) {
      [NSFileManager.defaultManager removeItemAtURL:file error:nil];
    };
    [self presentViewController:share animated:YES completion:nil];
  }];
}

- (void)alert:(NSString *)message {
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:nil message:message preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"好", @"OK") style:UIAlertActionStyleCancel handler:nil]];
  [self presentViewController:alert animated:YES completion:nil];
}

#pragma mark Actions

- (void)rangeChanged:(RBSegmentControl *)control {
  NSArray *ids = @[@"today", @"7d", @"30d", @"all", @"custom"];
  NSString *range = ids[(NSUInteger)MAX(0, control.selectedSegmentIndex)];
  if ([range isEqual:@"custom"]) { [self openPicker]; return; }
  self.picking = NO;
  self.range = range;
  self.offset = 0;
  [self reloadKeeping:NO];
}
- (void)openPicker {
  NSDateFormatter *parse = RBUFormatter(@"yyyy-MM-dd", NSTimeZone.localTimeZone);
  NSDictionary *range = RBUDict(self.report[@"range"]);
  self.pickTo = [parse dateFromString:self.customTo ?: RBUStr(range[@"to"]) ?: @""] ?: [NSDate date];
  self.pickFrom = [parse dateFromString:self.customFrom ?: RBUStr(range[@"from"]) ?: @""] ?: [self.pickTo dateByAddingTimeInterval:-6 * 86400];
  self.picking = YES;
  [self render];
}
- (void)pickerChanged:(UIDatePicker *)picker {
  if (picker.tag == 1) self.pickFrom = picker.date; else self.pickTo = picker.date;
}
- (void)cancelPicker { self.picking = NO; [self render]; }
- (void)applyPicker {
  NSDateFormatter *format = RBUFormatter(@"yyyy-MM-dd", NSTimeZone.localTimeZone);
  NSString *from = [format stringFromDate:self.pickFrom], *to = [format stringFromDate:self.pickTo];
  if ([from compare:to] == NSOrderedDescending) { NSString *swap = from; from = to; to = swap; }
  NSDate *start = [format dateFromString:from], *end = [format dateFromString:to];
  NSInteger days = [[NSCalendar currentCalendar] components:NSCalendarUnitDay fromDate:start toDate:end options:0].day + 1;
  if (days > 400) { [self alert:RBL(@"自定义范围最长 400 天。", @"A custom range can be at most 400 days.")]; return; }
  self.customFrom = from;
  self.customTo = to;
  self.range = @"custom";
  self.picking = NO;
  self.offset = 0;
  [self reloadKeeping:NO];
}
- (void)setFilter:(NSString *)value forKey:(NSString *)key {
  if (value) self.filters[key] = value; else [self.filters removeObjectForKey:key];
  self.offset = 0;
  [self reloadKeeping:NO];
}
- (void)removeChip:(UIButton *)button {
  NSString *key = RBUFilterKeys()[(NSUInteger)button.tag];
  [self setFilter:nil forKey:key];
}
- (void)clearFilters { [self.filters removeAllObjects]; self.offset = 0; [self reloadKeeping:NO]; }
- (void)rowTapped:(RBURow *)row {
  [self setFilter:[self.filters[row.dimension] isEqual:row.key] ? nil : row.key forKey:row.dimension];
}
- (void)trendChanged:(RBSegmentControl *)control { self.trendMode = control.selectedSegmentIndex; [self render]; }
- (void)dimensionChanged:(RBSegmentControl *)control { self.dimension = control.selectedSegmentIndex; [self render]; }
- (void)previousPage { self.offset = MAX(0, self.offset - RBUPageSize); [self reloadKeeping:YES]; }
- (void)nextPage { self.offset += RBUPageSize; [self reloadKeeping:YES]; }

#pragma mark Rendering

- (void)render {
  for (UIView *view in self.content.arrangedSubviews) [view removeFromSuperview];
  if (self.legacy) { [self renderLegacy]; return; }
  [self addRangeSection];
  if (self.picking) [self.content addArrangedSubview:[self pickerCard]];
  [self addFilterSection];
  if (self.failure) { [self.content addArrangedSubview:[self stateCard:self.failure detail:nil retry:YES]]; return; }
  if (!self.report) { [self addSkeleton]; return; }
  NSDictionary *totals = RBUDict(self.report[@"totals"]);
  UIStackView *body = RBUStack(UILayoutConstraintAxisVertical, 14, @[]);
  body.alpha = self.loading ? 0.5 : 1;
  body.userInteractionEnabled = !self.loading;
  [self.content addArrangedSubview:body];
  if (RBUNum(totals[@"requests"]) <= 0) {
    [body addArrangedSubview:[self stateCard:RBL(@"这段时间还没有模型请求", @"No model requests in this period")
                                      detail:self.filters.count ? RBL(@"当前筛选条件下没有记录，可以清除筛选后再看。", @"Nothing matches the filters. Clear them to see everything.") : nil
                                       retry:NO]];
    return;
  }
  [body addArrangedSubview:[self summarySection:totals]];
  [body addArrangedSubview:[self compositionCard:totals]];
  [body addArrangedSubview:[self trendCard]];
  [body addArrangedSubview:[self breakdownCard]];
  [body addArrangedSubview:[self requestsCard]];
}

- (UILabel *)sectionTitle:(NSString *)text {
  UILabel *label = RBULabel(text, 15, UIFontWeightSemibold, UIColor.labelColor);
  label.accessibilityTraits = UIAccessibilityTraitHeader;
  return label;
}

- (void)addRangeSection {
  NSArray *ids = @[@"today", @"7d", @"30d", @"all", @"custom"];
  RBSegmentControl *segments = RBUSegments(@[RBL(@"今天", @"Today"), RBL(@"7 天", @"7 days"), RBL(@"30 天", @"30 days"), RBL(@"全部", @"All"), RBL(@"自定义", @"Custom")],
                                           self.picking ? 4 : (NSInteger)[ids indexOfObject:self.range]);
  segments.accessibilityIdentifier = @"rokbot.usage.range";
  [segments addTarget:self action:@selector(rangeChanged:) forControlEvents:UIControlEventValueChanged];
  __weak RBUsageController *weakSelf = self;
  segments.onRetapSegment = ^(NSInteger index) {
    if (index == 4 && !weakSelf.picking) [weakSelf openPicker];
  };
  [self.content addArrangedSubview:segments];
  NSDictionary *range = RBUDict(self.report[@"range"]), *previous = RBUDict(self.report[@"previous"]);
  NSString *today = RBUStr(self.report[@"today"]);
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  if (range) {
    NSString *from = RBUStr(range[@"from"]), *to = RBUStr(range[@"to"]);
    NSString *span = [from isEqual:to] ? RBUDay(from, today) : [NSString stringWithFormat:@"%@ – %@", RBUDay(from, today), RBUDay(to, today)];
    NSInteger days = (NSInteger)RBUNum(range[@"days"]);
    [parts addObject:days > 1 ? [NSString stringWithFormat:@"%@%@", span, RBIsChinese() ? [NSString stringWithFormat:@"（%ld 天）", (long)days] : [NSString stringWithFormat:@" (%ld days)", (long)days]] : span];
    if (previous) {
      NSString *pf = RBUStr(previous[@"from"]), *pt = RBUStr(previous[@"to"]);
      NSString *prev = [pf isEqual:pt] ? RBUDay(pf, today) : [NSString stringWithFormat:@"%@ – %@", RBUDay(pf, today), RBUDay(pt, today)];
      [parts addObject:[NSString stringWithFormat:@"%@ %@", RBL(@"对比", @"vs."), prev]];
    }
    if (RBUStr(self.report[@"timeZone"])) [parts addObject:self.report[@"timeZone"]];
  } else if (self.loading) {
    [parts addObject:RBL(@"正在读取…", @"Loading…")];
  }
  if (parts.count) {
    UILabel *label = RBULabel([parts componentsJoinedByString:@" · "], 12, UIFontWeightRegular, UIColor.secondaryLabelColor);
    label.numberOfLines = 0;
    label.accessibilityIdentifier = @"rokbot.usage.period";
    [self.content addArrangedSubview:label];
    [self.content setCustomSpacing:10 afterView:segments];
  }
}

- (UIView *)pickerCard {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:12];
  [card.stack addArrangedSubview:[self sectionTitle:RBL(@"自定义范围", @"Custom range")]];
  NSArray *rows = @[@[RBL(@"开始", @"From"), self.pickFrom ?: [NSDate date]], @[RBL(@"结束", @"To"), self.pickTo ?: [NSDate date]]];
  [rows enumerateObjectsUsingBlock:^(NSArray *row, NSUInteger index, BOOL *stop) {
    UIDatePicker *picker = [UIDatePicker new];
    picker.datePickerMode = UIDatePickerModeDate;
    picker.preferredDatePickerStyle = UIDatePickerStyleCompact;
    picker.maximumDate = [NSDate date];
    picker.date = row[1];
    picker.tag = (NSInteger)index + 1;
    picker.tintColor = RBUSeries(1);
    picker.accessibilityIdentifier = index ? @"rokbot.usage.custom.to" : @"rokbot.usage.custom.from";
    [picker addTarget:self action:@selector(pickerChanged:) forControlEvents:UIControlEventValueChanged];
    UILabel *label = RBULabel(row[0], 15, UIFontWeightRegular, UIColor.labelColor);
    [card.stack addArrangedSubview:RBUStack(UILayoutConstraintAxisHorizontal, 12, @[label, RBUSpacer(), picker])];
    if (!index) [card.stack addArrangedSubview:RBUHairline()];
  }];
  UILabel *hint = RBULabel(RBL(@"按本地日期计算，最长 400 天。", @"Local dates, up to 400 days."), 12, UIFontWeightRegular, UIColor.tertiaryLabelColor);
  [card.stack addArrangedSubview:hint];
  UIButton *cancel = RBUPillButton(RBL(@"取消", @"Cancel"), NO), *apply = RBUPillButton(RBL(@"应用", @"Apply"), YES);
  [cancel addTarget:self action:@selector(cancelPicker) forControlEvents:UIControlEventTouchUpInside];
  [apply addTarget:self action:@selector(applyPicker) forControlEvents:UIControlEventTouchUpInside];
  apply.accessibilityIdentifier = @"rokbot.usage.custom.apply";
  [card.stack addArrangedSubview:RBUStack(UILayoutConstraintAxisHorizontal, 8, @[RBUSpacer(), cancel, apply])];
  return card;
}

- (NSString *)optionLabel:(NSString *)key value:(NSString *)value {
  for (NSDictionary *option in RBUArray(RBUDict(self.options)[key]))
    if ([RBUDict(option)[@"key"] isEqual:value]) return RBUValueLabel(key, value, option[@"label"]);
  for (NSDictionary *row in RBUArray(RBUDict(self.report[@"dimensions"])[key]))
    if ([RBUDict(row)[@"key"] isEqual:value]) return RBUValueLabel(key, value, row[@"label"]);
  return RBUValueLabel(key, value, nil);
}

- (void)openFilterSheet {
  NSMutableArray<RBChoiceOption *> *choices = [NSMutableArray array];
  for (NSString *key in RBUFilterKeys()) {
    NSArray *options = RBUArray(RBUDict(self.options)[key]);
    if (!options.count) continue;
    NSString *current = self.filters[key] ? [self optionLabel:key value:self.filters[key]] : RBL(@"全部", @"All");
    [choices addObject:[RBChoiceOption optionWithValue:key title:RBUDimensionName(key) subtitle:current]];
  }
  if (self.filters.count) {
    RBChoiceOption *clear = [RBChoiceOption optionWithValue:@"__clear__"
                                                      title:RBL(@"清除全部筛选", @"Clear all filters")
                                                   subtitle:nil];
    clear.destructive = YES;
    [choices addObject:clear];
  }
  if (!choices.count) return;
  __weak RBUsageController *weakSelf = self;
  [[RBChoiceSheet sheetWithTitle:RBL(@"按维度筛选", @"Filter by")
                         message:nil
                         options:choices
                        selected:nil
                        onSelect:^(RBChoiceOption *chosen) {
                          if ([chosen.value isEqualToString:@"__clear__"]) { [weakSelf clearFilters]; return; }
                          [weakSelf openFilterDimensionSheet:chosen.value];
                        }] presentFrom:self];
}

- (void)openFilterDimensionSheet:(NSString *)key {
  NSArray *options = RBUArray(RBUDict(self.options)[key]);
  NSMutableArray<RBChoiceOption *> *choices = [NSMutableArray arrayWithObject:
      [RBChoiceOption optionWithValue:@"" title:RBL(@"全部", @"All") subtitle:nil]];
  for (NSDictionary *option in options) {
    NSString *value = RBUStr(RBUDict(option)[@"key"]);
    if (!value) continue;
    NSString *title = RBUValueLabel(key, value, option[@"label"]);
    NSString *subtitle = [NSString stringWithFormat:@"%@ %@", RBUExact(RBUNum(option[@"requests"])), RBL(@"次请求", @"requests")];
    [choices addObject:[RBChoiceOption optionWithValue:value title:title subtitle:subtitle]];
  }
  __weak RBUsageController *weakSelf = self;
  [[RBChoiceSheet sheetWithTitle:RBUDimensionName(key)
                         message:nil
                         options:choices
                        selected:self.filters[key] ?: @""
                        onSelect:^(RBChoiceOption *chosen) {
                          [weakSelf setFilter:chosen.value.length ? chosen.value : nil forKey:key];
                        }] presentFrom:self];
}

- (void)addFilterSection {
  if (!self.options && !self.filters.count) return;
  UIButton *filter = RBUPillButton(self.filters.count ? [NSString stringWithFormat:@"%@ %lu", RBL(@"筛选", @"Filter"), (unsigned long)self.filters.count] : RBL(@"筛选", @"Filter"), NO);
  [filter setImage:RBGlyphImage(RBGlyphFilter, 14, 1.5) forState:UIControlStateNormal];
  filter.imageEdgeInsets = UIEdgeInsetsMake(0, -4, 0, 4);
  [filter addTarget:self action:@selector(openFilterSheet) forControlEvents:UIControlEventTouchUpInside];
  filter.enabled = self.options != nil;
  filter.accessibilityIdentifier = @"rokbot.usage.filter";
  UIStackView *row = RBUStack(UILayoutConstraintAxisHorizontal, 8, @[filter]);
  [RBUFilterKeys() enumerateObjectsUsingBlock:^(NSString *key, NSUInteger index, BOOL *stop) {
    NSString *value = self.filters[key];
    if (!value) return;
    UIButton *chip = RBUPillButton([NSString stringWithFormat:@"%@：%@  ×", RBUDimensionName(key), [self optionLabel:key value:value]], NO);
    chip.backgroundColor = [RBUSeries(1) colorWithAlphaComponent:0.14];
    chip.tag = (NSInteger)index;
    chip.accessibilityLabel = [NSString stringWithFormat:@"%@ %@：%@", RBL(@"移除筛选", @"Remove filter"), RBUDimensionName(key), [self optionLabel:key value:value]];
    [chip addTarget:self action:@selector(removeChip:) forControlEvents:UIControlEventTouchUpInside];
    [row addArrangedSubview:chip];
  }];
  UIScrollView *scroller = [UIScrollView new];
  scroller.showsHorizontalScrollIndicator = NO;
  scroller.alwaysBounceHorizontal = NO;
  row.translatesAutoresizingMaskIntoConstraints = NO;
  [scroller addSubview:row];
  [NSLayoutConstraint activateConstraints:@[
    [row.topAnchor constraintEqualToAnchor:scroller.contentLayoutGuide.topAnchor],
    [row.bottomAnchor constraintEqualToAnchor:scroller.contentLayoutGuide.bottomAnchor],
    [row.leadingAnchor constraintEqualToAnchor:scroller.contentLayoutGuide.leadingAnchor],
    [row.trailingAnchor constraintEqualToAnchor:scroller.contentLayoutGuide.trailingAnchor],
    [row.heightAnchor constraintEqualToAnchor:scroller.frameLayoutGuide.heightAnchor],
    [scroller.heightAnchor constraintEqualToConstant:36],
  ]];
  [self.content addArrangedSubview:scroller];
}

- (UIView *)stateCard:(NSString *)title detail:(NSString *)detail retry:(BOOL)retry {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:8];
  card.stack.alignment = UIStackViewAlignmentCenter;
  UIImageView *icon = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:retry ? @"exclamationmark.triangle" : @"chart.bar"]];
  icon.tintColor = UIColor.tertiaryLabelColor;
  icon.preferredSymbolConfiguration = [UIImageSymbolConfiguration configurationWithPointSize:28 weight:UIImageSymbolWeightRegular];
  [card.stack addArrangedSubview:icon];
  UILabel *label = RBULabel(title, 15, UIFontWeightMedium, UIColor.labelColor);
  label.numberOfLines = 0;
  label.textAlignment = NSTextAlignmentCenter;
  label.accessibilityIdentifier = retry ? @"rokbot.usage.error" : @"rokbot.usage.empty";
  [card.stack addArrangedSubview:label];
  if (detail) {
    UILabel *more = RBULabel(detail, 13, UIFontWeightRegular, UIColor.secondaryLabelColor);
    more.numberOfLines = 0;
    more.textAlignment = NSTextAlignmentCenter;
    [card.stack addArrangedSubview:more];
  }
  UIButton *button = retry ? RBUPillButton(RBL(@"重试", @"Retry"), YES)
                           : self.filters.count ? RBUPillButton(RBL(@"清除筛选", @"Clear filters"), NO) : nil;
  if (button) {
    [button addTarget:self action:retry ? @selector(reload) : @selector(clearFilters) forControlEvents:UIControlEventTouchUpInside];
    button.accessibilityIdentifier = retry ? @"rokbot.usage.retry" : @"rokbot.usage.clear";
    [card.stack setCustomSpacing:14 afterView:card.stack.arrangedSubviews.lastObject];
    [card.stack addArrangedSubview:button];
  }
  card.stack.layoutMargins = UIEdgeInsetsMake(18, 0, 18, 0);
  card.stack.layoutMarginsRelativeArrangement = YES;
  return card;
}

- (void)addSkeleton {
  UIStackView *grid = RBUStack(UILayoutConstraintAxisVertical, 10, @[RBUSkeleton(84)]);
  for (NSInteger row = 0; row < 2; row++) {
    UIStackView *pair = RBUStack(UILayoutConstraintAxisHorizontal, 10, @[RBUSkeleton(84), RBUSkeleton(84)]);
    pair.distribution = UIStackViewDistributionFillEqually;
    pair.alignment = UIStackViewAlignmentFill;
    [grid addArrangedSubview:pair];
  }
  [self.content addArrangedSubview:grid];
  [self.content addArrangedSubview:RBUSkeleton(76)];
  [self.content addArrangedSubview:RBUSkeleton(250)];
  [self.content addArrangedSubview:RBUSkeleton(300)];
}

#pragma mark Summary

- (UIView *)metric:(NSString *)title value:(NSString *)value change:(id)change key:(NSString *)key note:(NSString *)note identifier:(NSString *)identifier {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:4];
  UILabel *label = RBULabel(title, 12, UIFontWeightRegular, UIColor.secondaryLabelColor);
  [card.stack addArrangedSubview:label];
  BOOL missing = [value isEqual:RBUMissing()] || [value isEqual:RBL(@"未配置单价", @"No prices set")];
  UILabel *number = RBUNumberLabel(value, missing ? 15 : 22, missing ? UIFontWeightRegular : UIFontWeightSemibold);
  if (missing) number.textColor = UIColor.secondaryLabelColor;
  number.accessibilityIdentifier = identifier;
  [card.stack addArrangedSubview:number];
  NSString *changeText = RBUChangeText(change);
  NSMutableArray<NSString *> *notes = [NSMutableArray array];
  if (note) [notes addObject:note];
  UILabel *detail = RBULabel(nil, 12, UIFontWeightRegular, UIColor.tertiaryLabelColor);
  detail.numberOfLines = 0;
  NSMutableAttributedString *text = [NSMutableAttributedString new];
  UIFont *font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightMedium];
  if (changeText) {
    double delta = RBUNum(change);
    BOOL alarm = [key isEqual:@"avgDurationMs"] || [key isEqual:@"failureRate"];
    UIColor *color = !alarm || fabs(delta) < 0.0005 ? UIColor.secondaryLabelColor : delta > 0 ? RBUWarnColor() : RBUGoodColor();
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:changeText attributes:@{NSFontAttributeName: font, NSForegroundColorAttributeName: color}]];
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:[@" " stringByAppendingString:RBL(@"较上一周期", @"vs. previous")] attributes:@{NSFontAttributeName: [UIFont systemFontOfSize:12], NSForegroundColorAttributeName: UIColor.tertiaryLabelColor}]];
  }
  for (NSString *line in notes) {
    if (text.length) [text appendAttributedString:[[NSAttributedString alloc] initWithString:@"\n"]];
    [text appendAttributedString:[[NSAttributedString alloc] initWithString:line attributes:@{NSFontAttributeName: [UIFont systemFontOfSize:12], NSForegroundColorAttributeName: UIColor.tertiaryLabelColor}]];
  }
  if (text.length) { detail.attributedText = text; [card.stack addArrangedSubview:detail]; }
  card.isAccessibilityElement = YES;
  card.accessibilityLabel = [@[title, value, changeText ?: @"", note ?: @""] componentsJoinedByString:@", "];
  return card;
}

- (NSString *)recordedNote:(double)recorded of:(double)rows {
  if (recorded >= rows) return nil;
  return RBIsChinese() ? [NSString stringWithFormat:@"%@ / %@ 条有记录", RBUExact(recorded), RBUExact(rows)]
                       : [NSString stringWithFormat:@"%@ of %@ recorded", RBUExact(recorded), RBUExact(rows)];
}

- (UIView *)summarySection:(NSDictionary *)totals {
  NSDictionary *changes = RBUDict(self.report[@"changes"]), *previous = RBUDict(self.report[@"previousTotals"]);
  BOOL priced = [self.report[@"priced"] boolValue];
  double requests = RBUNum(totals[@"requests"]);
  NSString *costNote = priced && RBUNum(totals[@"costRecorded"]) < requests
      ? (RBIsChinese() ? [NSString stringWithFormat:@"%@ / %@ 条有单价", RBUExact(RBUNum(totals[@"costRecorded"])), RBUExact(requests)]
                       : [NSString stringWithFormat:@"%@ of %@ priced", RBUExact(RBUNum(totals[@"costRecorded"])), RBUExact(requests)]) : nil;
  UIView *cost = [self metric:RBL(@"总花费", @"Total cost") value:priced ? RBUCost(totals[@"cost"]) : RBL(@"未配置单价", @"No prices set")
                       change:priced ? changes[@"cost"] : nil key:@"cost" note:costNote identifier:@"rokbot.usage.cost"];
  UIView *total = [self metric:RBL(@"总 Token", @"Total tokens") value:RBUCount(RBUNum(totals[@"total"])) change:changes[@"total"] key:@"total"
                          note:nil identifier:@"rokbot.usage.total"];
  UIView *count = [self metric:RBL(@"请求次数", @"Requests") value:RBUExact(requests) change:changes[@"requests"] key:@"requests" note:nil identifier:@"rokbot.usage.requests"];
  UIView *duration = [self metric:RBL(@"平均耗时", @"Avg. duration") value:RBUDuration(totals[@"avgDurationMs"]) change:changes[@"avgDurationMs"] key:@"avgDurationMs"
                             note:[self recordedNote:RBUNum(totals[@"durationRecorded"]) of:requests] identifier:@"rokbot.usage.duration"];
  UIView *failure = [self metric:RBL(@"失败率", @"Failure rate") value:RBURate(totals[@"failureRate"]) change:changes[@"failureRate"] key:@"failureRate"
                            note:[self recordedNote:RBUNum(totals[@"statusRecorded"]) of:requests] identifier:@"rokbot.usage.failure"];
  id hitChange = nil;
  if (RBUHas(totals[@"cacheHitRate"]) && RBUHas(previous[@"cacheHitRate"]) && RBUNum(previous[@"cacheHitRate"]) > 0)
    hitChange = @(RBUNum(totals[@"cacheHitRate"]) / RBUNum(previous[@"cacheHitRate"]) - 1);
  UIView *hit = [self metric:RBL(@"缓存命中率", @"Cache hit rate") value:RBURate(totals[@"cacheHitRate"]) change:hitChange key:@"cacheHitRate" note:nil identifier:@"rokbot.usage.cacheHit"];
  UIStackView *grid = RBUStack(UILayoutConstraintAxisVertical, 10, @[cost]);
  for (NSArray *pair in @[@[total, count], @[duration, failure], @[hit, [UIView new]]]) {
    UIStackView *row = RBUStack(UILayoutConstraintAxisHorizontal, 10, pair);
    row.distribution = UIStackViewDistributionFillEqually;
    row.alignment = UIStackViewAlignmentFill;
    [grid addArrangedSubview:row];
  }
  return grid;
}

- (UIView *)compositionCard:(NSDictionary *)totals {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:10];
  double input = RBUNum(totals[@"input"]), cached = MIN(RBUNum(totals[@"cached"]), input), output = RBUNum(totals[@"output"]);
  double reasoning = MIN(RBUNum(totals[@"reasoning"]), output);
  NSArray<NSArray *> *parts = @[@[@(input - cached), RBUSeries(1), RBL(@"未命中输入", @"Uncached input")],
                                @[@(cached), RBUSeries(3), RBL(@"缓存命中", @"Cache read")],
                                @[@(output - reasoning), RBUSeries(2), RBL(@"输出", @"Output")],
                                @[@(reasoning), RBUSeries(7), RBL(@"推理", @"Reasoning")]];
  double sum = 0;
  for (NSArray *part in parts) sum += RBUNum(part[0]);
  UILabel *value = RBUNumberLabel(RBUCount(sum), 13, UIFontWeightRegular);
  value.textColor = UIColor.secondaryLabelColor;
  [card.stack addArrangedSubview:RBUStack(UILayoutConstraintAxisHorizontal, 8, @[[self sectionTitle:RBL(@"Token 构成", @"Token mix")], RBUSpacer(), value])];
  RBUStackBar *bar = [RBUStackBar new];
  bar.segments = parts;
  bar.backgroundColor = UIColor.clearColor;
  bar.contentMode = UIViewContentModeRedraw;
  [bar.heightAnchor constraintEqualToConstant:12].active = YES;
  [card.stack addArrangedSubview:bar];
  UIStackView *legend = RBUStack(UILayoutConstraintAxisVertical, 6, @[]);
  for (NSArray *part in parts) {
    double amount = RBUNum(part[0]);
    if ([part isEqual:parts.lastObject] && amount <= 0) continue;
    UILabel *name = RBULabel(part[2], 13, UIFontWeightRegular, UIColor.secondaryLabelColor);
    UILabel *number = RBUNumberLabel([NSString stringWithFormat:@"%@  %@", RBUCount(amount), sum > 0 ? RBURate(@(amount / sum)) : @"0%"], 13, UIFontWeightRegular);
    number.textAlignment = NSTextAlignmentRight;
    [legend addArrangedSubview:RBUStack(UILayoutConstraintAxisHorizontal, 8, @[RBUDot(part[1], 9), name, RBUSpacer(), number])];
  }
  [card.stack addArrangedSubview:legend];
  return card;
}

#pragma mark Trend

- (UIView *)trendCard {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:12];
  NSDictionary *range = RBUDict(self.report[@"range"]);
  NSString *unit = RBUStr(range[@"unit"]) ?: @"day";
  NSString *title = [unit isEqual:@"hour"] ? RBL(@"每小时趋势", @"Hourly trend") : [unit isEqual:@"month"] ? RBL(@"每月趋势", @"Monthly trend") : RBL(@"每日趋势", @"Daily trend");
  [card.stack addArrangedSubview:[self sectionTitle:title]];
  RBSegmentControl *modes = RBUSegments(@[RBL(@"按模型", @"By model"), RBL(@"按类型", @"By type"), RBL(@"请求", @"Requests")], self.trendMode);
  modes.accessibilityIdentifier = @"rokbot.usage.trendMode";
  [modes addTarget:self action:@selector(trendChanged:) forControlEvents:UIControlEventValueChanged];
  [card.stack addArrangedSubview:modes];
  RBUTrend *chart = [RBUTrend new];
  chart.buckets = RBUArray(self.report[@"buckets"]);
  NSMutableArray *series = [NSMutableArray array];
  for (id name in RBUArray(self.report[@"series"])) if (RBUStr(name)) [series addObject:name];
  chart.series = series;
  chart.unit = unit;
  chart.mode = (RBUTrendMode)self.trendMode;
  chart.accessibilityIdentifier = @"rokbot.usage.trend";
  [chart prepare];
  [chart.heightAnchor constraintEqualToConstant:200].active = YES;
  [card.stack addArrangedSubview:chart];
  NSMutableArray *legend = [NSMutableArray array];
  if (self.trendMode == RBUTrendModel) {
    [series enumerateObjectsUsingBlock:^(NSString *name, NSUInteger index, BOOL *stop) {
      [legend addObject:@[RBUValueLabel(@"model", name, nil), RBUSeries((NSInteger)index + 1)]];
    }];
    BOOL others = NO;
    for (NSArray *stack in chart.stacks) if (RBUNum(stack.lastObject[0]) > 0) others = YES;
    if (others) [legend addObject:@[RBL(@"其他模型", @"Other models"), RBUSeries(0)]];
  } else if (self.trendMode == RBUTrendType) {
    [legend addObjectsFromArray:@[@[RBL(@"缓存命中", @"Cache read"), RBUSeries(3)], @[RBL(@"未命中输入", @"Uncached input"), RBUSeries(1)], @[RBL(@"输出", @"Output"), RBUSeries(2)]]];
  } else {
    [legend addObjectsFromArray:@[@[RBL(@"请求", @"Requests"), RBUSeries(1)], @[RBL(@"失败", @"Failed"), RBUFailColor()]]];
  }
  [card.stack addArrangedSubview:RBULegend(legend)];
  UILabel *hint = RBULabel(RBL(@"点按或横向拖动查看每段明细", @"Tap or drag across the chart for details"), 11, UIFontWeightRegular, UIColor.tertiaryLabelColor);
  [card.stack addArrangedSubview:hint];
  return card;
}

#pragma mark Breakdown

- (NSArray<NSDictionary *> *)sortedRows:(NSArray<NSDictionary *> *)rows dimension:(NSString *)dimension {
  NSString *key = self.sortKey;
  BOOL ascending = self.sortAscending;
  return [rows sortedArrayWithOptions:NSSortStable usingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    NSComparisonResult result;
    if ([key isEqual:@"name"]) {
      result = [RBUValueLabel(dimension, a[@"key"], a[@"label"]) localizedStandardCompare:RBUValueLabel(dimension, b[@"key"], b[@"label"])];
      return ascending ? result : -result;
    }
    // Missing values (null) always sort last.
    BOOL hasA = RBUHas(a[key]), hasB = RBUHas(b[key]);
    if (hasA != hasB) return hasA ? NSOrderedAscending : NSOrderedDescending;
    double x = RBUNum(a[key]), y = RBUNum(b[key]);
    result = x < y ? NSOrderedAscending : x > y ? NSOrderedDescending : NSOrderedSame;
    return ascending ? result : -result;
  }];
}

- (void)openSortSheet {
  NSArray *keys = @[@[@"total", @"Token"], @[@"requests", RBL(@"请求", @"Requests")], @[@"avgDurationMs", RBL(@"平均耗时", @"Avg. duration")],
                    @[@"failureRate", RBL(@"失败率", @"Failure rate")], @[@"cost", RBL(@"花费", @"Cost")], @[@"name", RBL(@"名称", @"Name")]];
  NSMutableArray<RBChoiceOption *> *choices = [NSMutableArray array];
  for (NSArray *pair in keys) {
    NSString *key = pair[0];
    BOOL current = [self.sortKey isEqual:key];
    NSString *subtitle = current
        ? (self.sortAscending ? RBL(@"当前：升序（再选切换降序）", @"Current: ascending (tap again to reverse)")
                              : RBL(@"当前：降序（再选切换升序）", @"Current: descending (tap again to reverse)"))
        : nil;
    [choices addObject:[RBChoiceOption optionWithValue:key title:pair[1] subtitle:subtitle]];
  }
  __weak RBUsageController *weakSelf = self;
  [[RBChoiceSheet sheetWithTitle:RBL(@"排序", @"Sort")
                         message:RBL(@"再次选择当前项可切换升降序", @"Choose the active item again to reverse")
                         options:choices
                        selected:self.sortKey
                        onSelect:^(RBChoiceOption *chosen) {
                          RBUsageController *strong = weakSelf;
                          if (!strong) return;
                          if ([strong.sortKey isEqual:chosen.value]) strong.sortAscending = !strong.sortAscending;
                          else { strong.sortKey = chosen.value; strong.sortAscending = [chosen.value isEqual:@"name"]; }
                          [strong render];
                        }] presentFrom:self];
}

- (UIView *)breakdownCard {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:12];
  NSArray<NSString *> *dimensions = RBUDimensions();
  NSInteger selected = MAX(0, MIN(self.dimension, (NSInteger)dimensions.count - 1));
  NSString *dimension = dimensions[(NSUInteger)selected];
  NSMutableArray *names = [NSMutableArray array];
  for (NSString *name in dimensions) [names addObject:RBUDimensionName(name)];
  UIButton *sort = [UIButton buttonWithType:UIButtonTypeSystem];
  [sort setImage:RBGlyphImage(RBGlyphSort, 16, 1.6) forState:UIControlStateNormal];
  sort.tintColor = UIColor.secondaryLabelColor;
  [sort addTarget:self action:@selector(openSortSheet) forControlEvents:UIControlEventTouchUpInside];
  sort.accessibilityLabel = RBL(@"排序", @"Sort");
  sort.accessibilityIdentifier = @"rokbot.usage.sort";
  [sort.widthAnchor constraintEqualToConstant:32].active = YES;
  [card.stack addArrangedSubview:RBUStack(UILayoutConstraintAxisHorizontal, 8, @[[self sectionTitle:RBL(@"维度拆分", @"Breakdown")], RBUSpacer(), sort])];
  RBSegmentControl *tabs = RBUSegments(names, selected);
  tabs.accessibilityIdentifier = @"rokbot.usage.dimension";
  [tabs addTarget:self action:@selector(dimensionChanged:) forControlEvents:UIControlEventValueChanged];
  [card.stack addArrangedSubview:tabs];

  NSArray<NSDictionary *> *rows = [RBUArray(RBUDict(self.report[@"dimensions"])[dimension]) filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(id row, NSDictionary *bindings) { return RBUDict(row) && RBUStr(row[@"key"]); }]];
  if (!rows.count) {
    UILabel *empty = RBULabel(RBL(@"暂无数据", @"No data"), 13, UIFontWeightRegular, UIColor.secondaryLabelColor);
    [card.stack addArrangedSubview:empty];
    return card;
  }
  // Colours follow the share: the trend's series for models, the rank otherwise; the rest share c0.
  NSArray *series = RBUArray(self.report[@"series"]);
  NSMutableDictionary<NSString *, UIColor *> *colors = [NSMutableDictionary dictionary];
  NSMutableArray *slices = [NSMutableArray array];
  double rest = 0, all = 0;
  for (NSUInteger index = 0; index < rows.count; index++) {
    NSDictionary *row = rows[index];
    NSInteger color = [dimension isEqual:@"model"] ? ([series containsObject:row[@"key"]] ? (NSInteger)[series indexOfObject:row[@"key"]] + 1 : 0)
                                                   : (index < 7 ? (NSInteger)index + 1 : 0);
    colors[row[@"key"]] = RBUSeries(color);
    all += RBUNum(row[@"total"]);
    if (color) [slices addObject:@[@(RBUNum(row[@"total"])), RBUSeries(color)]]; else rest += RBUNum(row[@"total"]);
  }
  if (rest > 0) [slices addObject:@[@(rest), RBUSeries(0)]];
  RBUDonut *donut = [RBUDonut new];
  donut.backgroundColor = UIColor.clearColor;
  donut.contentMode = UIViewContentModeRedraw;
  donut.segments = slices;
  donut.title = RBL(@"总 Token", @"Total tokens");
  donut.value = RBUCount(all);
  donut.isAccessibilityElement = YES;
  donut.accessibilityLabel = [NSString stringWithFormat:@"%@ %@, %@ %@", RBUDimensionName(dimension), RBL(@"占比图", @"share chart"), donut.title, donut.value];
  [donut.widthAnchor constraintEqualToConstant:150].active = YES;
  [donut.heightAnchor constraintEqualToConstant:150].active = YES;
  UIStackView *center = RBUStack(UILayoutConstraintAxisVertical, 0, @[donut]);
  center.alignment = UIStackViewAlignmentCenter;
  [card.stack addArrangedSubview:center];

  UIStackView *list = RBUStack(UILayoutConstraintAxisVertical, 0, @[]);
  NSArray *sorted = [self sortedRows:rows dimension:dimension];
  BOOL priced = [self.report[@"priced"] boolValue];
  for (NSDictionary *row in sorted) {
    if (list.arrangedSubviews.count) [list addArrangedSubview:RBUHairline()];
    [list addArrangedSubview:[self breakdownRow:row dimension:dimension color:colors[row[@"key"]] priced:priced]];
  }
  [card.stack addArrangedSubview:list];
  UILabel *hint = RBULabel(RBL(@"点一行即按该值筛选，再点一次取消", @"Tap a row to filter by it; tap again to clear"), 11, UIFontWeightRegular, UIColor.tertiaryLabelColor);
  [card.stack addArrangedSubview:hint];
  return card;
}

- (UIView *)breakdownRow:(NSDictionary *)row dimension:(NSString *)dimension color:(UIColor *)color priced:(BOOL)priced {
  RBURow *control = [RBURow new];
  control.dimension = dimension;
  control.key = row[@"key"];
  control.layer.cornerRadius = 8;
  [control addTarget:self action:@selector(rowTapped:) forControlEvents:UIControlEventTouchUpInside];
  BOOL active = [self.filters[dimension] isEqual:row[@"key"]];
  NSString *name = RBUValueLabel(dimension, row[@"key"], row[@"label"]);
  UILabel *title = RBULabel(name, 14, active ? UIFontWeightSemibold : UIFontWeightRegular,
                            [row[@"key"] isEqual:RBUNone] ? UIColor.secondaryLabelColor : UIColor.labelColor);
  title.lineBreakMode = NSLineBreakByTruncatingMiddle;
  [title setContentCompressionResistancePriority:UILayoutPriorityDefaultLow forAxis:UILayoutConstraintAxisHorizontal];
  double share = MAX(0, MIN(1, RBUNum(row[@"share"])));
  UILabel *tokens = RBUNumberLabel([NSString stringWithFormat:@"%@  %@", RBUCount(RBUNum(row[@"total"])), RBURate(@(share))], 13, UIFontWeightMedium);
  tokens.textAlignment = NSTextAlignmentRight;
  [tokens setContentCompressionResistancePriority:UILayoutPriorityRequired forAxis:UILayoutConstraintAxisHorizontal];
  NSMutableArray *top = [NSMutableArray arrayWithObjects:RBUDot(color ?: RBUSeries(0), 10), title, RBUSpacer(), tokens, nil];
  if (active) {
    UIImageView *check = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"checkmark"]];
    check.tintColor = UIColor.labelColor;
    check.preferredSymbolConfiguration = [UIImageSymbolConfiguration configurationWithPointSize:12 weight:UIImageSymbolWeightSemibold];
    [top insertObject:check atIndex:2];
  }
  UIStackView *head = RBUStack(UILayoutConstraintAxisHorizontal, 8, top);
  UIView *track = [UIView new];
  track.backgroundColor = RBUWash();
  track.layer.cornerRadius = 2;
  UIView *fill = [UIView new];
  fill.backgroundColor = color ?: RBUSeries(0);
  fill.layer.cornerRadius = 2;
  fill.translatesAutoresizingMaskIntoConstraints = NO;
  [track addSubview:fill];
  [NSLayoutConstraint activateConstraints:@[
    [track.heightAnchor constraintEqualToConstant:4],
    [fill.leadingAnchor constraintEqualToAnchor:track.leadingAnchor],
    [fill.topAnchor constraintEqualToAnchor:track.topAnchor],
    [fill.bottomAnchor constraintEqualToAnchor:track.bottomAnchor],
    [fill.widthAnchor constraintEqualToAnchor:track.widthAnchor multiplier:MAX(share, 0.002)],
  ]];
  NSMutableArray<NSString *> *details = [NSMutableArray arrayWithObjects:
      [NSString stringWithFormat:@"%@ %@", RBL(@"请求", @"Requests"), RBUExact(RBUNum(row[@"requests"]))],
      [NSString stringWithFormat:@"%@ %@", RBL(@"耗时", @"Duration"), RBUDuration(row[@"avgDurationMs"])],
      [NSString stringWithFormat:@"%@ %@", RBL(@"失败率", @"Failures"), RBURate(row[@"failureRate"])], nil];
  if (priced) [details addObject:[NSString stringWithFormat:@"%@ %@", RBL(@"花费", @"Cost"), RBUCost(row[@"cost"])]];
  UILabel *detail = RBULabel([details componentsJoinedByString:@" · "], 12, UIFontWeightRegular, UIColor.secondaryLabelColor);
  detail.font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
  detail.numberOfLines = 0;
  UIStackView *stack = RBUStack(UILayoutConstraintAxisVertical, 6, @[head, track, detail]);
  stack.userInteractionEnabled = NO;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [control addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.topAnchor constraintEqualToAnchor:control.topAnchor constant:10],
    [stack.bottomAnchor constraintEqualToAnchor:control.bottomAnchor constant:-10],
    [stack.leadingAnchor constraintEqualToAnchor:control.leadingAnchor constant:4],
    [stack.trailingAnchor constraintEqualToAnchor:control.trailingAnchor constant:-4],
  ]];
  control.isAccessibilityElement = YES;
  control.accessibilityTraits = UIAccessibilityTraitButton | (active ? UIAccessibilityTraitSelected : 0);
  control.accessibilityLabel = [NSString stringWithFormat:@"%@, %@ Token, %@, %@", name, RBUCount(RBUNum(row[@"total"])), RBURate(@(share)), [details componentsJoinedByString:@", "]];
  control.accessibilityHint = active ? RBL(@"取消此筛选", @"Clears this filter") : RBL(@"按此值筛选", @"Filters by this value");
  return control;
}

#pragma mark Requests

- (UIView *)requestsCard {
  RBUCard *card = [[RBUCard alloc] initWithSpacing:0];
  NSDictionary *page = RBUDict(self.report[@"requests"]);
  NSArray *items = RBUArray(page[@"items"]);
  NSInteger total = (NSInteger)RBUNum(page[@"total"]), offset = (NSInteger)RBUNum(page[@"offset"]);
  UILabel *count = RBULabel(RBIsChinese() ? [NSString stringWithFormat:@"共 %@ 条", RBUExact(total)] : [NSString stringWithFormat:@"%@ in total", RBUExact(total)],
                            13, UIFontWeightRegular, UIColor.secondaryLabelColor);
  UIStackView *head = RBUStack(UILayoutConstraintAxisHorizontal, 8, @[[self sectionTitle:RBL(@"请求明细", @"Requests")], RBUSpacer(), count]);
  [card.stack addArrangedSubview:head];
  [card.stack setCustomSpacing:6 afterView:head];
  NSDateFormatter *time = RBUFormatter([self.range isEqual:@"today"] ? @"HH:mm:ss" : @"MM-dd HH:mm:ss", NSTimeZone.localTimeZone);
  NSString *zone = RBUStr(self.report[@"timeZone"]);
  if (zone && [NSTimeZone timeZoneWithName:zone]) time.timeZone = [NSTimeZone timeZoneWithName:zone];
  for (NSDictionary *item in items) {
    if (!RBUDict(item)) continue;
    [card.stack addArrangedSubview:RBUHairline()];
    [card.stack addArrangedSubview:[self requestRow:item time:time]];
  }
  if (total > RBUPageSize || offset > 0) {
    [card.stack addArrangedSubview:RBUHairline()];
    UIButton *previous = RBUPillButton(RBL(@"上一页", @"Previous"), NO), *next = RBUPillButton(RBL(@"下一页", @"Next"), NO);
    previous.enabled = offset > 0;
    next.enabled = offset + (NSInteger)items.count < total;
    previous.alpha = previous.enabled ? 1 : 0.4;
    next.alpha = next.enabled ? 1 : 0.4;
    previous.accessibilityIdentifier = @"rokbot.usage.previous";
    next.accessibilityIdentifier = @"rokbot.usage.next";
    [previous addTarget:self action:@selector(previousPage) forControlEvents:UIControlEventTouchUpInside];
    [next addTarget:self action:@selector(nextPage) forControlEvents:UIControlEventTouchUpInside];
    NSInteger first = items.count ? offset + 1 : 0, last = offset + (NSInteger)items.count;
    UILabel *position = RBULabel(RBIsChinese() ? [NSString stringWithFormat:@"第 %ld–%ld 条，共 %@ 条", (long)first, (long)last, RBUExact(total)]
                                               : [NSString stringWithFormat:@"%ld–%ld of %@", (long)first, (long)last, RBUExact(total)],
                                 12, UIFontWeightRegular, UIColor.secondaryLabelColor);
    position.font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
    position.textAlignment = NSTextAlignmentCenter;
    position.adjustsFontSizeToFitWidth = YES;
    position.minimumScaleFactor = 0.7;
    UIStackView *pager = RBUStack(UILayoutConstraintAxisHorizontal, 8, @[previous, position, next]);
    pager.layoutMargins = UIEdgeInsetsMake(12, 0, 0, 0);
    pager.layoutMarginsRelativeArrangement = YES;
    [position setContentHuggingPriority:1 forAxis:UILayoutConstraintAxisHorizontal];
    [card.stack addArrangedSubview:pager];
  }
  return card;
}

- (UIView *)requestRow:(NSDictionary *)item time:(NSDateFormatter *)format {
  NSDate *at = RBUParseInstant(RBUStr(item[@"at"]));
  UILabel *time = RBUNumberLabel(at ? [format stringFromDate:at] : RBUMissing(), 12, UIFontWeightRegular);
  time.textColor = UIColor.secondaryLabelColor;
  NSString *status = RBUStr(item[@"status"]);
  UILabel *state = RBULabel(status ? RBUStatusLabel(status) : RBUMissing(), 12, UIFontWeightMedium,
                            [status isEqual:@"error"] ? RBUFailColor() : [status isEqual:@"ok"] ? RBUGoodColor() : UIColor.secondaryLabelColor);
  UIStackView *top = RBUStack(UILayoutConstraintAxisHorizontal, 8, @[time, RBUSpacer(), state]);
  UILabel *model = RBULabel(RBUStr(item[@"model"]) ?: RBUMissing(), 14, UIFontWeightMedium, RBUStr(item[@"model"]) ? UIColor.labelColor : UIColor.secondaryLabelColor);
  model.lineBreakMode = NSLineBreakByTruncatingMiddle;
  NSString *agent = RBUStr(item[@"agent"]) ?: RBUStr(item[@"agentId"]) ?: RBUMissing();
  NSString *kind = RBUStr(item[@"kind"]) ? RBUKindLabel(item[@"kind"]) : RBUMissing();
  NSString *profile = RBUStr(item[@"profile"]) ?: RBUStr(item[@"profileId"]);
  NSMutableArray *context = [NSMutableArray arrayWithObjects:[@"Bot " stringByAppendingString:agent], kind, nil];
  if (profile) [context addObject:profile];
  UILabel *where = RBULabel([context componentsJoinedByString:@" · "], 12, UIFontWeightRegular, UIColor.secondaryLabelColor);
  where.lineBreakMode = NSLineBreakByTruncatingTail;
  NSMutableArray *numbers = [NSMutableArray arrayWithObject:[NSString stringWithFormat:@"%@ Token（%@ %@ / %@ %@）", RBUCount(RBUNum(item[@"total"])),
                                                                RBL(@"入", @"in"), RBUCount(RBUNum(item[@"input"])), RBL(@"出", @"out"), RBUCount(RBUNum(item[@"output"]))]];
  if (!RBIsChinese()) numbers[0] = [NSString stringWithFormat:@"%@ tokens (in %@ / out %@)", RBUCount(RBUNum(item[@"total"])), RBUCount(RBUNum(item[@"input"])), RBUCount(RBUNum(item[@"output"]))];
  [numbers addObject:[NSString stringWithFormat:@"%@ %@", RBL(@"耗时", @"Duration"), RBUDuration(item[@"durationMs"])]];
  if (RBUHas(item[@"cost"])) [numbers addObject:[NSString stringWithFormat:@"%@ %@", RBL(@"花费", @"Cost"), RBUCost(item[@"cost"])]];
  UILabel *usage = RBULabel([numbers componentsJoinedByString:@" · "], 12, UIFontWeightRegular, UIColor.secondaryLabelColor);
  usage.font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
  usage.numberOfLines = 0;
  NSMutableArray *lines = [NSMutableArray arrayWithObjects:top, model, where, usage, nil];
  if (RBUStr(item[@"error"])) {
    UILabel *error = RBULabel(item[@"error"], 12, UIFontWeightRegular, RBUFailColor());
    error.numberOfLines = 2;
    [lines addObject:error];
  }
  UIStackView *stack = RBUStack(UILayoutConstraintAxisVertical, 3, lines);
  stack.layoutMargins = UIEdgeInsetsMake(10, 0, 10, 0);
  stack.layoutMarginsRelativeArrangement = YES;
  stack.isAccessibilityElement = YES;
  stack.accessibilityLabel = [@[time.text, state.text, model.text, where.text, usage.text] componentsJoinedByString:@", "];
  return stack;
}

#pragma mark Legacy

- (void)renderLegacy {
  RBUCard *note = [[RBUCard alloc] initWithSpacing:4];
  [note.stack addArrangedSubview:[self sectionTitle:RBL(@"今日用量", @"Today's usage")]];
  UILabel *detail = RBULabel(RBL(@"当前 Host 版本较旧，只能显示今天的用量。升级 Host 后可查看趋势、拆分和请求明细。",
                                 @"This Host only reports today's usage. Update the Host for trends, breakdowns and requests."),
                             13, UIFontWeightRegular, UIColor.secondaryLabelColor);
  detail.numberOfLines = 0;
  [note.stack addArrangedSubview:detail];
  [self.content addArrangedSubview:note];
  NSDictionary *usage = self.legacy;
  UIView *total = [self metric:RBL(@"总 Token", @"Total tokens") value:RBUCount(RBUNum(usage[@"total"])) change:nil key:@"total" note:nil identifier:@"rokbot.usage.total"];
  UIView *input = [self metric:RBL(@"输入", @"Input") value:RBUCount(RBUNum(usage[@"input"])) change:nil key:@"input" note:nil identifier:@"rokbot.usage.input"];
  UIView *output = [self metric:RBL(@"输出", @"Output") value:RBUCount(RBUNum(usage[@"output"])) change:nil key:@"output" note:nil identifier:@"rokbot.usage.output"];
  UIStackView *pair = RBUStack(UILayoutConstraintAxisHorizontal, 10, @[input, output]);
  pair.distribution = UIStackViewDistributionFillEqually;
  pair.alignment = UIStackViewAlignmentFill;
  [self.content addArrangedSubview:total];
  [self.content addArrangedSubview:pair];
  if (RBUNum(usage[@"total"]) <= 0) [self.content addArrangedSubview:[self stateCard:RBL(@"今天暂无用量", @"No usage today") detail:nil retry:NO]];
}

@end

@interface RBUsageEntry : NSObject
@end
@implementation RBUsageEntry
+ (void)open { RBPresentController([RBUsageController new]); }
@end

BOOL RBReplaceUsageView(UIView *view) {
  if (!RBConnection.shared.isPaired || view.bounds.size.width < 300 || view.bounds.size.height < 44) return NO;
  if (RBHasAncestorPluginTag(view, 731989)) return NO;
  static NSSet<NSString *> *labels;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ labels = [NSSet setWithArray:@[@"用量", @"Usage"]]; });
  NSString *label = [view.accessibilityLabel stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  UIButton *button = (UIButton *)[view viewWithTag:731989];
  if (button && label.length) {
    NSString *childLabel = [button.accessibilityLabel stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (childLabel.length) {
      NSString *suffix = [@", " stringByAppendingString:childLabel];
      if (label.length > suffix.length && [label hasSuffix:suffix])
        label = [[label substringToIndex:label.length - suffix.length]
            stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    }
  }
  if (![labels containsObject:label]) return NO;
  RBRemoveDescendantPluginTag(view, 731989);
  if (button && button.superview != view) button = nil;
  if (!button) {
    button = [UIButton buttonWithType:UIButtonTypeCustom]; button.tag = 731989;
    button.frame = view.bounds;
    button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [button addTarget:RBUsageEntry.class action:@selector(open) forControlEvents:UIControlEventTouchUpInside];
    if (!view.userInteractionEnabled) view.userInteractionEnabled = YES;
    [view addSubview:button];
    RBTrackModifiedView(view);
  } else if (!CGRectEqualToRect(button.frame, view.bounds)) {
    button.frame = view.bounds;
  }
  NSString *localized = RBL(@"用量", @"Usage");
  if (![button.accessibilityLabel isEqualToString:localized]) button.accessibilityLabel = localized;
  if (![button.accessibilityIdentifier isEqualToString:@"rokbot.usage.open"]) button.accessibilityIdentifier = @"rokbot.usage.open";
  return YES;
}
