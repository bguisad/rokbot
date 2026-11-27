#import "RBTheme.h"

static UIColor *RBHex(uint32_t rgb, CGFloat alpha) {
  return [UIColor colorWithRed:((rgb >> 16) & 0xFF) / 255.0
                         green:((rgb >> 8) & 0xFF) / 255.0
                          blue:(rgb & 0xFF) / 255.0
                         alpha:alpha];
}
static UIColor *RBDynamic(UIColor *light, UIColor *dark) {
  return [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *traits) {
    return traits.userInterfaceStyle == UIUserInterfaceStyleDark ? dark : light;
  }];
}

UIColor *RBThemeChrome(void) { return RBDynamic(RBHex(0xFCFCFC, 1), RBHex(0x141414, 1)); }
UIColor *RBThemeElevated(void) { return RBDynamic(RBHex(0xFFFFFF, 1), RBHex(0x1E1E22, 1)); }
UIColor *RBThemeSecondaryFill(void) { return RBDynamic(RBHex(0x1C1C1C, 0x0F / 255.0), RBHex(0xFFFFFF, 0x1A / 255.0)); }
UIColor *RBThemeHover(void) { return RBDynamic(RBHex(0x1C1C1C, 0x0F / 255.0), RBHex(0xFFFFFF, 0x14 / 255.0)); }
UIColor *RBThemeBorder(void) { return RBDynamic(RBHex(0x1C1C1C, 0x1F / 255.0), RBHex(0xFFFFFF, 0x24 / 255.0)); }
UIColor *RBThemeTextPrimary(void) { return RBDynamic(RBHex(0x1C1C1C, 1), RBHex(0xF5F5F7, 1)); }
UIColor *RBThemeTextSecondary(void) { return RBDynamic(RBHex(0x1C1C1C, 0xAD / 255.0), RBHex(0xA1A1AA, 1)); }
UIColor *RBThemeTextMuted(void) { return RBDynamic(RBHex(0x1C1C1C, 0x8F / 255.0), RBHex(0x71717A, 1)); }
UIColor *RBThemeAccent(void) { return RBDynamic(RBHex(0x2F6FEB, 1), RBHex(0x5B9BFF, 1)); }
UIColor *RBThemeDanger(void) { return RBDynamic(RBHex(0xD93636, 1), RBHex(0xFF6B6B, 1)); }
UIColor *RBThemePrimaryButton(void) { return RBDynamic(RBHex(0x141414, 1), RBHex(0xF5F5F7, 1)); }
UIColor *RBThemeOnPrimaryButton(void) { return RBDynamic(RBHex(0xFFFFFF, 1), RBHex(0x141414, 1)); }
UIColor *RBThemeScrim(void) { return RBDynamic(RBHex(0x000000, 0.32), RBHex(0x000000, 0.55)); }

UIFont *RBThemeFont(CGFloat size, UIFontWeight weight) {
  UIFont *base = [UIFont systemFontOfSize:size weight:weight];
  return [[UIFontMetrics defaultMetrics] scaledFontForFont:base maximumPointSize:size * 1.8];
}

