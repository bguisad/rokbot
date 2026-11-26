#import "RBAvatarStyle.h"
#import "RBLocalize.h"
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <math.h>

NSNotificationName const RBAvatarStyleDidChangeNotification = @"RokBotAvatarStyleDidChange";
static NSString *const RBAvatarStyleDefaultsKey = @"RokBotLocal.avatarStyle";
static const NSInteger RBAvatarOverlayTag = 731994;
static const void *RBAvatarSampleAssocKey = &RBAvatarSampleAssocKey;
static const int RBAvatarMaskDim = 64;

extern void RBTrackModifiedView(UIView *view);

typedef struct {
  __unsafe_unretained NSString *styleId;
  __unsafe_unretained NSString *zh;
  __unsafe_unretained NSString *en;
  __unsafe_unretained NSString *descZh;
  __unsafe_unretained NSString *descEn;
  uint32_t previewHex;
  __unsafe_unretained NSString *previewShape;
} RBAvatarStyleMeta;

static const RBAvatarStyleMeta RBAvatarStyles[] = {
  { @"chassis", @"机甲灵偶", @"RokBot Chassis", @"全形状兼容 + 脉冲灯", @"Shape-aware + beacon", 0x06B6D4, @"blob" },
  { @"antenna", @"双天线波波", @"Twin Antenna", @"弹性天线 + 玻璃面罩", @"Antennas + visor", 0x8B5CF6, @"cloud" },
  { @"visor", @"赛博护目镜", @"Cyber Visor", @"切角框 + 扫描灯", @"Cyber visor + scan", 0xF97316, @"hex" },
  { @"pixel", @"像素精灵", @"Pixel Sprite", @"点阵屏幕 + 节奏条", @"LED matrix + bar", 0x10B981, @"star" },
  { @"orb", @"流体光球", @"Fluid Orb", @"呼吸微动 + 轨道星", @"Breathing + dot", 0xEC4899, @"heart" },
  { @"official", @"官方原版", @"Official", @"保留官方流体球", @"Original fluid orb", 0x3B82F6, @"blob" },
};
static const NSUInteger RBAvatarStylesCount = sizeof(RBAvatarStyles) / sizeof(RBAvatarStyles[0]);

@interface RBAvatarSample : NSObject
@property(nonatomic, strong) UIColor *color;
@property(nonatomic, strong, nullable) UIImage *maskImage;
@property(nonatomic, assign) CGSize sampledParentSize;
@property(nonatomic, assign) CFTimeInterval sampledAt;
@end

@implementation RBAvatarSample
@end

static BOOL RBAvatarIsValidStyle(NSString *styleId) {
  if (![styleId isKindOfClass:NSString.class]) return NO;
  for (NSUInteger i = 0; i < RBAvatarStylesCount; i++) {
    if ([RBAvatarStyles[i].styleId isEqualToString:styleId]) return YES;
  }
  return NO;
}

NSString *RBAvatarCurrentStyle(void) {
  NSString *stored = [NSUserDefaults.standardUserDefaults stringForKey:RBAvatarStyleDefaultsKey];
  return RBAvatarIsValidStyle(stored) ? stored : @"chassis";
}

void RBSetAvatarStyle(NSString *styleId) {
  if (!RBAvatarIsValidStyle(styleId)) return;
  [NSUserDefaults.standardUserDefaults setObject:styleId forKey:RBAvatarStyleDefaultsKey];
  [NSUserDefaults.standardUserDefaults synchronize];
  [NSNotificationCenter.defaultCenter postNotificationName:RBAvatarStyleDidChangeNotification object:nil];
}

static UIColor *RBColorFromHex(uint32_t hex) {
  CGFloat r = ((hex >> 16) & 0xFF) / 255.0;
  CGFloat g = ((hex >> 8) & 0xFF) / 255.0;
  CGFloat b = (hex & 0xFF) / 255.0;
  return [UIColor colorWithRed:r green:g blue:b alpha:1.0];
}

static UIColor *RBMixColor(CGFloat r, CGFloat g, CGFloat b, CGFloat tr, CGFloat tg, CGFloat tb, CGFloat amt) {
  return [UIColor colorWithRed:fmax(0.0, fmin(1.0, r + (tr - r) * amt))
                         green:fmax(0.0, fmin(1.0, g + (tg - g) * amt))
                          blue:fmax(0.0, fmin(1.0, b + (tb - b) * amt))
                         alpha:1.0];
}

static void RBBuildPalette(UIColor *base, BOOL isDark,
                           UIColor * __autoreleasing *outTop,
                           UIColor * __autoreleasing *outMid,
                           UIColor * __autoreleasing *outBot,
                           UIColor * __autoreleasing *outAccent) {
  CGFloat r = 0.02, g = 0.71, b = 0.83, a = 1.0;
  if (base && ![base getRed:&r green:&g blue:&b alpha:&a]) {
    const CGFloat *comps = CGColorGetComponents(base.CGColor);
    size_t n = CGColorGetNumberOfComponents(base.CGColor);
    if (n >= 2) { r = g = b = comps[0]; }
  }
  CGFloat lum = 0.299 * r + 0.587 * g + 0.114 * b;
  CGFloat sat = fmax(r, fmax(g, b)) - fmin(r, fmin(g, b));
  if (lum < 0.19 && sat < 0.11) {
    if (isDark) {
      *outTop = RBColorFromHex(0x64748B);
      *outMid = RBColorFromHex(0x334155);
      *outBot = RBColorFromHex(0x0F172A);
      *outAccent = RBColorFromHex(0x38BDF8);
    } else {
      *outTop = RBColorFromHex(0x475569);
      *outMid = RBColorFromHex(0x1E293B);
      *outBot = RBColorFromHex(0x090D16);
      *outAccent = RBColorFromHex(0x38BDF8);
    }
    return;
  }
  *outTop = RBMixColor(r, g, b, 1.0, 1.0, 1.0, 0.24);
  *outMid = [UIColor colorWithRed:r green:g blue:b alpha:1.0];
  *outBot = RBMixColor(r, g, b, 10.0 / 255.0, 15.0 / 255.0, 28.0 / 255.0, 0.34);
  *outAccent = RBMixColor(r, g, b, 1.0, 1.0, 1.0, 0.56);
}

