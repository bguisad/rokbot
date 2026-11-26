#import "RBAvatarStyle.h"
#import "RBLocalize.h"
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <math.h>

NSNotificationName const RBAvatarStyleDidChangeNotification = @"RokBotAvatarStyleDidChange";
static NSString *const RBAvatarStyleDefaultsKey = @"RokBotLocal.avatarStyle";
static const NSInteger RBAvatarOverlayTag = 731994;
static const void *RBAvatarColorAssocKey = &RBAvatarColorAssocKey;

extern void RBTrackModifiedView(UIView *view);

typedef struct {
  __unsafe_unretained NSString *styleId;
  __unsafe_unretained NSString *zh;
  __unsafe_unretained NSString *en;
  __unsafe_unretained NSString *descZh;
  __unsafe_unretained NSString *descEn;
  uint32_t previewHex;
} RBAvatarStyleMeta;

static const RBAvatarStyleMeta RBAvatarStyles[] = {
  { @"chassis", @"机甲灵偶", @"RokBot Chassis", @"斜胶囊眼 + 脉冲灯", @"Capsule eyes + beacon", 0x06B6D4 },
  { @"antenna", @"双天线波波", @"Twin Antenna", @"弹性天线 + 玻璃面罩", @"Antennas + visor", 0x8B5CF6 },
  { @"visor", @"赛博护目镜", @"Cyber Visor", @"切角外壳 + 扫描灯", @"Cyber shell + scanner", 0xF97316 },
  { @"pixel", @"像素精灵", @"Pixel Sprite", @"点阵屏幕 + 节奏条", @"LED matrix + status", 0x10B981 },
  { @"orb", @"流体光球", @"Fluid Orb", @"液体变形 + 轨道星", @"Morphing blob + dot", 0xEC4899 },
  { @"official", @"官方原版", @"Official", @"保留官方流体球", @"Original fluid orb", 0x3B82F6 },
};
static const NSUInteger RBAvatarStylesCount = sizeof(RBAvatarStyles) / sizeof(RBAvatarStyles[0]);

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

static CGPathRef RBChassisPath(void) {
  static CGMutablePathRef path;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = CGPathCreateMutable();
    CGPathMoveToPoint(path, NULL, 340, 148);
    CGPathAddCurveToPoint(path, NULL, 408, 148, 476, 144, 540, 144);
    CGPathAddCurveToPoint(path, NULL, 618, 144, 664, 60, 756, 56);
    CGPathAddCurveToPoint(path, NULL, 836, 52, 892, 104, 884, 176);
    CGPathAddCurveToPoint(path, NULL, 878, 214, 932, 272, 956, 368);
    CGPathAddCurveToPoint(path, NULL, 964, 464, 960, 564, 948, 656);
    CGPathAddCurveToPoint(path, NULL, 928, 816, 820, 924, 636, 944);
    CGPathAddCurveToPoint(path, NULL, 532, 956, 424, 960, 324, 952);
    CGPathAddCurveToPoint(path, NULL, 156, 938, 76, 836, 68, 668);
    CGPathAddCurveToPoint(path, NULL, 62, 548, 64, 424, 72, 336);
    CGPathAddCurveToPoint(path, NULL, 84, 200, 184, 148, 340, 148);
    CGPathCloseSubpath(path);
  });
  return path;
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

