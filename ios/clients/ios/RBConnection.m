#import "RBConnection.h"
#import "RBNetwork.h"
#import "RBNetworkScanner.h"
#import "RBHTTP.h"
#import "RBHermes.h"
#import "RBProfile.h"
#import "RBPush.h"
#import "RBDiagnostics.h"
#import "RBLocalize.h"
#import "RBAppIntents.h"
#import <Security/Security.h>

static NSString *const RBURLKey = @"RokBotLocal.serverURL";
static NSString *RBService(void) {
  return [@"dev.rokbot.local." stringByAppendingString:NSBundle.mainBundle.bundleIdentifier];
}
static NSDictionary *RBKeychainQuery(void) {
  return @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : RBService(),
    (__bridge id)kSecAttrAccount : @"device-token"
  };
}
static NSString *RBReadToken(void) {
  NSMutableDictionary *q = [RBKeychainQuery() mutableCopy];
  q[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef result = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)q, &result) != errSecSuccess)
    return nil;
  return [[NSString alloc] initWithData:CFBridgingRelease(result) encoding:NSUTF8StringEncoding];
}
static BOOL RBWriteToken(NSString *token) {
  NSMutableDictionary *q = [RBKeychainQuery() mutableCopy];
  NSDictionary *attrs = @{
    (__bridge id)kSecValueData : [token dataUsingEncoding:NSUTF8StringEncoding],
    (__bridge id)kSecAttrAccessible : (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  };
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)q, (__bridge CFDictionaryRef)attrs);
  if (status == errSecItemNotFound) {
    [q addEntriesFromDictionary:attrs];
    status = SecItemAdd((__bridge CFDictionaryRef)q, NULL);
  }
  return status == errSecSuccess;
}
static UIViewController *RBTop(void) {
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)scene).windows)
        if (w.isKeyWindow)
          window = w;
  UIViewController *vc = window.rootViewController;
  while (vc.presentedViewController)
    vc = vc.presentedViewController;
  return vc;
}
@interface RBPairController : UIViewController <NSURLSessionTaskDelegate>
@property(nonatomic, strong) UITextField *address;
@property(nonatomic, strong) UITextField *key;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, strong) UIButton *connect;
@property(nonatomic, strong) UISwitch *tailcat;
@property(nonatomic, strong) UILabel *networkLabel;
@property(nonatomic, strong) NSTimer *networkTimer;
@property(nonatomic, assign) BOOL editingConnection;
@property(nonatomic, assign) BOOL cancelled;
@end
@interface RBConnection ()
@property(nonatomic, readwrite) NSString *serverURL;
@property(nonatomic, readwrite) NSString *deviceToken;
@property(nonatomic, readwrite) NSURL *gatewayBundleURL;
@property(nonatomic, weak) RBPairController *controller;
@end
@implementation RBConnection
+ (instancetype)shared {
  static RBConnection *v;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    v = [self new];
  });
  return v;
}
- (BOOL)restore:(NSError **)error {
  RBDiagnosticsEvent(@"connection.credentials.begin", @{});
  self.serverURL = RBNetworkRestore([NSUserDefaults.standardUserDefaults stringForKey:RBURLKey]);
  self.deviceToken = RBReadToken();
  RBSyncAppIntentCredentials();
  RBDiagnosticsEvent(@"connection.credentials.end", @{});
  if (!self.serverURL.length || !self.deviceToken.length)
    return NO;
  RBRestoreProfileCache();
  RBDiagnosticsEvent(@"connection.script.begin", @{});
  self.gatewayBundleURL = [RBHermes writeGateway:self.serverURL
                                           token:self.deviceToken
                                       resources:self.resourcesURL
                                           error:error];
  RBDiagnosticsEvent(@"connection.script.end", @{});
  return self.gatewayBundleURL != nil;
}
- (void)show {
  if (self.controller) {
    if (self.controller.address) [self.controller.address becomeFirstResponder];
    return;
  }
  RBPairController *vc = [RBPairController new];
  self.controller = vc;
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:vc];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  if (@available(iOS 15.0, *)) {
    nav.sheetPresentationController.detents = @[ UISheetPresentationControllerDetent.largeDetent ];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
  }
  [RBTop() presentViewController:nav animated:YES completion:nil];
}
- (void)disconnect {
  RBNetworkClear();
  RBClearProfileCache();
  SecItemDelete((__bridge CFDictionaryRef)RBKeychainQuery());
  [NSUserDefaults.standardUserDefaults removeObjectForKey:RBURLKey];
  [NSUserDefaults.standardUserDefaults removeObjectForKey:@"RokBotLocal.deviceId"];
  if (self.gatewayBundleURL)
    [NSFileManager.defaultManager removeItemAtURL:self.gatewayBundleURL error:nil];
  self.gatewayBundleURL = nil;
  self.serverURL = nil;
  self.deviceToken = nil;
  RBSyncAppIntentCredentials();
  if (self.didDisconnect)
    self.didDisconnect();
  RBReloadReactHost();
}
@end
@implementation RBPairController
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
- (UITextField *)field:(NSString *)placeholder secure:(BOOL)secure {
  UITextField *f = [UITextField new];
  f.placeholder = placeholder;
  f.secureTextEntry = secure;
  f.borderStyle = UITextBorderStyleNone;
  f.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  f.layer.cornerRadius = 16;
  f.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 16, 1)];
  f.leftViewMode = UITextFieldViewModeAlways;
  f.textColor = UIColor.labelColor;
  f.autocapitalizationType = UITextAutocapitalizationTypeNone;
  f.autocorrectionType = UITextAutocorrectionTypeNo;
  f.clearButtonMode = UITextFieldViewModeWhileEditing;
  f.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  [f.heightAnchor constraintEqualToConstant:50].active = YES;
  return f;
}
- (UILabel *)label:(NSString *)text size:(CGFloat)size weight:(UIFontWeight)weight {
  UILabel *label = [UILabel new];
  label.text = text; label.font = [UIFont systemFontOfSize:size weight:weight];
  label.textColor = UIColor.labelColor; label.numberOfLines = 0;
  return label;
}
- (void)viewDidLoad {
  [super viewDidLoad]; [self renderConnection];
}
- (void)viewWillAppear:(BOOL)animated {
  [super viewWillAppear:animated];
  __weak RBPairController *weak = self;
  self.networkTimer = [NSTimer scheduledTimerWithTimeInterval:2 repeats:YES block:^(NSTimer *timer) {
    [weak updateNetworkState];
  }];
  [self updateNetworkState];
}
- (void)viewWillDisappear:(BOOL)animated {
  [self.networkTimer invalidate]; self.networkTimer = nil;
  [super viewWillDisappear:animated];
}
- (void)updateNetworkState {
  if (self.editingConnection || !RBConnection.shared.deviceToken.length) return;
  if (!RBNetworkEnabled()) { self.networkLabel.text = RBL(@"已连接", @"Connected"); return; }
  self.networkLabel.text = [RBNetworkStatus()[@"healthy"] boolValue]
    ? RBL(@"已连接 · Tailcat", @"Connected · Tailcat")
    : RBL(@"正在重新连接 · Tailcat", @"Reconnecting · Tailcat");
}
- (void)renderConnection {
  for (UIView *subview in self.view.subviews) [subview removeFromSuperview];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = RBL(@"连接设置", @"Connection");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self action:@selector(close)];
  UIScrollView *scroll = [UIScrollView new];
  scroll.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:scroll];
  UIStackView *stack = [UIStackView new];
  stack.axis = UILayoutConstraintAxisVertical; stack.spacing = 24;
  stack.translatesAutoresizingMaskIntoConstraints = NO; [scroll addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [scroll.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
    [scroll.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [stack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-24],
    [stack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:32],
    [stack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-32],
    [stack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-48]
  ]];
  BOOL connected = RBConnection.shared.deviceToken.length > 0 && !self.editingConnection;
  UIImageView *icon = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:connected ? @"checkmark.circle.fill" : @"link.circle.fill"]];
  icon.tintColor = UIColor.labelColor; icon.contentMode = UIViewContentModeScaleAspectFit;
  [icon.heightAnchor constraintEqualToConstant:52].active = YES;
  UILabel *heading = [self label:connected ? RBProfileHostName() : RBL(@"连接你的 RokBot", @"Connect your RokBot") size:28 weight:UIFontWeightBold];
  heading.textAlignment = NSTextAlignmentCenter;
  UILabel *subtitle = [self label:connected ? (RBNetworkEnabled() ? RBL(@"已连接 · Tailcat", @"Connected · Tailcat") : RBL(@"已连接", @"Connected")) : (self.editingConnection ? RBL(@"编辑连接", @"Edit connection") : RBL(@"地址与配对码", @"Host address and pairing code")) size:15 weight:UIFontWeightRegular];
  self.networkLabel = subtitle;
  [self updateNetworkState];
  subtitle.textColor = UIColor.secondaryLabelColor; subtitle.textAlignment = NSTextAlignmentCenter;
  UIStackView *hero = [[UIStackView alloc] initWithArrangedSubviews:@[icon, heading, subtitle]];
  hero.axis = UILayoutConstraintAxisVertical; hero.spacing = 12;
  [stack addArrangedSubview:hero]; [stack setCustomSpacing:36 afterView:hero];
  if (connected) {
    UIView *card = [UIView new]; card.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    card.layer.cornerRadius = 20; [card.heightAnchor constraintGreaterThanOrEqualToConstant:96].active = YES;
    UIImageView *avatar = [[UIImageView alloc] initWithImage:RBProfileAvatar() ?: [UIImage systemImageNamed:@"person.crop.circle.fill"]];
    avatar.tintColor = UIColor.secondaryLabelColor; avatar.contentMode = UIViewContentModeScaleAspectFill;
    avatar.layer.cornerRadius = 24; avatar.clipsToBounds = YES;
    UILabel *name = [self label:RBProfileName() size:17 weight:UIFontWeightSemibold];
    UILabel *device = [self label:UIDevice.currentDevice.name size:14 weight:UIFontWeightRegular];
    device.textColor = UIColor.secondaryLabelColor;
    UIStackView *identity = [[UIStackView alloc] initWithArrangedSubviews:@[name, device]];
    identity.axis = UILayoutConstraintAxisVertical; identity.spacing = 5;
    UIStackView *row = [[UIStackView alloc] initWithArrangedSubviews:@[avatar, identity]];
    row.axis = UILayoutConstraintAxisHorizontal; row.alignment = UIStackViewAlignmentCenter; row.spacing = 16;
    row.translatesAutoresizingMaskIntoConstraints = NO; [card addSubview:row];
    [NSLayoutConstraint activateConstraints:@[
      [avatar.widthAnchor constraintEqualToConstant:48], [avatar.heightAnchor constraintEqualToConstant:48],
      [row.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:20],
      [row.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-20],
      [row.topAnchor constraintEqualToAnchor:card.topAnchor constant:20],
      [row.bottomAnchor constraintEqualToAnchor:card.bottomAnchor constant:-20]
    ]];
    [stack addArrangedSubview:card];
    UIButton *edit = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *editConfig = UIButtonConfiguration.tintedButtonConfiguration;
    editConfig.title = RBL(@"编辑连接", @"Edit connection"); editConfig.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    editConfig.baseForegroundColor = UIColor.labelColor;
    editConfig.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    edit.configuration = editConfig;
    edit.accessibilityIdentifier = @"rokbot.host.edit";
    [edit.heightAnchor constraintEqualToConstant:50].active = YES;
    [edit addTarget:self action:@selector(editConnection) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:edit];
    UIButton *disconnect = [UIButton buttonWithType:UIButtonTypeSystem];
    UIButtonConfiguration *config = UIButtonConfiguration.tintedButtonConfiguration;
    config.title = RBL(@"退出连接", @"Disconnect"); config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    config.baseForegroundColor = UIColor.systemRedColor; config.baseBackgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
    disconnect.configuration = config; disconnect.accessibilityIdentifier = @"rokbot.host.disconnect";
    [disconnect.heightAnchor constraintEqualToConstant:50].active = YES;
    [disconnect addTarget:self action:@selector(disconnect) forControlEvents:UIControlEventTouchUpInside];
    [stack addArrangedSubview:disconnect];
    return;
  }
  self.address = [self field:@"https://bot.example.com" secure:NO];
  self.address.keyboardType = UIKeyboardTypeURL;
  self.address.text = RBNetworkAddress().length ? RBNetworkAddress() : [NSUserDefaults.standardUserDefaults stringForKey:RBURLKey];
  self.tailcat = [UISwitch new]; self.tailcat.on = RBNetworkEnabled();
  self.tailcat.accessibilityIdentifier = @"rokbot.host.tailcat";
  UILabel *networkLabel = [self label:@"Tailcat" size:17 weight:UIFontWeightMedium];
  UIButton *scan = [UIButton buttonWithType:UIButtonTypeSystem];
  [scan setImage:[UIImage systemImageNamed:@"qrcode.viewfinder"] forState:UIControlStateNormal];
  scan.tintColor = UIColor.labelColor; scan.accessibilityLabel = RBL(@"扫描连接二维码", @"Scan connection code");
  [scan.widthAnchor constraintEqualToConstant:44].active = YES; [scan.heightAnchor constraintEqualToConstant:44].active = YES;
  [scan addTarget:self action:@selector(scanConnection) forControlEvents:UIControlEventTouchUpInside];
  UIStackView *networkRow = [[UIStackView alloc] initWithArrangedSubviews:@[networkLabel, scan, self.tailcat]];
  networkRow.alignment = UIStackViewAlignmentCenter;
  [self.tailcat addTarget:self action:@selector(networkChanged) forControlEvents:UIControlEventValueChanged];
  [stack addArrangedSubview:networkRow];
  [self networkChanged];
  self.address.accessibilityIdentifier = @"rokbot.host.address";
  self.key = [self field:RBL(@"配对码", @"Pairing code") secure:YES];
  self.key.accessibilityIdentifier = @"rokbot.host.pairing-key";
  self.key.secureTextEntry = NO; self.key.autocapitalizationType = UITextAutocapitalizationTypeAllCharacters;
  self.key.font = [UIFont monospacedSystemFontOfSize:20 weight:UIFontWeightMedium];
  self.key.textContentType = UITextContentTypeOneTimeCode;
  UIStackView *fields = [[UIStackView alloc] initWithArrangedSubviews:@[self.address,self.key]];
  fields.axis = UILayoutConstraintAxisVertical; fields.spacing = 12;
  self.key.hidden = self.editingConnection;
  [stack addArrangedSubview:fields];
  self.connect = [UIButton buttonWithType:UIButtonTypeSystem];
  UIButtonConfiguration *config = UIButtonConfiguration.filledButtonConfiguration;
  config.title = self.editingConnection ? RBL(@"保存", @"Save") : RBL(@"连接", @"Connect"); config.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
  config.baseBackgroundColor = UIColor.labelColor; config.baseForegroundColor = UIColor.systemBackgroundColor;
  self.connect.configuration = config;
  [self.connect.heightAnchor constraintEqualToConstant:50].active = YES;
  [self.connect addTarget:self action:@selector(pair) forControlEvents:UIControlEventTouchUpInside];
  self.connect.accessibilityIdentifier = @"rokbot.host.connect";
  [stack addArrangedSubview:self.connect];
  self.status = [self label:@"" size:13 weight:UIFontWeightRegular];
  self.status.textColor = UIColor.secondaryLabelColor; [stack addArrangedSubview:self.status];
}
- (void)scanConnection {
  RBPresentNetworkScanner(self, ^(NSString *address) { self.address.text = address; self.tailcat.on = YES; [self networkChanged]; });
}
- (void)editConnection { self.editingConnection = YES; [self renderConnection]; }
- (void)networkChanged { self.address.placeholder = self.tailcat.on ? @"tailcat://connect/…" : @"https://bot.example.com"; }
- (void)close {
  self.cancelled = YES;
  RBNetworkRollback();
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)disconnect {
  [RBConnection.shared disconnect];
  self.editingConnection = NO; [self renderConnection];
}
- (void)fail:(NSString *)message {
  RBNetworkRollback();
  self.status.text = message;
  self.status.textColor = UIColor.systemRedColor;
  self.connect.enabled = YES;
}
- (void)updateConnection:(NSString *)base {
  self.connect.enabled = NO; self.status.text = RBL(@"正在连接…", @"Connecting…");
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[base stringByAppendingString:@"/connect/status"]]];
  request.timeoutInterval = 35;
  [request setValue:[@"Bearer " stringByAppendingString:RBConnection.shared.deviceToken] forHTTPHeaderField:@"Authorization"];
  [[RBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.cancelled) return;
      NSInteger code = [response isKindOfClass:NSHTTPURLResponse.class] ? ((NSHTTPURLResponse *)response).statusCode : 0;
      if (error || code != 200) { [self fail:RBL(@"无法验证此 Host 的设备凭据。", @"Could not verify this device with the Host.")]; return; }
      NSURL *bundle = [RBHermes writeGateway:base token:RBConnection.shared.deviceToken resources:RBConnection.shared.resourcesURL error:nil];
      if (!bundle || !RBNetworkCommit()) { [self fail:RBL(@"无法保存连接。", @"Could not save connection.")]; return; }
      [NSUserDefaults.standardUserDefaults setObject:RBNetworkAddress() forKey:RBURLKey];
      RBConnection.shared.serverURL = base; RBConnection.shared.gatewayBundleURL = bundle; RBSyncAppIntentCredentials();
      [self dismissViewControllerAnimated:YES completion:^{ RBReloadReactHost(); if (RBConnection.shared.didConnect) RBConnection.shared.didConnect(); }];
    });
  }] resume];
}
- (void)pair {
  NSString *address = [self.address.text
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSError *networkError = nil;
  NSString *base = RBNetworkPrepare(address, self.tailcat.on, &networkError);
  if (!base) { [self fail:networkError.localizedDescription]; return; }
  if (self.editingConnection) { [self updateConnection:base]; return; }
  NSString *key = [self.key.text
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!key.length) {
    [self fail:RBL(@"请输入配对码。", @"Enter a pairing code.")];
    return;
  }
  self.connect.enabled = NO;
  self.status.text = RBL(@"正在连接…", @"Connecting…");
  self.status.textColor = UIColor.secondaryLabelColor;
  NSMutableURLRequest *request = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[base stringByAppendingString:@"/connect/pair"]]];
  request.HTTPMethod = @"POST";
  request.timeoutInterval = 20;
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{
    @"pairingKey" : key,
    @"deviceName" : UIDevice.currentDevice.name,
    @"platform" : @"ios"
  }
                                                     options:0
                                                       error:nil];
  NSURLSessionConfiguration *sessionConfig =
      NSURLSessionConfiguration.ephemeralSessionConfiguration;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:sessionConfig
                                                        delegate:self
                                                   delegateQueue:nil];
  __weak typeof(self) weak = self;
  [[session dataTaskWithRequest:request
              completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                NSDictionary *result =
                    data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
                NSInteger status = [response isKindOfClass:NSHTTPURLResponse.class]
                                       ? ((NSHTTPURLResponse *)response).statusCode
                                       : 0;
                dispatch_async(dispatch_get_main_queue(), ^{
                  typeof(self) strong = weak;
                  if (!strong || strong.cancelled)
                    return;
                  if (error) {
                    [strong fail:RBL(@"无法连接 Host。", @"Could not connect to Host.")];
                    return;
                  }
                  if (status != 200 && status != 201) {
                    [strong fail:status == 401 ? RBL(@"配对码无效或已过期。", @"Pairing code is invalid or expired.")
                                               : RBL(@"配对失败，请重试。", @"Pairing failed. Try again.")];
                    return;
                  }
                  if (![result isKindOfClass:NSDictionary.class]) {
                    [strong fail:RBL(@"Host 返回无效配置。", @"Host returned an invalid configuration.")];
                    return;
                  }
                  NSString *token =
                      [result[@"token"] isKindOfClass:NSString.class] ? result[@"token"] : nil;
                  NSURLComponents *gateway =
                      [NSURLComponents componentsWithString:result[@"gatewayUrl"] ?: @""];
                  if (!token.length || (!strong.tailcat.on && ![gateway.URL.absoluteString isEqual:base])) {
                    [strong fail:RBL(@"Host 配置不匹配。", @"Host configuration does not match.")];
                    return;
                  }
                  NSError *bundleError = nil;
                  NSURL *bundle = [RBHermes writeGateway:base
                                                   token:token
                                               resources:RBConnection.shared.resourcesURL
                                                   error:&bundleError];
                  if (!bundle) {
                    [strong fail:bundleError.localizedDescription ?: RBL(@"无法加载连接模块。", @"Could not load the connection module.")];
                    return;
                  }
                  if (!RBWriteToken(token) || !RBNetworkCommit()) {
                    [strong fail:RBL(@"无法保存设备凭证。", @"Could not save the device credential.")];
                    return;
                  }
                  [NSUserDefaults.standardUserDefaults setObject:RBNetworkAddress() forKey:RBURLKey];
                  [NSUserDefaults.standardUserDefaults setObject:result[@"deviceId"] ?: @""
                                                          forKey:@"RokBotLocal.deviceId"];
                  RBConnection.shared.serverURL = base;
                  RBConnection.shared.deviceToken = token;
                  RBRestoreProfileCache();
                  RBConnection.shared.gatewayBundleURL = bundle;
                  strong.key.text = @"";
                  [strong dismissViewControllerAnimated:YES
                                             completion:^{
                                               RBReloadReactHost();
                                               if (RBConnection.shared.didConnect)
                                                 RBConnection.shared.didConnect();
                                             }];
                });
                [session finishTasksAndInvalidate];
              }] resume];
}
@end