static CGPathRef RBBlobPath100(void) {
  static CGMutablePathRef path;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 33, 14);
    CGPathAddCurveToPoint(path, NULL, 40, 14, 47, 14, 53, 14);
    CGPathAddCurveToPoint(path, NULL, 60, 14, 65, 6, 74, 5.5);
    CGPathAddCurveToPoint(path, NULL, 82, 5, 87, 10, 86, 17);
    CGPathAddCurveToPoint(path, NULL, 86, 21, 91, 27, 93, 36);
    CGPathAddCurveToPoint(path, NULL, 94, 45, 94, 55, 93, 64);
    CGPathAddCurveToPoint(path, NULL, 91, 80, 80, 90, 62, 92);
    CGPathAddCurveToPoint(path, NULL, 52, 93, 41, 94, 32, 93);
    CGPathAddCurveToPoint(path, NULL, 15, 92, 7, 82, 7, 65);
    CGPathAddCurveToPoint(path, NULL, 6, 54, 6, 41, 7, 33);
    CGPathAddCurveToPoint(path, NULL, 8, 20, 18, 14, 33, 14);
    CGPathCloseSubpath(path);
  });
  return path;
}

static CGPathRef RBCloudPath100(void) {
  static CGMutablePathRef path;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 28, 74);
    CGPathAddCurveToPoint(path, NULL, 16, 74, 8, 66, 8, 55);
    CGPathAddCurveToPoint(path, NULL, 8, 46, 14, 39, 22, 37);
    CGPathAddCurveToPoint(path, NULL, 24, 25, 35, 16, 48, 16);
    CGPathAddCurveToPoint(path, NULL, 60, 16, 70, 23, 73, 34);
    CGPathAddCurveToPoint(path, NULL, 83, 35, 92, 43, 92, 54);
    CGPathAddCurveToPoint(path, NULL, 92, 65, 83, 74, 71, 74);
    CGPathCloseSubpath(path);
  });
  return path;
}

static CGPathRef RBHexPath100(void) {
  static CGMutablePathRef path;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 50, 8);
    CGPathAddLineToPoint(path, NULL, 86, 29);
    CGPathAddLineToPoint(path, NULL, 86, 71);
    CGPathAddLineToPoint(path, NULL, 50, 92);
    CGPathAddLineToPoint(path, NULL, 14, 71);
    CGPathAddLineToPoint(path, NULL, 14, 29);
    CGPathCloseSubpath(path);
  });
  return path;
}

static CGPathRef RBStarPath100(void) {
  static CGMutablePathRef path;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 50, 8);
    CGPathAddLineToPoint(path, NULL, 62, 33);
    CGPathAddLineToPoint(path, NULL, 90, 37);
    CGPathAddLineToPoint(path, NULL, 69, 57);
    CGPathAddLineToPoint(path, NULL, 74, 85);
    CGPathAddLineToPoint(path, NULL, 50, 72);
    CGPathAddLineToPoint(path, NULL, 26, 85);
    CGPathAddLineToPoint(path, NULL, 31, 57);
    CGPathAddLineToPoint(path, NULL, 10, 37);
    CGPathAddLineToPoint(path, NULL, 38, 33);
    CGPathCloseSubpath(path);
  });
  return path;
}

static CGPathRef RBHeartPath100(void) {
  static CGMutablePathRef path;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 50, 88);
    CGPathAddCurveToPoint(path, NULL, 20, 68, 8, 49, 8, 33);
    CGPathAddCurveToPoint(path, NULL, 8, 20, 18, 11, 30, 11);
    CGPathAddCurveToPoint(path, NULL, 39, 11, 46, 16, 50, 23);
    CGPathAddCurveToPoint(path, NULL, 54, 16, 61, 11, 70, 11);
    CGPathAddCurveToPoint(path, NULL, 82, 11, 92, 20, 92, 33);
    CGPathAddCurveToPoint(path, NULL, 92, 49, 80, 68, 50, 88);
    CGPathCloseSubpath(path);
  });
  return path;
}

static CGPathRef RBPathForPreviewShape(NSString *shape) {
  if ([shape isEqualToString:@"cloud"]) return RBCloudPath100();
  if ([shape isEqualToString:@"hex"]) return RBHexPath100();
  if ([shape isEqualToString:@"star"]) return RBStarPath100();
  if ([shape isEqualToString:@"heart"]) return RBHeartPath100();
  return RBBlobPath100();
}

static CGGradientRef RBCreateBodyGradient(UIColor *top, UIColor *mid, UIColor *bot) {
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  NSArray *colors = @[ (id)top.CGColor, (id)mid.CGColor, (id)bot.CGColor ];
  CGFloat locs[3] = { 0.0, 0.55, 1.0 };
  CGGradientRef grad = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)colors, locs);
  CGColorSpaceRelease(cs);
  return grad;
}

static void RBDrawRoundedRect(CGContextRef ctx, CGRect r, CGFloat radius) {
  CGFloat rr = fmin(radius, fmin(r.size.width * 0.5, r.size.height * 0.5));
  CGPathRef path = CGPathCreateWithRoundedRect(r, rr, rr, NULL);
  CGContextAddPath(ctx, path);
  CGPathRelease(path);
}

static void RBDrawTiltedCapsule(CGContextRef ctx, CGFloat cx, CGFloat cy,
                                CGFloat w, CGFloat h, CGFloat deg, CGFloat scaleY) {
  CGContextSaveGState(ctx);
  CGContextTranslateCTM(ctx, cx, cy);
  CGContextRotateCTM(ctx, deg * M_PI / 180.0);
  CGContextScaleCTM(ctx, 1.0, scaleY);
  RBDrawRoundedRect(ctx, CGRectMake(-w * 0.5, -h * 0.5, w, h), w * 0.5);
  CGContextFillPath(ctx);
  CGContextRestoreGState(ctx);
}