static void RBDrawAvatar(CGContextRef ctx, NSString *styleId, CGFloat s,
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
  CGColorRef strokeColor = isDark
      ? [UIColor colorWithWhite:1.0 alpha:0.22].CGColor
      : [UIColor colorWithRed:15.0 / 255.0 green:23.0 / 255.0 blue:42.0 / 255.0 alpha:0.18].CGColor;

  if ([styleId isEqualToString:@"antenna"]) {
    CGContextSaveGState(ctx);
    CGFloat bw = s * 0.76, bh = s * 0.66, bx = (s - bw) * 0.5, by = s * 0.26;
    CGFloat bob = active ? sin(t * 7.0) * s * 0.022 : sin(t * 2.4) * s * 0.012;
    CGFloat sway = sin(t * (active ? 7.5 : 2.6)) * 0.14;
    CGContextTranslateCTM(ctx, 0, bob);

    CGContextSetLineCap(ctx, kCGLineCapRound);
    CGContextSetLineWidth(ctx, fmax(1.5, s * 0.045));
    for (int side = -1; side <= 1; side += 2) {
      CGFloat rootX = s * 0.5 + side * s * 0.17;
      CGFloat rootY = by + s * 0.03;
      CGFloat tipX = rootX + side * s * 0.07 + sin(t * 3.0 + side) * s * 0.025 + sway * s * 0.08;
      CGFloat tipY = s * 0.09 + fabs(sway) * s * 0.02;
      CGContextSetStrokeColorWithColor(ctx, mid.CGColor);
      CGContextMoveToPoint(ctx, rootX, rootY);
      CGContextAddQuadCurveToPoint(ctx, rootX + side * s * 0.02, (rootY + tipY) * 0.5, tipX, tipY);
      CGContextStrokePath(ctx);

      if (active) {
        CGFloat pulse = fmod(t * 1.8 + (side > 0 ? 0.5 : 0.0), 1.0);
        CGFloat pr = s * 0.04 + pulse * s * 0.07;
        CGContextSetStrokeColorWithColor(ctx, [accent colorWithAlphaComponent:(1.0 - pulse) * 0.6].CGColor);
        CGContextSetLineWidth(ctx, fmax(1.0, s * 0.02));
        CGContextAddEllipseInRect(ctx, CGRectMake(tipX - pr, tipY - pr, pr * 2.0, pr * 2.0));
        CGContextStrokePath(ctx);
        CGContextSetLineWidth(ctx, fmax(1.5, s * 0.045));
      }
      CGFloat tr = s * 0.048;
      CGContextSetFillColorWithColor(ctx, accent.CGColor);
      CGContextFillEllipseInRect(ctx, CGRectMake(tipX - tr, tipY - tr, tr * 2.0, tr * 2.0));
    }

    CGRect bodyRect = CGRectMake(bx, by, bw, bh);
    CGContextSaveGState(ctx);
    RBDrawRoundedRect(ctx, bodyRect, s * 0.24);
    CGContextClip(ctx);
    CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
    CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, by), CGPointMake(0, by + bh), 0);
    CGGradientRelease(grad);
    CGContextRestoreGState(ctx);

    CGContextSetStrokeColorWithColor(ctx, strokeColor);
    CGContextSetLineWidth(ctx, fmax(1.0, s * 0.025));
    RBDrawRoundedRect(ctx, bodyRect, s * 0.24);
    CGContextStrokePath(ctx);

    CGFloat vx = bx + bw * 0.13, vy = by + bh * 0.22, vw = bw * 0.74, vh = bh * 0.56;
    CGContextSetFillColorWithColor(ctx, RBColorFromHex(0x0F172A).CGColor);
    RBDrawRoundedRect(ctx, CGRectMake(vx, vy, vw, vh), vh * 0.42);
    CGContextFillPath(ctx);

    CGFloat gx = active ? sin(t * 4.5) * vw * 0.07 : 0.0;
    CGFloat gy = active ? -vh * 0.06 : 0.0;
    CGFloat eh = vh * 0.46 * fmax(0.1, 1.0 - blink);
    CGFloat ew = vw * 0.18;
    for (int side = -1; side <= 1; side += 2) {
      CGFloat ex = vx + vw * 0.5 + side * vw * 0.20 + gx;
      CGFloat ey = vy + vh * 0.5 + gy;
      CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
      CGContextFillEllipseInRect(ctx, CGRectMake(ex - ew * 0.5, ey - eh * 0.5, ew, eh));
      if (eh > s * 0.06) {
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
    CGFloat p = s * 0.11, c = s * 0.22;
    CGMutablePathRef shell = CGPathCreateMutable();
    CGPathMoveToPoint(shell, NULL, p + c, p * 1.15);
    CGPathAddLineToPoint(shell, NULL, s - p - c, p * 1.15);
    CGPathAddLineToPoint(shell, NULL, s - p, p * 1.15 + c);
    CGPathAddLineToPoint(shell, NULL, s - p, s - p - c);
    CGPathAddLineToPoint(shell, NULL, s - p - c, s - p);
    CGPathAddLineToPoint(shell, NULL, p + c, s - p);
    CGPathAddLineToPoint(shell, NULL, p, s - p - c);
    CGPathAddLineToPoint(shell, NULL, p, p * 1.15 + c);
    CGPathCloseSubpath(shell);

    CGContextSaveGState(ctx);
    CGContextAddPath(ctx, shell);
    CGContextClip(ctx);
    CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
    CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, p), CGPointMake(0, s - p), 0);
    CGGradientRelease(grad);
    CGContextRestoreGState(ctx);

    CGContextSetStrokeColorWithColor(ctx, strokeColor);
    CGContextSetLineWidth(ctx, fmax(1.0, s * 0.025));
    CGContextAddPath(ctx, shell);
    CGContextStrokePath(ctx);
    CGPathRelease(shell);

    CGFloat vx = s * 0.13, vy = s * 0.34, vw = s * 0.74, vh = s * 0.34;
    CGContextSetFillColorWithColor(ctx, RBColorFromHex(0x090D16).CGColor);
    RBDrawRoundedRect(ctx, CGRectMake(vx, vy, vw, vh), s * 0.09);
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
      CGFloat h = vh * 0.44 * fmax(0.12, 1.0 - blink);
      for (int side = -1; side <= 1; side += 2) {
        CGFloat cx = vx + vw * 0.5 + side * vw * 0.21;
        CGFloat cy = vy + vh * 0.5;
        RBDrawRoundedRect(ctx, CGRectMake(cx - vw * 0.065, cy - h * 0.5, vw * 0.13, h), s * 0.03);
        CGContextFillPath(ctx);
      }
    }
    CGContextRestoreGState(ctx);
    return;
  }

  if ([styleId isEqualToString:@"pixel"]) {
    CGContextSaveGState(ctx);
    if (active) CGContextTranslateCTM(ctx, 0, sin(t * 7.0) * s * 0.018);
    CGFloat pad = s * 0.10;
    CGRect shellRect = CGRectMake(pad, pad, s - pad * 2.0, s - pad * 2.0);
    CGContextSaveGState(ctx);
    RBDrawRoundedRect(ctx, shellRect, s * 0.20);
    CGContextClip(ctx);
    CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
    CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, pad), CGPointMake(0, s - pad), 0);
    CGGradientRelease(grad);
    CGContextRestoreGState(ctx);

    CGContextSetStrokeColorWithColor(ctx, strokeColor);
    CGContextSetLineWidth(ctx, fmax(1.0, s * 0.025));
    RBDrawRoundedRect(ctx, shellRect, s * 0.20);
    CGContextStrokePath(ctx);

    CGFloat mx = s * 0.19, my = s * 0.25, mw = s * 0.62, mh = s * 0.52;
    CGContextSetFillColorWithColor(ctx, RBColorFromHex(0x0B101B).CGColor);
    RBDrawRoundedRect(ctx, CGRectMake(mx, my, mw, mh), s * 0.09);
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
    CGFloat bw = s * 0.08, bh = fmax(1.4, s * 0.04);
    for (int i = 0; i < 3; i++) {
      UIColor *col = (active && i == barPhase) ? UIColor.whiteColor : accent;
      CGContextSetFillColorWithColor(ctx, col.CGColor);
      CGContextFillRect(ctx, CGRectMake(s * 0.5 - s * 0.15 + i * s * 0.11, s * 0.145, bw, bh));
    }
    CGContextRestoreGState(ctx);
    return;
  }

  if ([styleId isEqualToString:@"orb"]) {
    CGContextSaveGState(ctx);
    CGContextTranslateCTM(ctx, s * 0.5, s * 0.5);
    const int pts = 32;
    CGFloat baseR = s * 0.37;
    double speed = active ? 3.4 : 1.9;
    double amp = active ? 0.075 : 0.055;
    CGPoint coords[32];
    for (int i = 0; i < pts; i++) {
      double a = (i / (double)pts) * M_PI * 2.0;
      double r = baseR * (1.0 + amp * sin(a * 3.0 + t * speed) + amp * 0.6 * cos(a * 2.0 - t * speed * 1.3));
      coords[i] = CGPointMake(cos(a) * r, sin(a) * r);
    }
    CGMutablePathRef blob = CGPathCreateMutable();
    CGPathMoveToPoint(blob, NULL, (coords[pts - 1].x + coords[0].x) * 0.5, (coords[pts - 1].y + coords[0].y) * 0.5);
    for (int i = 0; i < pts; i++) {
      int next = (i + 1) % pts;
      CGPathAddQuadCurveToPoint(blob, NULL, coords[i].x, coords[i].y,
                                (coords[i].x + coords[next].x) * 0.5,
                                (coords[i].y + coords[next].y) * 0.5);
    }
    CGPathCloseSubpath(blob);

    CGContextSaveGState(ctx);
    CGContextAddPath(ctx, blob);
    CGContextClip(ctx);
    CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
    CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, -baseR), CGPointMake(0, baseR), 0);
    CGGradientRelease(grad);
    CGContextRestoreGState(ctx);

    CGContextSetStrokeColorWithColor(ctx, strokeColor);
    CGContextSetLineWidth(ctx, fmax(1.0, s * 0.024));
    CGContextAddPath(ctx, blob);
    CGContextStrokePath(ctx);
    CGPathRelease(blob);

    CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
    CGFloat sy = fmax(0.1, 1.0 - blink);
    CGFloat gx = active ? sin(t * 4.0) * s * 0.035 : 0.0;
    CGFloat gy = active ? -s * 0.025 : 0.0;
    RBDrawTiltedCapsule(ctx, -s * 0.105 + gx, s * 0.015 + gy, s * 0.104, s * 0.25, -24.0, sy);
    RBDrawTiltedCapsule(ctx, s * 0.105 + gx, -s * 0.035 + gy, s * 0.104, s * 0.20, -24.0, sy);

    double satA = t * (active ? 2.8 : 1.1) - 0.8;
    CGFloat satDist = baseR + s * 0.075;
    CGFloat satR = s * 0.05;
    CGContextSetFillColorWithColor(ctx, accent.CGColor);
    CGContextFillEllipseInRect(ctx, CGRectMake(cos(satA) * satDist - satR, sin(satA) * satDist * 0.86 - satR, satR * 2.0, satR * 2.0));
    CGContextRestoreGState(ctx);
    return;
  }

  // Default: chassis
  CGContextSaveGState(ctx);
  CGFloat sc = s / 1024.0;
  CGFloat breath = 1.0 + sin(t * 2.8) * 0.025;
  CGFloat bob = active ? sin(t * 3.4) * s * 0.018 : sin(t * 2.2) * s * 0.012;
  CGFloat tilt = active ? sin(t * 2.4) * 0.06 : 0.0;

  CGContextTranslateCTM(ctx, s * 0.5, s * 0.5 + bob);
  CGContextRotateCTM(ctx, tilt);
  CGContextScaleCTM(ctx, breath, breath);
  CGContextTranslateCTM(ctx, -s * 0.5, -s * 0.5);
  CGContextScaleCTM(ctx, sc, sc);

  CGPathRef cpath = RBChassisPath();
  CGContextSaveGState(ctx);
  CGContextAddPath(ctx, cpath);
  CGContextClip(ctx);
  CGGradientRef grad = RBCreateBodyGradient(top, mid, bot);
  CGContextDrawLinearGradient(ctx, grad, CGPointMake(0, 56), CGPointMake(0, 960), 0);
  CGGradientRelease(grad);
  CGContextRestoreGState(ctx);

  CGContextSetStrokeColorWithColor(ctx, strokeColor);
  CGContextSetLineWidth(ctx, 26.0);
  CGContextAddPath(ctx, cpath);
  CGContextStrokePath(ctx);

  CGFloat beaconScale = active ? (0.85 + fabs(sin(t * 7.0)) * 0.45) : (1.0 + sin(t * 3.0) * 0.12);
  if (active) {
    CGFloat halo = fmod(t * 1.4, 1.0);
    CGFloat hr = 42.0 + halo * 74.0;
    CGContextSetStrokeColorWithColor(ctx, [accent colorWithAlphaComponent:(1.0 - halo) * 0.65].CGColor);
    CGContextSetLineWidth(ctx, 18.0);
    CGContextAddEllipseInRect(ctx, CGRectMake(768.0 - hr, 144.0 - hr, hr * 2.0, hr * 2.0));
    CGContextStrokePath(ctx);
  }
  CGFloat br = 44.0 * beaconScale;
  CGContextSetFillColorWithColor(ctx, accent.CGColor);
  CGContextFillEllipseInRect(ctx, CGRectMake(768.0 - br, 144.0 - br, br * 2.0, br * 2.0));

  CGContextSetFillColorWithColor(ctx, UIColor.whiteColor.CGColor);
  CGFloat gx = active ? sin(t * 4.0) * 32.0 : 0.0;
  CGFloat gy = active ? -20.0 : 0.0;
  CGFloat sy = fmax(0.08, 1.0 - blink);
  RBDrawTiltedCapsule(ctx, 376.0 + gx, 564.0 + gy, 144.0, 332.0, -26.0, sy);
  RBDrawTiltedCapsule(ctx, 648.0 + gx, 504.0 + gy, 144.0, 268.0, -26.0, sy);
  CGContextRestoreGState(ctx);
}

