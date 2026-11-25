#import "RBLocalize.h"
#import "RBProfile.h"
#import "RBConnection.h"
#import "RBNetwork.h"
#import "RBHTTP.h"
#import <PhotosUI/PhotosUI.h>
#import <objc/runtime.h>
#import <CommonCrypto/CommonDigest.h>
static NSDictionary *RBUserProfile;
static UIImage *RBUserAvatar;
static NSString *RBProfileScope;
static char RBOriginalVisibility;
static char RBHiddenSiblingsKey;
static dispatch_queue_t RBProfileIOQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("dev.rokbot.profile.io", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}
static Class RBParagraphViewClass(void) {
  static Class cls;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cls = NSClassFromString(@"RCTParagraphComponentView"); });
  return cls;
}
static NSString *RBCurrentProfileScope(void) {
  NSString *scope = [NSString stringWithFormat:@"%@\n%@", (RBNetworkAddress().length ? RBNetworkAddress() : RBConnection.shared.serverURL) ?: @"",
    [NSUserDefaults.standardUserDefaults stringForKey:@"RokBotLocal.deviceId"] ?: @""];
  NSData *bytes = [scope dataUsingEncoding:NSUTF8StringEncoding]; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [result appendFormat:@"%02x", digest[index]];
  return result;
}
static NSURL *RBProfileCacheURL(void) {
  NSURL *directory = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
  return [directory URLByAppendingPathComponent:@"RokBotLocal-profile.plist"];
}
void RBResetProfileView(UIView *view) {
  for (UIView *child in view.subviews) {
    NSNumber *hidden = objc_getAssociatedObject(child, &RBOriginalVisibility);
    if (hidden) {
      BOOL original = hidden.boolValue;
      if (child.hidden != original) child.hidden = original;
      objc_setAssociatedObject(child, &RBOriginalVisibility, nil,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
  }
  NSHashTable<UIView *> *siblings = objc_getAssociatedObject(view, &RBHiddenSiblingsKey);
  if (siblings) {
    for (UIView *sibling in siblings) {
      NSNumber *hidden = objc_getAssociatedObject(sibling, &RBOriginalVisibility);
      if (hidden) {
        BOOL original = hidden.boolValue;
        if (sibling.hidden != original) sibling.hidden = original;
        objc_setAssociatedObject(sibling, &RBOriginalVisibility, nil,
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
    }
    objc_setAssociatedObject(view, &RBHiddenSiblingsKey, nil,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}
NSString *RBProfileName(void) {
  NSString *value = RBUserProfile[@"displayName"];
  return [value isKindOfClass:NSString.class] && value.length ? value : RBL(@"本地用户", @"Local user");
}
NSString *RBProfileHostName(void) {
  NSString *value = RBUserProfile[@"hostName"];
  return [value isKindOfClass:NSString.class] && value.length ? value : @"RokBot Host";
}
UIImage *RBProfileAvatar(void) { return RBUserAvatar; }
static void RBSetProfile(NSDictionary *value) {
  RBUserProfile = value;
  RBUserAvatar = nil;
  NSString *encoded = value[@"avatarDataUrl"];
  if ([encoded isKindOfClass:NSString.class]) {
    NSRange comma = [encoded rangeOfString:@","];
    if (comma.location != NSNotFound)
      RBUserAvatar = [UIImage
          imageWithData:[[NSData alloc]
                            initWithBase64EncodedString:[encoded
                                                            substringFromIndex:comma.location + 1]
                                                options:0]];
  }
}
void RBRestoreProfileCache(void) {
  NSString *scope = RBCurrentProfileScope();
  if ([RBProfileScope isEqual:scope]) return;
  RBProfileScope = scope;
  RBSetProfile(@{});
  NSData *data = [NSData dataWithContentsOfURL:RBProfileCacheURL()];
  NSDictionary *cache = data ? [NSPropertyListSerialization propertyListWithData:data options:0 format:nil error:nil] : nil;
  NSDictionary *profile = [cache isKindOfClass:NSDictionary.class] ? cache[@"profile"] : nil;
  if ([cache[@"scope"] isEqual:scope] && [profile isKindOfClass:NSDictionary.class] &&
      [profile[@"displayName"] isKindOfClass:NSString.class] && [profile[@"displayName"] length])
    RBSetProfile(profile);
}
void RBClearProfileCache(void) {
  RBProfileScope = nil;
  RBSetProfile(@{});
  NSURL *url = RBProfileCacheURL();
  if (!url) return;
  dispatch_sync(RBProfileIOQueue(), ^{
    [NSFileManager.defaultManager removeItemAtURL:url error:nil];
  });
}
static void RBSaveProfileCache(void) {
  NSMutableDictionary *profile = [RBUserProfile mutableCopy];
  if (!profile) return;
  if (profile[@"avatarDataUrl"] == NSNull.null) [profile removeObjectForKey:@"avatarDataUrl"];
  if (profile[@"updatedAt"] == NSNull.null) [profile removeObjectForKey:@"updatedAt"];
  NSString *scope = [RBProfileScope ?: RBCurrentProfileScope() copy];
  NSDictionary *cache = @{@"scope":scope, @"profile":[profile copy]};
  NSURL *url = RBProfileCacheURL();
  if (!url) return;
  dispatch_async(RBProfileIOQueue(), ^{
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:cache format:NSPropertyListBinaryFormat_v1_0 options:0 error:nil];
    if (!data) return;
    [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    [data writeToURL:url options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil];
    [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:url.path error:nil];
  });
}
static void RBProfileRequest(NSString *method, NSDictionary *body,
                             void (^complete)(NSDictionary *, NSError *)) {
  NSString *serverURL = RBConnection.shared.serverURL;
  NSString *deviceToken = RBConnection.shared.deviceToken;
  if (!serverURL.length || !deviceToken.length)
    return;
  RBRestoreProfileCache();
  NSURL *url = [NSURL URLWithString:[serverURL stringByAppendingString:@"/local/profile"]];
  if (!url)
    return;
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url];
  r.HTTPMethod = method;
  r.timeoutInterval = 20;
  [r setValue:[@"Bearer " stringByAppendingString:deviceToken]
      forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[RBHTTPSession()
      dataTaskWithRequest:r
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          NSDictionary *value =
              data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
              ? ((NSHTTPURLResponse *)response).statusCode : 0;
          dispatch_async(dispatch_get_main_queue(), ^{
            if (![serverURL isEqual:RBConnection.shared.serverURL] ||
                ![deviceToken isEqual:RBConnection.shared.deviceToken]) return;
            if (error || status != 200 ||
                ![value isKindOfClass:NSDictionary.class] ||
                ![value[@"displayName"] isKindOfClass:NSString.class] ||
                ![value[@"displayName"] length]) {
              if (complete)
                complete(nil,
                         error ?: [NSError errorWithDomain:@"RokBotProfile" code:1 userInfo:nil]);
              return;
            }
            if ([value isEqualToDictionary:RBUserProfile]) {
              if (complete)
                complete(value, nil);
              return;
            }
            RBSetProfile(value);
            RBSaveProfileCache();
            [NSNotificationCenter.defaultCenter postNotificationName:@"RokBotProfileChanged"
                                                              object:nil];
            if (complete)
              complete(value, nil);
          });
        }] resume];
}
void RBRefreshProfile(void) { RBProfileRequest(@"GET", nil, nil); }
@interface RBProfileController : UIViewController <PHPickerViewControllerDelegate>
@property(nonatomic, strong) UITextField *name;
@property(nonatomic, strong) UIButton *avatar;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, copy) NSString *avatarData;
@end
@implementation RBProfileController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = RBL(@"个人资料", @"Profile");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:RBL(@"保存", @"Save")
                                       style:UIBarButtonItemStyleDone
                                      target:self
                                      action:@selector(save)];
  self.avatar = [UIButton buttonWithType:UIButtonTypeCustom];
  self.avatar.layer.cornerRadius = 44;
  self.avatar.clipsToBounds = YES;
  self.avatar.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  [self.avatar.heightAnchor constraintEqualToConstant:88].active = YES;
  [self.avatar.widthAnchor constraintEqualToConstant:88].active = YES;
  [self.avatar addTarget:self action:@selector(pick) forControlEvents:UIControlEventTouchUpInside];
  UIView *avatarHolder = [UIView new];
  [avatarHolder.heightAnchor constraintEqualToConstant:104].active = YES;
  self.avatar.translatesAutoresizingMaskIntoConstraints = NO;
  [avatarHolder addSubview:self.avatar];
  [NSLayoutConstraint activateConstraints:@[
    [self.avatar.centerXAnchor constraintEqualToAnchor:avatarHolder.centerXAnchor],
    [self.avatar.topAnchor constraintEqualToAnchor:avatarHolder.topAnchor]
  ]];
  self.name = [UITextField new];
  self.name.text = RBProfileName();
  self.name.placeholder = RBL(@"用户名", @"Name");
  self.name.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  self.name.layer.cornerRadius = 16;
  self.name.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  self.name.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 16, 1)];
  self.name.leftViewMode = UITextFieldViewModeAlways;
  [self.name.heightAnchor constraintEqualToConstant:52].active = YES;
  self.status = [UILabel new];
  self.status.text = @"";
  self.status.textColor = UIColor.secondaryLabelColor;
  self.status.numberOfLines = 0;
  self.status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
  UIButton *remove = [UIButton buttonWithType:UIButtonTypeSystem];
  [remove setTitle:RBL(@"移除头像", @"Remove photo") forState:UIControlStateNormal];
  [remove setTitleColor:UIColor.secondaryLabelColor forState:UIControlStateNormal];
  [remove addTarget:self
                action:@selector(clearAvatar)
      forControlEvents:UIControlEventTouchUpInside];
  UIStackView *stack = [[UIStackView alloc]
      initWithArrangedSubviews:@[ avatarHolder, self.name, remove, self.status ]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 18;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-24],
    [stack.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:24]
  ]];
  self.avatarData = [RBUserProfile[@"avatarDataUrl"] isKindOfClass:NSString.class]
                        ? RBUserProfile[@"avatarDataUrl"]
                        : nil;
  [self paint:RBProfileAvatar()];
  RBProfileRequest(@"GET", nil, ^(NSDictionary *value, NSError *error) {
    if (!error) {
      self.name.text = RBProfileName();
      self.avatarData =
          [value[@"avatarDataUrl"] isKindOfClass:NSString.class] ? value[@"avatarDataUrl"] : nil;
      [self paint:RBProfileAvatar()];
    }
  });
}
- (void)paint:(UIImage *)image {
  [self.avatar setImage:image forState:UIControlStateNormal];
  [self.avatar setTitle:image ? @"" : RBL(@"选择头像", @"Choose photo") forState:UIControlStateNormal];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)clearAvatar {
  self.avatarData = nil;
  [self paint:nil];
}
- (void)pick {
  PHPickerConfiguration *c = [PHPickerConfiguration new];
  c.selectionLimit = 1;
  c.filter = PHPickerFilter.imagesFilter;
  PHPickerViewController *p = [[PHPickerViewController alloc] initWithConfiguration:c];
  p.delegate = self;
  [self presentViewController:p animated:YES completion:nil];
}
- (void)picker:(PHPickerViewController *)picker
    didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  NSItemProvider *provider = results.firstObject.itemProvider;
  if (![provider canLoadObjectOfClass:UIImage.class])
    return;
  __weak typeof(self) weakSelf = self;
  [provider loadObjectOfClass:UIImage.class
            completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
              if (error || ![object isKindOfClass:UIImage.class])
                return;
              UIImage *source = (UIImage *)object;
              if (source.size.width <= 0 || source.size.height <= 0)
                return;
              UIGraphicsImageRenderer *r =
                  [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(256, 256)];
              UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *c) {
                CGFloat scale = MAX(256.0 / source.size.width, 256.0 / source.size.height);
                CGSize size = CGSizeMake(source.size.width * scale, source.size.height * scale);
                [source drawInRect:CGRectMake((256.0 - size.width) / 2.0,
                                              (256.0 - size.height) / 2.0,
                                              size.width, size.height)];
              }];
              NSData *png = UIImagePNGRepresentation(image);
              if (!png.length)
                return;
              NSString *encoded = [@"data:image/png;base64,"
                  stringByAppendingString:[png base64EncodedStringWithOptions:0]];
              dispatch_async(dispatch_get_main_queue(), ^{
                typeof(self) strongSelf = weakSelf;
                if (!strongSelf)
                  return;
                strongSelf.avatarData = encoded;
                [strongSelf paint:image];
              });
            }];
}
- (void)save {
  NSString *name = [self.name.text
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!name.length || name.length > 80) {
    self.status.text = RBL(@"请输入 1–80 个字符的用户名。", @"Enter a name with 1–80 characters.");
    return;
  }
  self.navigationItem.rightBarButtonItem.enabled = NO;
  self.status.text = RBL(@"正在保存…", @"Saving…");
  RBProfileRequest(@"PUT",
                   @{@"displayName" : name, @"avatarDataUrl" : self.avatarData ?: NSNull.null},
                   ^(NSDictionary *value, NSError *error) {
                     self.navigationItem.rightBarButtonItem.enabled = YES;
                     if (error) {
                       self.status.text = RBL(@"保存失败，请重试。", @"Could not save. Try again.");
                       return;
                     }
                     [self close];
                   });
}
@end
void RBShowProfile(void) {
  UIViewController *top = nil;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow)
          top = w.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  [top presentViewController:[[UINavigationController alloc]
                                 initWithRootViewController:[RBProfileController new]]
                    animated:YES
                  completion:nil];
}