/// Fills an extracted 64x64 shape mask (in 0..100 coordinates) or procedural preview path with
/// RokBot's 3-stop vertical gradient and subtle outer rim.
static void RBDrawShapeBody100(CGContextRef ctx, UIImage * _Nullable maskImage,
                               NSString * _Nullable previewShape,
                               UIColor *top, UIColor *mid, UIColor *bot, BOOL isDark) {
  CGColorRef rimColor = isDark
      ? [UIColor colorWithWhite:1.0 alpha:0.22].CGColor
      : [UIColor colorWithRed:15.0 / 255.0 green:23.0 / 255.0 blue:42.0 / 255.0 alpha:0.18].CGColor;
  CGImageRef mask = maskImage.CGImage;
  if (mask) {
    CGRect box = CGRectMake(0.0, 0.0, 100.0, 100.0);
    // Subtle outer rim behind mask
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, 50.0, 50.0);
    CGContextScaleCTM(ctx, 1.045, 1.045);
    CGContextTranslateCTM(ctx, -50.0, -50.0);
    CGContextTranslateCTM(ctx, 0.0, 100.0);
    CGContextScaleCTM(ctx, 1.0, -1.0);
    CGContextClipToMask(ctx, box, mask);
    CGContextSetFillColorWithColor(ctx, rimColor);
    CGContextFillRect(ctx, box);
    CGContextRestoreGState(ctx);

    // Gradient body clipped to the exact Bot silhouette
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, 0.0, 100.0);
    CGContextScaleCTM(ctx, 1.0, -1.0);
    CGContextClipToMask(ctx, box, mask);
    CGContextTranslateCTM(ctx, 0.0, 100.0);
    CGContextScaleCTM(ctx, 1.0, -1.0);
    CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
    CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, 8), CGPointMake(0, 92), 0);
    CGGradientRelease(grad);
    CGContextRestoreGState(ctx);
    return;
  }

  CGPathRef path = RBPathForPreviewShape(previewShape);
  CGContextSaveGState(ctx);
  CGContextAddPath(ctx, path);
  CGContextClip(ctx);
  CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
  CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, 8), CGPointMake(0, 92), 0);
  CGGradientRelease(grad);
  CGContextRestoreGState(ctx);

  CGContextSetStrokeColorWithColor(ctx, rimColor);
  CGContextSetLineWidth(ctx, 2.4);
  CGContextAddPath(ctx, path);
  CGContextStrokePath(ctx);
}

