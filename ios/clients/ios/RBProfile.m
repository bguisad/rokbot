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
      child.hidden = hidden.boolValue;
      objc_setAssociatedObject(child, &RBOriginalVisibility, nil,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
  }
}
NSString *RBProfileName(void) { return RBUserProfile[@"displayName"] ?: RBL(@"本地用户", @"Local user"); }
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
  [NSFileManager.defaultManager removeItemAtURL:RBProfileCacheURL() error:nil];
}
static void RBSaveProfileCache(void) {
  NSMutableDictionary *profile = [RBUserProfile mutableCopy];
  if (profile[@"avatarDataUrl"] == NSNull.null) [profile removeObjectForKey:@"avatarDataUrl"];
  if (profile[@"updatedAt"] == NSNull.null) [profile removeObjectForKey:@"updatedAt"];
  NSDictionary *cache = @{@"scope":RBProfileScope ?: RBCurrentProfileScope(), @"profile":profile};
  NSData *data = [NSPropertyListSerialization dataWithPropertyList:cache format:NSPropertyListBinaryFormat_v1_0 options:0 error:nil];
  NSURL *url = RBProfileCacheURL();
  [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
  [data writeToURL:url options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil];
  [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:url.path error:nil];
}
static void RBProfileRequest(NSString *method, NSDictionary *body,
                             void (^complete)(NSDictionary *, NSError *)) {
  if (!RBConnection.shared.deviceToken.length)
    return;
  RBRestoreProfileCache();
  NSString *serverURL = RBConnection.shared.serverURL;
  NSString *deviceToken = RBConnection.shared.deviceToken;
  NSMutableURLRequest *r = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[RBConnection.shared.serverURL
                                              stringByAppendingString:@"/local/profile"]]];
  r.HTTPMethod = method;
  r.timeoutInterval = 20;
  [r setValue:[@"Bearer " stringByAppendingString:RBConnection.shared.deviceToken]
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
          dispatch_async(dispatch_get_main_queue(), ^{
            if (![serverURL isEqual:RBConnection.shared.serverURL] ||
                ![deviceToken isEqual:RBConnection.shared.deviceToken]) return;
            if (error || ((NSHTTPURLResponse *)response).statusCode != 200 ||
                ![value isKindOfClass:NSDictionary.class] ||
                ![value[@"displayName"] isKindOfClass:NSString.class]) {
              if (complete)
                complete(nil,
                         error ?: [NSError errorWithDomain:@"RokBotProfile" code:1 userInfo:nil]);
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
  [provider loadObjectOfClass:UIImage.class
            completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
              if (error || ![object isKindOfClass:UIImage.class])
                return;
              UIImage *source = (UIImage *)object;
              dispatch_async(dispatch_get_main_queue(), ^{
                UIGraphicsImageRenderer *r =
                    [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(256, 256)];
                UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *c) {
                  CGFloat scale = MAX(256 / source.size.width, 256 / source.size.height);
                  CGSize size = CGSizeMake(source.size.width * scale, source.size.height * scale);
                  [source drawInRect:CGRectMake((256 - size.width) / 2, (256 - size.height) / 2,
                                                size.width, size.height)];
                }];
                self.avatarData = [@"data:image/png;base64,"
                    stringByAppendingString:[UIImagePNGRepresentation(image)
                                                base64EncodedStringWithOptions:0]];
                [self paint:image];
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
  if (!RBConnection.shared.deviceToken.length)
    return NO;
  NSString *label = view.accessibilityLabel;
  BOOL avatar = [label isEqual:@"dev-gateway@localhost avatar"];
  BOOL row = [label isEqual:@"dev-gateway@localhost"] && view.bounds.size.width > 300 &&
             view.bounds.size.height > 50;
  if (!avatar && !row)
    return NO;
  UIView *cover = [view viewWithTag:731993];
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
  }
  cover.layer.zPosition = 1000;
  [view bringSubviewToFront:cover];
  if (avatar) {
    for (UIView *child in view.subviews) {
      if (child == cover)
        continue;
      if (!objc_getAssociatedObject(child, &RBOriginalVisibility))
        objc_setAssociatedObject(child, &RBOriginalVisibility, @(child.hidden),
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      child.hidden = YES;
    }
  }
  if (avatar) {
    // Fabric renders the original letter as an absolute-positioned sibling of
    // its image. Hide only that text inside the avatar rectangle, not row text.
    UIView *container = view.superview;
    CGRect avatarRect = [view convertRect:view.bounds toView:container];
    for (UIView *sibling in container.subviews) {
      if (sibling == view || ![NSStringFromClass(sibling.class) isEqual:@"RCTParagraphComponentView"])
        continue;
      CGRect textRect = [sibling convertRect:sibling.bounds toView:container];
      if (!CGRectContainsRect(avatarRect, textRect)) continue;
      if (!objc_getAssociatedObject(sibling, &RBOriginalVisibility))
        objc_setAssociatedObject(sibling, &RBOriginalVisibility, @(sibling.hidden),
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      sibling.hidden = YES;
    }
  }
  CGRect imageFrame = row ? CGRectMake(18, 15, 40, 40) : cover.bounds;
  UIImageView *image = (UIImageView *)[cover viewWithTag:731994];
  image.frame = imageFrame;
  image.layer.cornerRadius = imageFrame.size.width / 2;
  image.image = RBProfileAvatar();
  image.backgroundColor = UIColor.tertiarySystemGroupedBackgroundColor;
  UILabel *initial = (UILabel *)[cover viewWithTag:731995];
  initial.frame = imageFrame;
  initial.hidden = image.image != nil;
  initial.text = [RBProfileName()
      substringWithRange:[RBProfileName() rangeOfComposedCharacterSequenceAtIndex:0]];
  if (row) {
    UILabel *name = (UILabel *)[cover viewWithTag:731996];
    name.frame = CGRectMake(68, 14, cover.bounds.size.width - 112, 22);
    name.text = RBProfileName();
    UILabel *subtitle = (UILabel *)[cover viewWithTag:731997];
    subtitle.frame = CGRectMake(68, 38, cover.bounds.size.width - 112, 18);
    subtitle.text = RBProfileHostName();
    [cover viewWithTag:731998].frame = CGRectMake(cover.bounds.size.width - 34, 27, 10, 16);
    cover.accessibilityLabel = [NSString stringWithFormat:RBL(@"个人资料，%@", @"Profile, %@"), RBProfileName()];
  }
  return YES;
}