// The pinned Hermes adapter has a local synthetic user; replace only its two
// exact native surfaces so Bot identities and other original controls remain native.
@interface RBProfileEntry : NSObject
+ (void)open;
@end
@implementation RBProfileEntry
+ (void)open {
  RBShowProfile();
}
@end
BOOL RBReplaceProfileView(UIView *view) {
  if (!RBConnection.shared.isPaired)
    return NO;
  NSString *label = view.accessibilityLabel;
  if (![label hasPrefix:@"dev-gateway@localhost"])
    return NO;
  UIView *cover = [view viewWithTag:731993];
  if (cover && cover.accessibilityLabel.length) {
    NSString *suffix = [@", " stringByAppendingString:cover.accessibilityLabel];
    if (label.length > suffix.length && [label hasSuffix:suffix])
      label = [label substringToIndex:label.length - suffix.length];
  }
  BOOL avatar = [label isEqualToString:@"dev-gateway@localhost avatar"];
  BOOL row = [label isEqualToString:@"dev-gateway@localhost"] && view.bounds.size.width > 300 &&
             view.bounds.size.height > 50;
  if (!avatar && !row)
    return NO;
  if (RBHasAncestorPluginTag(view, 731993))
    return NO;
  RBRemoveDescendantPluginTag(view, 731993);
  if (cover && cover.superview != view)
    cover = nil;
  if (!cover) {
    cover = row ? [UIButton buttonWithType:UIButtonTypeCustom] : [UIView new];
    cover.tag = 731993;
    cover.frame = view.bounds;
    cover.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    cover.backgroundColor = [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
      return t.userInterfaceStyle == UIUserInterfaceStyleDark ? [UIColor colorWithWhite:.17 alpha:1]
                                                              : UIColor.whiteColor;
    }];
    if (row) {
      [(UIButton *)cover addTarget:RBProfileEntry.class
                            action:@selector(open)
                  forControlEvents:UIControlEventTouchUpInside];
      if (!view.userInteractionEnabled)
        view.userInteractionEnabled = YES;
    } else {
      cover.userInteractionEnabled = NO;
      cover.layer.cornerRadius = view.bounds.size.width / 2;
      cover.clipsToBounds = YES;
    }
    UIImageView *image = [UIImageView new];
    image.tag = 731994;
    image.contentMode = UIViewContentModeScaleAspectFill;
    image.clipsToBounds = YES;
    image.backgroundColor = UIColor.tertiarySystemGroupedBackgroundColor;
    [cover addSubview:image];
    UILabel *initial = [UILabel new];
    initial.tag = 731995;
    initial.textAlignment = NSTextAlignmentCenter;
    initial.font = [UIFont systemFontOfSize:17 weight:UIFontWeightMedium];
    initial.textColor = UIColor.secondaryLabelColor;
    [cover addSubview:initial];
    if (row) {
      UILabel *name = [UILabel new];
      name.tag = 731996;
      name.font = [UIFont systemFontOfSize:17];
      name.textColor = UIColor.labelColor;
      [cover addSubview:name];
      UILabel *subtitle = [UILabel new];
      subtitle.tag = 731997;
      subtitle.font = [UIFont systemFontOfSize:14];
      subtitle.textColor = UIColor.secondaryLabelColor;
      [cover addSubview:subtitle];
      UIImageView *chevron =
          [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"chevron.right"]];
      chevron.tag = 731998;
      chevron.tintColor = UIColor.tertiaryLabelColor;
      [cover addSubview:chevron];
    }
    [view addSubview:cover];
    RBTrackModifiedView(view);
  } else {
    RBTrackModifiedView(view);
    if (!CGRectEqualToRect(cover.frame, view.bounds))
      cover.frame = view.bounds;
    if (avatar) {
      CGFloat coverRadius = view.bounds.size.width / 2;
      if (cover.layer.cornerRadius != coverRadius)
        cover.layer.cornerRadius = coverRadius;
    }
  }
  if (cover.layer.zPosition != 1000)
    cover.layer.zPosition = 1000;
  if (view.subviews.lastObject != cover)
    [view bringSubviewToFront:cover];
  if (avatar) {
    for (UIView *child in view.subviews) {
      if (child == cover)
        continue;
      if (!objc_getAssociatedObject(child, &RBOriginalVisibility))
        objc_setAssociatedObject(child, &RBOriginalVisibility, @(child.hidden),
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (!child.hidden)
        child.hidden = YES;
    }
    // Fabric renders the original letter as an absolute-positioned sibling of
    // its image. Hide only that text inside the avatar rectangle, not row text.
    UIView *container = view.superview;
    Class paragraphClass = RBParagraphViewClass();
    if (container && paragraphClass) {
      CGRect avatarRect = [view convertRect:view.bounds toView:container];
      NSHashTable<UIView *> *hiddenSiblings = objc_getAssociatedObject(view, &RBHiddenSiblingsKey);
      for (UIView *sibling in container.subviews) {
        if (sibling == view || ![sibling isKindOfClass:paragraphClass])
          continue;
        CGRect textRect = [sibling convertRect:sibling.bounds toView:container];
        if (!CGRectContainsRect(avatarRect, textRect)) continue;
        if (!objc_getAssociatedObject(sibling, &RBOriginalVisibility))
          objc_setAssociatedObject(sibling, &RBOriginalVisibility, @(sibling.hidden),
                                   OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        if (!hiddenSiblings) {
          hiddenSiblings = NSHashTable.weakObjectsHashTable;
          objc_setAssociatedObject(view, &RBHiddenSiblingsKey, hiddenSiblings,
                                   OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        [hiddenSiblings addObject:sibling];
        if (!sibling.hidden)
          sibling.hidden = YES;
      }
    }
  }
  CGRect imageFrame = row ? CGRectMake(18, 15, 40, 40) : cover.bounds;
  UIImageView *image = (UIImageView *)[cover viewWithTag:731994];
  if (!CGRectEqualToRect(image.frame, imageFrame))
    image.frame = imageFrame;
  CGFloat imageRadius = imageFrame.size.width / 2;
  if (image.layer.cornerRadius != imageRadius)
    image.layer.cornerRadius = imageRadius;
  UIImage *avatarImage = RBProfileAvatar();
  if (image.image != avatarImage)
    image.image = avatarImage;
  NSString *displayName = RBProfileName();
  NSString *initialText = displayName.length
      ? [displayName substringWithRange:[displayName rangeOfComposedCharacterSequenceAtIndex:0]]
      : @"";
  UILabel *initial = (UILabel *)[cover viewWithTag:731995];
  if (!CGRectEqualToRect(initial.frame, imageFrame))
    initial.frame = imageFrame;
  BOOL hideInitial = (avatarImage != nil);
  if (initial.hidden != hideInitial)
    initial.hidden = hideInitial;
  if (![initial.text isEqualToString:initialText])
    initial.text = initialText;
  if (row) {
    UILabel *name = (UILabel *)[cover viewWithTag:731996];
    CGRect nameFrame = CGRectMake(68, 14, cover.bounds.size.width - 112, 22);
    if (!CGRectEqualToRect(name.frame, nameFrame))
      name.frame = nameFrame;
    if (![name.text isEqualToString:displayName])
      name.text = displayName;
    UILabel *subtitle = (UILabel *)[cover viewWithTag:731997];
    CGRect subtitleFrame = CGRectMake(68, 38, cover.bounds.size.width - 112, 18);
    if (!CGRectEqualToRect(subtitle.frame, subtitleFrame))
      subtitle.frame = subtitleFrame;
    NSString *hostName = RBProfileHostName();
    if (![subtitle.text isEqualToString:hostName])
      subtitle.text = hostName;
    UIView *chevron = [cover viewWithTag:731998];
    CGRect chevronFrame = CGRectMake(cover.bounds.size.width - 34, 27, 10, 16);
    if (!CGRectEqualToRect(chevron.frame, chevronFrame))
      chevron.frame = chevronFrame;
    NSString *coverLabel = [NSString stringWithFormat:RBL(@"个人资料，%@", @"Profile, %@"), displayName];
    if (![cover.accessibilityLabel isEqualToString:coverLabel])
      cover.accessibilityLabel = coverLabel;
  }
  return YES;
}