static void RBDrawAvatar(CGContextRef ctx, NSString *styleId, UIImage * _Nullable maskImage,
                         NSString * _Nullable previewShape, CGFloat s,
                         NSTimeInterval t, CGFloat blink, BOOL active,
                         UIColor *baseColor, BOOL isDark) {
  if (s <= 0) return;
  if ([styleId isEqualToString:@"official"]) {
    UIColor *top = RBColorFromHex(0x60A5FA);
    UIColor *mid = RBColorFromHex(0x3B82F6);
    UIColor *bot = RBColorFromHex(0x1D4ED8);
    CGFloat r = s * 0.36;
    CGRect circle = CGRectMake(s * 0.5 - r, s * 0.5 - r, r * 2.0, r * 2.0);
    CGContextSaveGState(ctx);
    CGContextAddEllipseInRect(ctx, circle);
    CGContextClip(ctx);
    CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
    CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, CGRectGetMinY(circle)),
                                CGPointMake(0, CGRectGetMaxY(circle)), 0);
    CGGradientRelease(grad);
    CGContextRestoreGState(ctx);
    CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
    CGFloat ew = s * 0.10, eh = s * 0.22;
    RBDrawRoundedRect(ctx, CGRectMake(s * 0.33, s * 0.5 - eh * 0.5, ew, eh), ew * 0.5);
    CGContextFillPath(ctx);
    RBDrawRoundedRect(ctx, CGRectMake(s * 0.57, s * 0.5 - eh * 0.5, ew, eh), ew * 0.5);
    CGContextFillPath(ctx);
    return;
  }

  UIColor *top = nil, *mid = nil, *bot = nil, *accent = nil;
  RBBuildPalette(baseColor, isDark, &top, &mid, &bot, &accent);
  CGFloat sc = s / 100.0;

  if ([styleId isEqualToString:@"antenna"]) {
    CGContextSaveGState(ctx);
    CGFloat bob = active ? sin(t * 7.0) * s * 0.022 : sin(t * 2.4) * s * 0.010;
    CGFloat sway = sin(t * (active ? 7.5 : 2.6)) * 0.14;
    CGContextTranslateCTM(ctx, 0, bob);
    CGContextScaleCTM(ctx, sc, sc);

    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetLineWidth(ctx, 4.0);
    for (int side = -1; side <= 1; side += 2) {
      CGFloat rootX = 50.0 + side * 14.0;
      CGFloat rootY = 27.0;
      CGFloat tipX = rootX + side * 6.0 + sin(t * 3.0 + side) * 2.2 + sway * 7.0;
      CGFloat tipY = 8.0 + fabs(sway) * 2.0;
      CGContextSetStrokeColorWithColor(ctx, mid.CGColor);
      CGContextMoveToPoint(ctx, rootX, rootY);
      CGContextAddQuadCurveToPoint(ctx, rootX + side * 2.0, (rootY + tipY) * 0.5, tipX, tipY);
      CGContextStrokePath(ctx);

      if (active) {
        CGFloat pulse = fmod(t * 1.8 + (side > 0 ? 0.5 : 0.0), 1.0);
        CGFloat pr = 3.8 + pulse * 6.5;
        CGContextSetStrokeColorWithColor(ctx, [accent colorWithAlphaComponent:(1.0 - pulse) * 0.6].CGColor);
        CGContextSetLineWidth(ctx, 1.8);
        CGContextAddEllipseInRect(ctx, CGRectMake(tipX - pr, tipY - pr, pr * 2.0, pr * 2.0));
        CGContextStrokePath(ctx);
        CGContextSetLineWidth(ctx, 4.0);
      }
      CGFloat tr = 4.4;
      CGContextSetFillColorWithColor(ctx, accent.CGColor);
      CGContextFillEllipseInRect(ctx, CGRectMake(tipX - tr, tipY - tr, tr * 2.0, tr * 2.0));
    }

    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, 50.0, 57.0);
    CGContextScaleCTM(ctx, 0.84, 0.84);
    CGContextTranslateCTM(ctx, -50.0, -50.0);
    RBDrawShapeBody100(ctx, maskImage, previewShape, top, mid, bot, isDark);
    CGContextRestoreGState(ctx);

    CGFloat vw = 44.0, vh = 24.0, vx = 50.0 - vw * 0.5, vy = 56.0 - vh * 0.5;
    CGContextSetFillColorWithColor(ctx, RBColorFromHex(0x0F172A).CGColor);
    RBDrawRoundedRect(ctx, CGRectMake(vx, vy, vw, vh), vh * 0.45);
    CGContextFillPath(ctx);

    CGFloat gx = active ? sin(t * 4.5) * vw * 0.07 : 0.0;
    CGFloat gy = active ? -vh * 0.06 : 0.0;
    CGFloat eh = vh * 0.48 * fmax(0.1, 1.0 - blink);
    CGFloat ew = vw * 0.18;
    for (int side = -1; side <= 1; side += 2) {
      CGFloat ex = vx + vw * 0.5 + side * vw * 0.21 + gx;
      CGFloat ey = vy + vh * 0.5 + gy;
      CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
      CGContextFillEllipseInRect(ctx, CGRectMake(ex - ew * 0.5, ey - eh * 0.5, ew, eh));
      if (eh > 5.0) {
        CGFloat gr = ew * 0.16;
        CGContextSetFillColorWithColor(ctx, accent.CGColor);
        CGContextFillEllipseInRect(ctx, CGRectMake(ex - ew * 0.12 - gr, ey - eh * 0.16 - gr, gr * 2.0, gr * 2.0));
      }
    }
    CGContextRestoreGState(ctx);
    return;
  }

  if ([styleId isEqualToString:@"visor"]) {
    CGContextSaveGState(ctx);
    CGFloat bob = active ? sin(t * 7.2) * s * 0.02 : sin(t * 2.0) * s * 0.01;
    CGContextTranslateCTM(ctx, 0, bob);
    CGContextScaleCTM(ctx, sc, sc);

    RBDrawShapeBody100(ctx, maskImage, previewShape, top, mid, bot, isDark);

    CGFloat vw = 50.0, vh = 22.0, vx = 50.0 - vw * 0.5, vy = 52.0 - vh * 0.5;
    CGContextSetFillColorWithColor(ctx, RBColorFromHex(0x090D16).CGColor);
    RBDrawRoundedRect(ctx, CGRectMake(vx, vy, vw, vh), 6.5);
    CGContextFillPath(ctx);

    if (active) {
      CGFloat pos = (sin(t * 2.4) + 1.0) * 0.5;
      CGFloat beamX = vx + vw * 0.18 + pos * vw * 0.64;
      CGFloat beamW = vw * 0.24;
      CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
      NSArray *colors = @[
        (id)[accent colorWithAlphaComponent:0.0].CGColor,
        (id)accent.CGColor,
        (id)[accent colorWithAlphaComponent:0.0].CGColor,
      ];
      CGFloat locs[3] = { 0.0, 0.5, 1.0 };
      CGGradientRef beamGrad = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)colors, locs);
      CGColorSpaceRelease(cs);
      CGContextSaveGState(ctx);
      RBDrawRoundedRect(ctx, CGRectMake(vx + vw * 0.08, vy + vh * 0.32, vw * 0.84, vh * 0.36), vh * 0.18);
      CGContextClip(ctx);
      CGContextDrawLinearGradient(ctx, beamGrad, CGPointMake(beamX - beamW, 0), CGPointMake(beamX + beamW, 0), 0);
      CGGradientRelease(beamGrad);
      CGContextRestoreGState(ctx);
    } else {
      CGContextSetFillColorWithColor(ctx, accent.CGColor);
      CGFloat h = vh * 0.46 * fmax(0.12, 1.0 - blink);
      for (int side = -1; side <= 1; side += 2) {
        CGFloat cx = vx + vw * 0.5 + side * vw * 0.21;
        CGFloat cy = vy + vh * 0.5;
        RBDrawRoundedRect(ctx, CGRectMake(cx - vw * 0.07, cy - h * 0.5, vw * 0.14, h), 2.6);
        CGContextFillPath(ctx);
      }
    }
    CGContextRestoreGState(ctx);
    return;
  }

  if ([styleId isEqualToString:@"pixel"]) {
    CGContextSaveGState(ctx);
    if (active) CGContextTranslateCTM(ctx, 0, sin(t * 7.0) * s * 0.018);
    CGContextScaleCTM(ctx, sc, sc);

    RBDrawShapeBody100(ctx, maskImage, previewShape, top, mid, bot, isDark);

    CGFloat mw = 42.0, mh = 31.0, mx = 50.0 - mw * 0.5, my = 55.0 - mh * 0.5;
    CGContextSetFillColorWithColor(ctx, RBColorFromHex(0x0B101B).CGColor);
    RBDrawRoundedRect(ctx, CGRectMake(mx, my, mw, mh), 6.0);
    CGContextFillPath(ctx);

    CGFloat cellW = mw / 9.0, cellH = mh / 7.0;
    CGFloat px = fmax(1.2, cellW * 0.72), py = fmax(1.2, cellH * 0.72);
    if (active) {
      int activeIdx = ((int)floor(t * 4.0)) % 3;
      for (int i = 0; i < 3; i++) {
        UIColor *col = (i == activeIdx) ? accent : [UIColor colorWithWhite:1.0 alpha:0.28];
        CGContextSetFillColorWithColor(ctx, col.CGColor);
        CGContextFillRect(ctx, CGRectMake(mx + (2 + i * 2 + 0.65) * cellW, my + 3.65 * cellH, px, py));
      }
    } else {
      CGContextSetFillColorWithColor(ctx, RBColorFromHex(0xF8FAFC).CGColor);
      BOOL closed = blink > 0.55;
      int bases[2] = { 2, 5 };
      for (int k = 0; k < 2; k++) {
        CGFloat dx = mx + (bases[k] + 0.65) * cellW;
        if (closed) {
          CGContextFillRect(ctx, CGRectMake(dx, my + 3.65 * cellH, px, py));
        } else {
          CGContextFillRect(ctx, CGRectMake(dx, my + 2.65 * cellH, px, py));
          CGContextFillRect(ctx, CGRectMake(dx, my + 3.65 * cellH, px, py));
        }
      }
    }
    int barPhase = ((int)floor(t * 3.0)) % 3;
    for (int i = 0; i < 3; i++) {
      UIColor *col = (active && i == barPhase) ? UIColor.whiteColor : accent;
      CGContextSetFillColorWithColor(ctx, col.CGColor);
      CGContextFillRect(ctx, CGRectMake(50.0 - 11.0 + i * 8.2, my - 6.2, 5.6, 2.8));
    }
    CGContextRestoreGState(ctx);
    return;
  }

  if ([styleId isEqualToString:@"orb"]) {
    CGContextSaveGState(ctx);
    double speed = active ? 3.2 : 1.9;
    double wave = active ? 0.055 : 0.04;
    CGFloat sx = 1.0 + wave * sin(t * speed);
    CGFloat sy = 1.0 + wave * cos(t * speed * 1.15);

    CGContextTranslateCTM(ctx, s * 0.5, s * 0.5);
    CGContextRotateCTM(ctx, sin(t * speed * 0.7) * 0.035);
    CGContextScaleCTM(ctx, sx, sy);
    CGContextTranslateCTM(ctx, -s * 0.5, -s * 0.5);
    CGContextScaleCTM(ctx, sc, sc);

    RBDrawShapeBody100(ctx, maskImage, previewShape, top, mid, bot, isDark);

    CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
    CGFloat eyeSy = fmax(0.1, 1.0 - blink);
    CGFloat gx = active ? sin(t * 4.0) * 3.0 : 0.0;
    CGFloat gy = active ? -2.2 : 0.0;
    RBDrawTiltedCapsule(ctx, 40.5 + gx, 52.0 + gy, 9.2, 22.0, -24.0, eyeSy);
    RBDrawTiltedCapsule(ctx, 59.5 + gx, 48.0 + gy, 9.2, 18.0, -24.0, eyeSy);

    double satA = t * (active ? 2.8 : 1.1) - 0.8;
    CGFloat satDist = 44.0;
    CGFloat satR = 4.6;
    CGContextSetFillColorWithColor(ctx, accent.CGColor);
    CGContextFillEllipseInRect(ctx, CGRectMake(50.0 + cos(satA) * satDist - satR,
                                              50.0 + sin(satA) * satDist * 0.88 - satR,
                                              satR * 2.0, satR * 2.0));
    CGContextRestoreGState(ctx);
    return;
  }

  // Default: chassis
  CGContextSaveGState(ctx);
  CGFloat breath = 1.0 + sin(t * 2.8) * 0.024;
  CGFloat bob = active ? sin(t * 3.4) * s * 0.016 : sin(t * 2.2) * s * 0.010;
  CGFloat tilt = active ? sin(t * 2.4) * 0.055 : 0.0;

  CGContextTranslateCTM(ctx, s * 0.5, s * 0.5 + bob);
  CGContextRotateCTM(ctx, tilt);
  CGContextScaleCTM(ctx, breath, breath);
  CGContextTranslateCTM(ctx, -s * 0.5, -s * 0.5);
  CGContextScaleCTM(ctx, sc, sc);

  RBDrawShapeBody100(ctx, maskImage, previewShape, top, mid, bot, isDark);

  CGFloat bx = 74.0, by = 22.0;
  CGFloat beaconScale = active ? (0.85 + fabs(sin(t * 7.0)) * 0.45) : (1.0 + sin(t * 3.0) * 0.12);
  if (active) {
    CGFloat halo = fmod(t * 1.4, 1.0);
    CGFloat hr = 4.2 + halo * 7.2;
    CGContextSetStrokeColorWithColor(ctx, [accent colorWithAlphaComponent:(1.0 - halo) * 0.65].CGColor);
    CGContextSetLineWidth(ctx, 1.8);
    CGContextAddEllipseInRect(ctx, CGRectMake(bx - hr, by - hr, hr * 2.0, hr * 2.0));
    CGContextStrokePath(ctx);
  }
  CGFloat br = 4.2 * beaconScale;
  CGContextSetFillColorWithColor(ctx, accent.CGColor);
  CGContextFillEllipseInRect(ctx, CGRectMake(bx - br, by - br, br * 2.0, br * 2.0));

  CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
  CGFloat gx = active ? sin(t * 4.0) * 2.8 : 0.0;
  CGFloat gy = active ? -2.0 : 0.0;
  CGFloat sy = fmax(0.08, 1.0 - blink);
  RBDrawTiltedCapsule(ctx, 40.0 + gx, 54.0 + gy, 10.2, 23.5, -26.0, sy);
  RBDrawTiltedCapsule(ctx, 60.0 + gx, 49.0 + gy, 10.2, 19.0, -26.0, sy);
  CGContextRestoreGState(ctx);
}