static void RBGlyphPath(RBGlyph glyph, CGFloat s, UIBezierPath *p, BOOL *fill) {
  *fill = NO;
  switch (glyph) {
    case RBGlyphCheck:
      [p moveToPoint:CGPointMake(s * 0.20, s * 0.52)];
      [p addLineToPoint:CGPointMake(s * 0.42, s * 0.73)];
      [p addLineToPoint:CGPointMake(s * 0.80, s * 0.30)];
      break;
    case RBGlyphChevronDown:
      [p moveToPoint:CGPointMake(s * 0.28, s * 0.40)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.62)];
      [p addLineToPoint:CGPointMake(s * 0.72, s * 0.40)];
      break;
    case RBGlyphChevronRight:
      [p moveToPoint:CGPointMake(s * 0.40, s * 0.28)];
      [p addLineToPoint:CGPointMake(s * 0.62, s * 0.50)];
      [p addLineToPoint:CGPointMake(s * 0.40, s * 0.72)];
      break;
    case RBGlyphBack:
      [p moveToPoint:CGPointMake(s * 0.60, s * 0.24)];
      [p addLineToPoint:CGPointMake(s * 0.34, s * 0.50)];
      [p addLineToPoint:CGPointMake(s * 0.60, s * 0.76)];
      break;
    case RBGlyphClose:
      [p moveToPoint:CGPointMake(s * 0.30, s * 0.30)];
      [p addLineToPoint:CGPointMake(s * 0.70, s * 0.70)];
      [p moveToPoint:CGPointMake(s * 0.70, s * 0.30)];
      [p addLineToPoint:CGPointMake(s * 0.30, s * 0.70)];
      break;
    case RBGlyphPlus:
      [p moveToPoint:CGPointMake(s * 0.50, s * 0.22)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.78)];
      [p moveToPoint:CGPointMake(s * 0.22, s * 0.50)];
      [p addLineToPoint:CGPointMake(s * 0.78, s * 0.50)];
      break;
    case RBGlyphArrowUp:
      [p moveToPoint:CGPointMake(s * 0.50, s * 0.78)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.22)];
      [p moveToPoint:CGPointMake(s * 0.28, s * 0.44)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.22)];
      [p addLineToPoint:CGPointMake(s * 0.72, s * 0.44)];
      break;
    case RBGlyphArrowDown:
      [p moveToPoint:CGPointMake(s * 0.50, s * 0.22)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.78)];
      [p moveToPoint:CGPointMake(s * 0.28, s * 0.56)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.78)];
      [p addLineToPoint:CGPointMake(s * 0.72, s * 0.56)];
      break;
    case RBGlyphBolt:
      *fill = YES;
      [p moveToPoint:CGPointMake(s * 0.56, s * 0.08)];
      [p addLineToPoint:CGPointMake(s * 0.20, s * 0.56)];
      [p addLineToPoint:CGPointMake(s * 0.46, s * 0.56)];
      [p addLineToPoint:CGPointMake(s * 0.40, s * 0.92)];
      [p addLineToPoint:CGPointMake(s * 0.80, s * 0.42)];
      [p addLineToPoint:CGPointMake(s * 0.53, s * 0.42)];
      [p closePath];
      break;
    case RBGlyphSparkle: {
      *fill = YES;
      CGFloat c = s * 0.46, r = s * 0.38, k = s * 0.08;
      [p moveToPoint:CGPointMake(c, c - r)];
      [p addQuadCurveToPoint:CGPointMake(c + r, c) controlPoint:CGPointMake(c + k, c - k)];
      [p addQuadCurveToPoint:CGPointMake(c, c + r) controlPoint:CGPointMake(c + k, c + k)];
      [p addQuadCurveToPoint:CGPointMake(c - r, c) controlPoint:CGPointMake(c - k, c + k)];
      [p addQuadCurveToPoint:CGPointMake(c, c - r) controlPoint:CGPointMake(c - k, c - k)];
      [p closePath];
      CGFloat c2x = s * 0.80, c2y = s * 0.78, r2 = s * 0.14, k2 = s * 0.03;
      [p moveToPoint:CGPointMake(c2x, c2y - r2)];
      [p addQuadCurveToPoint:CGPointMake(c2x + r2, c2y) controlPoint:CGPointMake(c2x + k2, c2y - k2)];
      [p addQuadCurveToPoint:CGPointMake(c2x, c2y + r2) controlPoint:CGPointMake(c2x + k2, c2y + k2)];
      [p addQuadCurveToPoint:CGPointMake(c2x - r2, c2y) controlPoint:CGPointMake(c2x - k2, c2y + k2)];
      [p addQuadCurveToPoint:CGPointMake(c2x, c2y - r2) controlPoint:CGPointMake(c2x - k2, c2y - k2)];
      [p closePath];
      break;
    }
    case RBGlyphPencil:
      [p moveToPoint:CGPointMake(s * 0.22, s * 0.78)];
      [p addLineToPoint:CGPointMake(s * 0.26, s * 0.62)];
      [p addLineToPoint:CGPointMake(s * 0.64, s * 0.24)];
      [p addLineToPoint:CGPointMake(s * 0.76, s * 0.36)];
      [p addLineToPoint:CGPointMake(s * 0.38, s * 0.74)];
      [p closePath];
      break;
    case RBGlyphTrash:
      [p moveToPoint:CGPointMake(s * 0.22, s * 0.30)];
      [p addLineToPoint:CGPointMake(s * 0.78, s * 0.30)];
      [p moveToPoint:CGPointMake(s * 0.40, s * 0.30)];
      [p addLineToPoint:CGPointMake(s * 0.42, s * 0.20)];
      [p addLineToPoint:CGPointMake(s * 0.58, s * 0.20)];
      [p addLineToPoint:CGPointMake(s * 0.60, s * 0.30)];
      [p moveToPoint:CGPointMake(s * 0.29, s * 0.30)];
      [p addLineToPoint:CGPointMake(s * 0.33, s * 0.80)];
      [p addLineToPoint:CGPointMake(s * 0.67, s * 0.80)];
      [p addLineToPoint:CGPointMake(s * 0.71, s * 0.30)];
      break;
    case RBGlyphSend:
      [p moveToPoint:CGPointMake(s * 0.50, s * 0.80)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.22)];
      [p moveToPoint:CGPointMake(s * 0.27, s * 0.45)];
      [p addLineToPoint:CGPointMake(s * 0.50, s * 0.22)];
      [p addLineToPoint:CGPointMake(s * 0.73, s * 0.45)];
      break;
    case RBGlyphPerson:
      [p appendPath:[UIBezierPath bezierPathWithOvalInRect:CGRectMake(s * 0.36, s * 0.18, s * 0.28, s * 0.28)]];
      [p moveToPoint:CGPointMake(s * 0.20, s * 0.82)];
      [p addCurveToPoint:CGPointMake(s * 0.80, s * 0.82)
           controlPoint1:CGPointMake(s * 0.22, s * 0.52)
           controlPoint2:CGPointMake(s * 0.78, s * 0.52)];
      break;
    case RBGlyphGroup:
      [p appendPath:[UIBezierPath bezierPathWithOvalInRect:CGRectMake(s * 0.22, s * 0.20, s * 0.24, s * 0.24)]];
      [p appendPath:[UIBezierPath bezierPathWithOvalInRect:CGRectMake(s * 0.56, s * 0.24, s * 0.20, s * 0.20)]];
      [p moveToPoint:CGPointMake(s * 0.08, s * 0.80)];
      [p addCurveToPoint:CGPointMake(s * 0.60, s * 0.80)
           controlPoint1:CGPointMake(s * 0.10, s * 0.52)
           controlPoint2:CGPointMake(s * 0.58, s * 0.52)];
      [p moveToPoint:CGPointMake(s * 0.62, s * 0.56)];
      [p addCurveToPoint:CGPointMake(s * 0.92, s * 0.80)
           controlPoint1:CGPointMake(s * 0.80, s * 0.52)
           controlPoint2:CGPointMake(s * 0.91, s * 0.64)];
      break;
  }
}