@interface RBAvatarOverlayView : UIView
@property(nonatomic, copy) NSString *styleId;
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
  RBDrawAvatar(ctx, self.styleId ?: @"chassis", s, t, blink, self.activeState, self.baseColor, isDark);
  CGContextRestoreGState(ctx);
}
@end

static UIColor *RBExtractDominantColorFromSvgView(UIView *svgView) {
  CGSize sz = svgView.bounds.size;
  if (sz.width <= 0 || sz.height <= 0) return RBColorFromHex(0x06B6D4);
  CGFloat prevAlpha = svgView.alpha;
  if (prevAlpha < 0.99) svgView.alpha = 1.0;

  UIGraphicsImageRendererFormat *fmt = UIGraphicsImageRendererFormat.defaultFormat;
  fmt.scale = 1.0;
  fmt.opaque = NO;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(16, 16) format:fmt];
  UIImage *img = [renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
    CGContextScaleCTM(ctx.CGContext, 16.0 / sz.width, 16.0 / sz.height);
    [svgView.layer renderInContext:ctx.CGContext];
  }];

  if (prevAlpha < 0.99) svgView.alpha = prevAlpha;

  CGImageRef cgImg = img.CGImage;
  if (!cgImg) return RBColorFromHex(0x06B6D4);
  uint8_t pixels[16 * 16 * 4] = {0};
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef mem = CGBitmapContextCreate(pixels, 16, 16, 8, 16 * 4, cs,
                                           kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(cs);
  if (!mem) return RBColorFromHex(0x06B6D4);
  CGContextDrawImage(mem, CGRectMake(0, 0, 16, 16), cgImg);
  CGContextRelease(mem);

  long sumR = 0, sumG = 0, sumB = 0, count = 0;
  int bestScore = -1;
  uint8_t bestR = 6, bestG = 182, bestB = 212;
  for (int y = 2; y < 14; y++) {
    for (int x = 2; x < 14; x++) {
      int idx = (y * 16 + x) * 4;
      uint8_t a = pixels[idx + 3];
      if (a < 180) continue;
      uint8_t r = (uint8_t)fmin(255.0, pixels[idx] * 255.0 / a);
      uint8_t g = (uint8_t)fmin(255.0, pixels[idx + 1] * 255.0 / a);
      uint8_t b = (uint8_t)fmin(255.0, pixels[idx + 2] * 255.0 / a);
      if (r > 236 && g > 236 && b > 236) continue;
      int maxC = MAX(r, MAX(g, b));
      int minC = MIN(r, MIN(g, b));
      int sat = maxC - minC;
      sumR += r; sumG += g; sumB += b; count++;
      int score = sat * 3 + a;
      if (score > bestScore) {
        bestScore = score;
        bestR = r; bestG = g; bestB = b;
      }
    }
  }
  if (count > 0) {
    uint8_t ar = (uint8_t)(sumR / count), ag = (uint8_t)(sumG / count), ab = (uint8_t)(sumB / count);
    if (MAX(ar, MAX(ag, ab)) - MIN(ar, MIN(ag, ab)) >= 20) {
      return [UIColor colorWithRed:ar / 255.0 green:ag / 255.0 blue:ab / 255.0 alpha:1.0];
    }
    return [UIColor colorWithRed:bestR / 255.0 green:bestG / 255.0 blue:bestB / 255.0 alpha:1.0];
  }
  return RBColorFromHex(0x06B6D4);
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

  UIColor *cachedColor = objc_getAssociatedObject(svgView, RBAvatarColorAssocKey);
  if (!cachedColor) {
    cachedColor = RBExtractDominantColorFromSvgView(svgView);
    objc_setAssociatedObject(svgView, RBAvatarColorAssocKey, cachedColor, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
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
  ov.baseColor = cachedColor;
}

void RBResetAvatarSuperview(UIView *superview) {
  if (!superview) return;
  for (UIView *child in superview.subviews) {
    if ([NSStringFromClass([child class]) isEqualToString:@"RNSVGSvgView"] && child.alpha < 0.99) {
      child.alpha = 1.0;
      objc_setAssociatedObject(child, RBAvatarColorAssocKey, nil, OBJC_ASSOCIATION_ASSIGN);
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
  hint.text = RBL(@"全局替换所有 Bot 头像的动态流体球风格，也可随时切回官方原版，切换后立即生效。",
                  @"Applies to every Bot avatar across the app, or switch back to the official orb anytime.");
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