@interface RBAvatarOverlayView : UIView
@property(nonatomic, copy) NSString *styleId;
@property(nonatomic, copy, nullable) NSString *previewShape;
@property(nonatomic, strong, nullable) UIImage *maskImage;
@property(nonatomic, strong) UIColor *baseColor;
@property(nonatomic, assign) BOOL activeState;
@property(nonatomic, assign) NSTimeInterval nextBlinkAt;
@end

static NSHashTable<RBAvatarOverlayView *> *RBAvatarOverlayInstances(void) {
  static NSHashTable<RBAvatarOverlayView *> *table;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    table = [NSHashTable weakObjectsHashTable];
  });
  return table;
}

@interface RBAvatarTicker : NSObject
@property(nonatomic, strong, nullable) CADisplayLink *link;
@property(nonatomic, assign) BOOL inBackground;
@end

@implementation RBAvatarTicker
+ (instancetype)shared {
  static RBAvatarTicker *instance;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    instance = [RBAvatarTicker new];
    [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidEnterBackgroundNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(__unused NSNotification *n) {
      instance.inBackground = YES;
      [instance syncLink];
    }];
    [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationWillEnterForegroundNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(__unused NSNotification *n) {
      instance.inBackground = NO;
      [instance syncLink];
    }];
  });
  return instance;
}