UIImage *RBGlyphImage(RBGlyph glyph, CGFloat size, CGFloat lineWidth) {
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  UIGraphicsImageRenderer *renderer =
      [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(size, size) format:format];
  UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
    UIBezierPath *path = [UIBezierPath bezierPath];
    BOOL fill = NO;
    RBGlyphPath(glyph, size, path, &fill);
    path.lineWidth = lineWidth > 0 ? lineWidth : MAX(1.5, size / 11.0);
    path.lineCapStyle = kCGLineCapRound;
    path.lineJoinStyle = kCGLineJoinRound;
    [UIColor.blackColor setStroke];
    [UIColor.blackColor setFill];
    if (fill) [path fill];
    else [path stroke];
  }];
  return [image imageWithRenderingMode:UIImageRenderingModeAlwaysTemplate];
}

UIView *RBThemeCard(CGFloat radius) {
  UIView *card = [UIView new];
  card.backgroundColor = RBThemeElevated();
  card.layer.cornerRadius = radius;
  card.layer.cornerCurve = kCACornerCurveContinuous;
  card.layer.borderWidth = 1.0 / UIScreen.mainScreen.scale;
  card.layer.borderColor = RBThemeBorder().CGColor;
  card.clipsToBounds = YES;
  return card;
}

void RBThemeStyleButton(UIButton *button, NSString *title, BOOL primary) {
  UIButtonConfiguration *config = primary ? UIButtonConfiguration.filledButtonConfiguration
                                          : UIButtonConfiguration.plainButtonConfiguration;
  config.title = title;
  config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  config.baseBackgroundColor = primary ? RBThemePrimaryButton() : RBThemeSecondaryFill();
  config.baseForegroundColor = primary ? RBThemeOnPrimaryButton() : RBThemeTextPrimary();
  config.background.backgroundColor = primary ? RBThemePrimaryButton() : RBThemeSecondaryFill();
  config.titleTextAttributesTransformer = ^NSDictionary *(NSDictionary *attributes) {
    NSMutableDictionary *next = [attributes mutableCopy];
    next[NSFontAttributeName] = RBThemeFont(15, UIFontWeightSemibold);
    return next;
  };
  config.contentInsets = NSDirectionalEdgeInsetsMake(10, 16, 10, 16);
  button.configuration = config;
}