- (void)syncLink {
  BOOL anyVisible = NO;
  for (RBAvatarOverlayView *v in RBAvatarOverlayInstances()) {
    if (v.window && !v.hidden && v.alpha > 0.01) {
      anyVisible = YES;
      break;
    }
  }
  BOOL shouldRun = !self.inBackground && anyVisible && !UIAccessibilityIsReduceMotionEnabled();
  if (shouldRun && !self.link) {
    self.link = [CADisplayLink displayLinkWithTarget:self selector:@selector(step)];
    self.link.preferredFrameRateRange = CAFrameRateRangeMake(20, 30, 30);
    [self.link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  } else if (!shouldRun && self.link) {
    [self.link invalidate];
    self.link = nil;
  }
}

- (void)step {
  BOOL anyDrawn = NO;
  for (RBAvatarOverlayView *v in [RBAvatarOverlayInstances() allObjects]) {
    if (v.window && !v.hidden && v.bounds.size.width > 0 && v.bounds.size.height > 0) {
      [v setNeedsDisplay];
      anyDrawn = YES;
    }
  }
  if (!anyDrawn) [self syncLink];
}
@end

@implementation RBAvatarOverlayView
- (instancetype)initWithFrame:(CGRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    self.backgroundColor = UIColor.clearColor;
    self.opaque = NO;
    self.userInteractionEnabled = NO;
    self.tag = RBAvatarOverlayTag;
    self.contentMode = UIViewContentModeRedraw;
    _styleId = @"chassis";
    _previewShape = @"blob";
    _baseColor = RBColorFromHex(0x06B6D4);
    _nextBlinkAt = CACurrentMediaTime() + 1.0 + (arc4random_uniform(24) / 10.0);
    [RBAvatarOverlayInstances() addObject:self];
  }
  return self;
}

- (void)didMoveToWindow {
  [super didMoveToWindow];
  [RBAvatarTicker.shared syncLink];
}

- (void)setHidden:(BOOL)hidden {
  [super setHidden:hidden];
  [RBAvatarTicker.shared syncLink];
}

- (void)drawRect:(CGRect)rect {
  CGContextRef ctx = UIGraphicsGetCurrentContext();
  if (!ctx) return;
  CGFloat s = fmin(self.bounds.size.width, self.bounds.size.height);
  if (s <= 0) return;
  NSTimeInterval t = CACurrentMediaTime();
  CGFloat blink = 0.0;
  if (t >= self.nextBlinkAt) {
    NSTimeInterval dt = t - self.nextBlinkAt;
    if (dt < 0.16) {
      blink = sin((dt / 0.16) * M_PI);
    } else {
      self.nextBlinkAt = t + 2.6 + (arc4random_uniform(24) / 10.0);
    }
  }
  BOOL isDark = self.traitCollection.userInterfaceStyle == UIUserInterfaceStyleDark;
  CGContextSaveGState(ctx);
  CGContextTranslateCTM(ctx, (self.bounds.size.width - s) * 0.5, (self.bounds.size.height - s) * 0.5);
  RBDrawAvatar(ctx, self.styleId ?: @"chassis", self.maskImage, self.previewShape ?: @"blob",
               s, t, blink, self.activeState, self.baseColor, isDark);
  CGContextRestoreGState(ctx);
}
@end

static RBAvatarSample *RBExtractSvgSampleFromView(UIView *svgView) {
  RBAvatarSample *sample = [RBAvatarSample new];
  sample.color = RBColorFromHex(0x06B6D4);
  if (!svgView || !svgView.superview) return sample;
  CGSize ps = svgView.superview.bounds.size;
  CGSize sz = svgView.bounds.size;
  if (ps.width <= 0 || ps.height <= 0 || sz.width <= 0 || sz.height <= 0) return sample;
  sample.sampledParentSize = ps;
  sample.sampledAt = CACurrentMediaTime();

  CGFloat prevAlpha = svgView.alpha;
  if (prevAlpha < 0.99) svgView.alpha = 1.0;

  UIGraphicsImageRendererFormat *fmt = UIGraphicsImageRendererFormat.defaultFormat;
  fmt.scale = 1.0;
  fmt.opaque = NO;
  UIGraphicsImageRenderer *renderer =
      [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(RBAvatarMaskDim, RBAvatarMaskDim) format:fmt];
  UIImage *img = [renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
    CGFloat sx = RBAvatarMaskDim / ps.width;
    CGFloat sy = RBAvatarMaskDim / ps.height;
    CGContextTranslateCTM(ctx.CGContext, svgView.frame.origin.x * sx, svgView.frame.origin.y * sy);
    CGContextScaleCTM(ctx.CGContext, sx, sy);
    [svgView.layer renderInContext:ctx.CGContext];
  }];

  if (prevAlpha < 0.99) svgView.alpha = prevAlpha;

  CGImageRef cgImg = img.CGImage;
  if (!cgImg) return sample;
  const int dim = RBAvatarMaskDim;
  uint8_t pixels[64 * 64 * 4] = {0};
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef mem = CGBitmapContextCreate(pixels, dim, dim, 8, dim * 4, cs,
                                           kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(cs);
  if (!mem) return sample;
  CGContextDrawImage(mem, CGRectMake(0, 0, dim, dim), cgImg);
  CGContextRelease(mem);

  uint8_t maskAlpha[64 * 64] = {0};
  long sumR = 0, sumG = 0, sumB = 0, colorCount = 0, maskCount = 0;
  int bestScore = -1;
  uint8_t bestR = 6, bestG = 182, bestB = 212;
  for (int i = 0; i < dim * dim; i++) {
    int idx = i * 4;
    uint8_t a = pixels[idx + 3];
    if (a >= 96) {
      maskAlpha[i] = 255;
      maskCount++;
    }
    if (a < 180) continue;
    uint8_t r = (uint8_t)fmin(255.0, pixels[idx] * 255.0 / a);
    uint8_t g = (uint8_t)fmin(255.0, pixels[idx + 1] * 255.0 / a);
    uint8_t b = (uint8_t)fmin(255.0, pixels[idx + 2] * 255.0 / a);
    if (r > 236 && g > 236 && b > 236) continue;
    int maxC = MAX(r, MAX(g, b));
    int minC = MIN(r, MIN(g, b));
    int sat = maxC - minC;
    sumR += r; sumG += g; sumB += b; colorCount++;
    int score = sat * 3 + a;
    if (score > bestScore) {
      bestScore = score;
      bestR = r; bestG = g; bestB = b;
    }
  }
  if (colorCount > 0) {
    uint8_t ar = (uint8_t)(sumR / colorCount), ag = (uint8_t)(sumG / colorCount), ab = (uint8_t)(sumB / colorCount);
    sample.color = (MAX(ar, MAX(ag, ab)) - MIN(ar, MIN(ag, ab)) >= 20)
        ? [UIColor colorWithRed:ar / 255.0 green:ag / 255.0 blue:ab / 255.0 alpha:1.0]
        : [UIColor colorWithRed:bestR / 255.0 green:bestG / 255.0 blue:bestB / 255.0 alpha:1.0];
  }
  if (maskCount >= 32) {
    CGContextRef alphaCtx = CGBitmapContextCreate(maskAlpha, dim, dim, 8, dim, NULL, (CGBitmapInfo)kCGImageAlphaOnly);
    if (alphaCtx) {
      CGImageRef alphaMask = CGBitmapContextCreateImage(alphaCtx);
      CGContextRelease(alphaCtx);
      if (alphaMask) {
        sample.maskImage = [UIImage imageWithCGImage:alphaMask];
        CGImageRelease(alphaMask);
      }
    }
  }
  return sample;
}

static BOOL RBIsGrokBotMarkSvgView(UIView *svgView) {
  if (!svgView || !svgView.superview) return NO;
  CGRect f = svgView.frame;
  CGRect pf = svgView.superview.bounds;
  if (f.size.width < 18.0 || f.size.height < 18.0 || pf.size.width <= 0.0 || pf.size.height <= 0.0) {
    return NO;
  }
  if (fabs(f.size.width - f.size.height) > fmax(3.0, fmax(f.size.width, f.size.height) * 0.14)) {
    return NO;
  }
  return f.origin.x < -1.0 && f.origin.y < -1.0 &&
         fabs(f.origin.x - f.origin.y) <= 4.0 &&
         f.size.width > pf.size.width * 1.25;
}

void RBUpdateAvatarView(UIView *svgView) {
  if (!RBIsGrokBotMarkSvgView(svgView)) return;
  UIView *parent = svgView.superview;
  NSString *style = RBAvatarCurrentStyle();
  if ([style isEqualToString:@"official"]) {
    if (svgView.alpha < 0.99) svgView.alpha = 1.0;
    RBAvatarOverlayView *existing = (RBAvatarOverlayView *)[parent viewWithTag:RBAvatarOverlayTag];
    if (existing) existing.hidden = YES;
    return;
  }

  RBAvatarSample *sample = objc_getAssociatedObject(svgView, RBAvatarSampleAssocKey);
  CFTimeInterval now = CACurrentMediaTime();
  BOOL large = fmax(parent.bounds.size.width, parent.bounds.size.height) >= 48.0;
  BOOL needResample = !sample || !sample.maskImage ||
      !CGSizeEqualToSize(sample.sampledParentSize, parent.bounds.size) ||
      (large && (now - sample.sampledAt > 0.25));
  if (needResample) {
    sample = RBExtractSvgSampleFromView(svgView);
    objc_setAssociatedObject(svgView, RBAvatarSampleAssocKey, sample, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  if (svgView.alpha > 0.01) svgView.alpha = 0.0;

  RBAvatarOverlayView *ov = (RBAvatarOverlayView *)[parent viewWithTag:RBAvatarOverlayTag];
  if (!ov || ![ov isKindOfClass:RBAvatarOverlayView.class]) {
    ov = [[RBAvatarOverlayView alloc] initWithFrame:parent.bounds];
    ov.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [parent addSubview:ov];
    RBTrackModifiedView(parent);
  }
  if (!CGRectEqualToRect(ov.frame, parent.bounds)) ov.frame = parent.bounds;
  ov.hidden = NO;
  if (![ov.styleId isEqualToString:style]) {
    ov.styleId = style;
    [ov setNeedsDisplay];
  }
  ov.maskImage = sample.maskImage;
  ov.baseColor = sample.color;
  if (needResample) [ov setNeedsDisplay];
}

void RBResetAvatarSuperview(UIView *superview) {
  if (!superview) return;
  for (UIView *child in superview.subviews) {
    if ([NSStringFromClass([child class]) isEqualToString:@"RNSVGSvgView"] && child.alpha < 0.99) {
      child.alpha = 1.0;
      objc_setAssociatedObject(child, RBAvatarSampleAssocKey, nil, OBJC_ASSOCIATION_ASSIGN);
    }
  }
}

static void RBApplyAvatarStyleRecursively(UIView *view) {
  if (!view) return;
  if ([NSStringFromClass([view class]) isEqualToString:@"RNSVGSvgView"]) {
    RBUpdateAvatarView(view);
  }
  for (UIView *child in view.subviews) {
    if ([child isKindOfClass:RBAvatarOverlayView.class]) continue;
    RBApplyAvatarStyleRecursively(child);
  }
}

@interface RBAvatarStyleController : UIViewController
@property(nonatomic, strong) NSMutableArray<UIButton *> *cards;
@property(nonatomic, strong) NSMutableArray<RBAvatarOverlayView *> *previews;
@end

@implementation RBAvatarStyleController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = RBL(@"Bot 动态图标", @"Bot Avatar Style");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemDone
                                                    target:self action:@selector(doneTapped)];

  UIScrollView *scroll = [UIScrollView new];
  scroll.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:scroll];

  UIStackView *stack = [UIStackView new];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 16;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [scroll addSubview:stack];

  [NSLayoutConstraint activateConstraints:@[
    [scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [scroll.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
    [scroll.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:20],
    [stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-20],
    [stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:20],
    [stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-28],
    [stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-40],
  ]];

  UILabel *hint = [UILabel new];
  hint.text = RBL(@"每个主题均保留全部 Bot 形状与配色，也可随时切回官方原版，切换后立即生效。",
                  @"Every theme preserves all Bot shapes and colors, or switch back to the official orb anytime.");
  hint.font = [UIFont systemFontOfSize:13 weight:UIFontWeightRegular];
  hint.textColor = UIColor.secondaryLabelColor;
  hint.numberOfLines = 0;
  [stack addArrangedSubview:hint];

  self.cards = [NSMutableArray array];
  self.previews = [NSMutableArray array];

  for (NSUInteger rowStart = 0; rowStart < RBAvatarStylesCount; rowStart += 2) {
    UIStackView *row = [UIStackView new];
    row.axis = UILayoutConstraintAxisHorizontal;
    row.distribution = UIStackViewDistributionFillEqually;
    row.spacing = 12;
    for (NSUInteger col = 0; col < 2 && rowStart + col < RBAvatarStylesCount; col++) {
      NSUInteger idx = rowStart + col;
      const RBAvatarStyleMeta *meta = &RBAvatarStyles[idx];

      UIButton *card = [UIButton buttonWithType:UIButtonTypeCustom];
      card.tag = (NSInteger)idx;
      card.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
      card.layer.cornerRadius = 16;
      card.accessibilityIdentifier = [NSString stringWithFormat:@"rokbot.avatar.%@", meta->styleId];
      [card addTarget:self action:@selector(cardTapped:) forControlEvents:UIControlEventTouchUpInside];

      UIStackView *inner = [UIStackView new];
      inner.axis = UILayoutConstraintAxisVertical;
      inner.alignment = UIStackViewAlignmentCenter;
      inner.spacing = 6;
      inner.userInteractionEnabled = NO;
      inner.translatesAutoresizingMaskIntoConstraints = NO;
      [card addSubview:inner];

      RBAvatarOverlayView *preview = [[RBAvatarOverlayView alloc] initWithFrame:CGRectMake(0, 0, 52, 52)];
      preview.tag = 0;
      preview.styleId = meta->styleId;
      preview.previewShape = meta->previewShape;
      preview.baseColor = RBColorFromHex(meta->previewHex);
      [preview.widthAnchor constraintEqualToConstant:52].active = YES;
      [preview.heightAnchor constraintEqualToConstant:52].active = YES;
      [inner addArrangedSubview:preview];

      UILabel *title = [UILabel new];
      NSString *name = RBL(meta->zh, meta->en);
      if ([meta->styleId isEqualToString:@"chassis"]) {
        name = [name stringByAppendingString:RBL(@" · 默认", @" · Default")];
      }
      title.text = name;
      title.font = [UIFont systemFontOfSize:14 weight:UIFontWeightSemibold];
      title.textColor = UIColor.labelColor;
      title.textAlignment = NSTextAlignmentCenter;
      [inner addArrangedSubview:title];

      UILabel *desc = [UILabel new];
      desc.text = RBL(meta->descZh, meta->descEn);
      desc.font = [UIFont systemFontOfSize:11 weight:UIFontWeightRegular];
      desc.textColor = UIColor.secondaryLabelColor;
      desc.textAlignment = NSTextAlignmentCenter;
      desc.numberOfLines = 2;
      [inner addArrangedSubview:desc];

      [NSLayoutConstraint activateConstraints:@[
        [inner.topAnchor constraintEqualToAnchor:card.topAnchor constant:14],
        [inner.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-14],
        [inner.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:10],
        [inner.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-10],
      ]];

      [self.cards addObject:card];
      [self.previews addObject:preview];
      [row addArrangedSubview:card];
    }
    [stack addArrangedSubview:row];
  }

  [self refreshSelection];
}

- (void)refreshSelection {
  NSString *current = RBAvatarCurrentStyle();
  for (NSUInteger i = 0; i < self.cards.count && i < RBAvatarStylesCount; i++) {
    BOOL selected = [RBAvatarStyles[i].styleId isEqualToString:current];
    UIButton *card = self.cards[i];
    card.layer.borderWidth = selected ? 2.0 : 1.0;
    card.layer.borderColor = selected ? UIColor.labelColor.CGColor : UIColor.separatorColor.CGColor;
    self.previews[i].activeState = selected;
  }
}

- (void)cardTapped:(UIButton *)sender {
  if (sender.tag < 0 || (NSUInteger)sender.tag >= RBAvatarStylesCount) return;
  RBSetAvatarStyle(RBAvatarStyles[sender.tag].styleId);
  [self refreshSelection];
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class]) {
      for (UIWindow *window in ((UIWindowScene *)scene).windows) {
        RBApplyAvatarStyleRecursively(window);
      }
    }
  }
}

- (void)doneTapped {
  [self dismissViewControllerAnimated:YES completion:nil];
}
@end

void RBShowAvatarStyleFrom(UIViewController *presenter) {
  if (!presenter) return;
  RBAvatarStyleController *vc = [RBAvatarStyleController new];
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  if (@available(iOS 15.0, *)) {
    nav.sheetPresentationController.detents = @[ UISheetPresentationControllerDetent.mediumDetent, UISheetPresentationControllerDetent.largeDetent ];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
  }
  [presenter presentViewController:nav animated:YES completion:nil];
}
