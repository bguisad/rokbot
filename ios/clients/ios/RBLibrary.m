#import "RBLocalize.h"
#import "RBLibrary.h"
#import "RBConnection.h"
#import "RBHTTP.h"
#import "RBChoiceSheet.h"
#import "RBSuggestions.h"
#import "RBCanvas.h"
#import "RBHostAPI.h"
#import <QuickLook/QuickLook.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString *RBCurrentAgent;
void RBObserveRequest(NSURLRequest *request) {
  NSString *path = request.URL.path;
  if ([path hasPrefix:@"/api/"] && request.HTTPBody.length)
    RBSuggestionsNoteRequest(path, request.HTTPBody);
  if (![path hasPrefix:@"/api/"] ||
      ![path.lastPathComponent isEqualToString:@"openAgentWindowed"] ||
      !request.HTTPBody.length)
    return;
  NSDictionary *body = [NSJSONSerialization JSONObjectWithData:request.HTTPBody
                                                       options:0
                                                         error:nil];
  NSString *agent = [body isKindOfClass:NSDictionary.class] ? body[@"id"] : nil;
  if ([agent isKindOfClass:NSString.class] && agent.length)
    dispatch_async(dispatch_get_main_queue(), ^{ RBCurrentAgent = agent; });
}
@interface RBLibraryController
    : UITableViewController <UIDocumentPickerDelegate, QLPreviewControllerDataSource>
@property(nonatomic, copy) NSString *agentId;
@property(nonatomic, copy) NSArray<NSDictionary *> *files;
// The Bot's canvases come first, like the official Library "页面" before files.
@property(nonatomic, copy) NSArray<NSDictionary *> *canvases;
@property(nonatomic, copy) NSString *canvasStatus;
@property(nonatomic, strong) NSURL *previewURL;
@property(nonatomic, strong) UILabel *status;
@end
@implementation RBLibraryController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = RBL(@"资料库", @"Library");
  self.files = @[];
  self.canvases = @[];
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemAdd
                                                    target:self
                                                    action:@selector(add)];
  self.refreshControl = [UIRefreshControl new];
  [self.refreshControl addTarget:self
                          action:@selector(reload)
                forControlEvents:UIControlEventValueChanged];
  self.status = [UILabel new];
  self.status.numberOfLines = 0;
  self.status.textAlignment = NSTextAlignmentCenter;
  self.status.textColor = UIColor.secondaryLabelColor;
  self.status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
  self.status.frame = CGRectMake(0, 0, self.view.bounds.size.width, 72);
  self.tableView.tableFooterView = self.status;
  [self reload];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)request:(NSString *)method
           path:(NSString *)path
           body:(NSDictionary *)body
       complete:(void (^)(NSData *, NSHTTPURLResponse *, NSError *))complete {
  NSString *base = RBConnection.shared.serverURL;
  NSString *token = RBConnection.shared.deviceToken;
  NSURL *url = base.length ? [NSURL URLWithString:[base stringByAppendingString:path]] : nil;
  if (!url || !token.length) {
    dispatch_async(dispatch_get_main_queue(), ^{
      complete(nil, nil, [NSError errorWithDomain:@"RokBotLibrary" code:401 userInfo:nil]);
    });
    return;
  }
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url];
  r.HTTPMethod = method;
  r.timeoutInterval = 30;
  [r setValue:[@"Bearer " stringByAppendingString:token]
      forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[RBHTTPSession() dataTaskWithRequest:r
                      completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                        NSHTTPURLResponse *http = [response isKindOfClass:NSHTTPURLResponse.class]
                            ? (NSHTTPURLResponse *)response : nil;
                        dispatch_async(dispatch_get_main_queue(), ^{
                          complete(data, http, error);
                        });
                      }] resume];
}
- (NSString *)encoded:(NSString *)s {
  return [s stringByAddingPercentEncodingWithAllowedCharacters:
                [NSCharacterSet
                    characterSetWithCharactersInString:
                        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"]];
}
- (void)viewWillAppear:(BOOL)animated {
  [super viewWillAppear:animated];
  [self reloadCanvases];
}
- (void)reloadCanvases {
  if (!self.canvases.count) self.canvasStatus = RBL(@"正在加载画布…", @"Loading canvases…");
  RBHostRequest(@"GET", [@"/local/canvases?agentId=" stringByAppendingString:[self encoded:self.agentId]], nil, 15,
                ^(NSInteger status, id json, NSError *error) {
    if (status == 200 && [json[@"canvases"] isKindOfClass:NSArray.class]) {
      self.canvases = json[@"canvases"];
      self.canvasStatus = self.canvases.count ? nil : RBL(@"这个 Bot 创建的画布会显示在这里。", @"Canvases this Bot makes show up here.");
    } else {
      self.canvasStatus = RBL(@"无法加载画布。", @"Couldn’t load canvases.");
    }
    [self.tableView reloadData];
  });
}
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
  return 2;
}
- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  return section == 0 ? RBL(@"画布", @"Canvases") : RBL(@"文件", @"Files");
}
- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
  return section == 0 ? self.canvasStatus : nil;
}
- (UITableViewCell *)canvasCell:(NSIndexPath *)indexPath {
  NSDictionary *canvas = self.canvases[indexPath.row];
  UITableViewCell *cell = [self.tableView dequeueReusableCellWithIdentifier:@"canvas"]
                              ?: [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle reuseIdentifier:@"canvas"];
  BOOL isPublic = [canvas[@"visibility"] isEqual:@"public"];
  cell.textLabel.text = canvas[@"title"];
  cell.textLabel.font = [UIFont systemFontOfSize:16 weight:UIFontWeightSemibold];
  double updated = [canvas[@"updatedAtMs"] doubleValue];
  BOOL chinese = [RBL(@"zh", @"en") isEqual:@"zh"];
  NSString *time = RBCanvasShortTime(updated, NSDate.date.timeIntervalSince1970 * 1000, chinese);
  NSString *mark = isPublic ? RBL(@"公开", @"Public") : RBL(@"私有", @"Private");
  NSMutableAttributedString *meta = [[NSMutableAttributedString alloc] initWithString:[NSString stringWithFormat:@"%@  ·  ", time]
      attributes:@{NSForegroundColorAttributeName : UIColor.secondaryLabelColor}];
  [meta appendAttributedString:[[NSAttributedString alloc] initWithString:mark attributes:@{
    NSForegroundColorAttributeName : isPublic ? [UIColor colorWithRed:0.10 green:0.56 blue:0.36 alpha:1] : UIColor.secondaryLabelColor}]];
  cell.detailTextLabel.attributedText = meta;
  cell.imageView.image = [UIImage systemImageNamed:@"doc.richtext"];
  cell.imageView.tintColor = UIColor.secondaryLabelColor;
  cell.accessibilityIdentifier = [@"canvas_row_" stringByAppendingString:canvas[@"id"] ?: @""];
  // The row's menu, after the official page row: 打开, 分享…, 删除… (confirmed).
  UIButton *more = [UIButton buttonWithType:UIButtonTypeSystem];
  [more setTitle:@"···" forState:UIControlStateNormal];
  more.titleLabel.font = [UIFont systemFontOfSize:20 weight:UIFontWeightBold];
  more.tintColor = UIColor.secondaryLabelColor;
  more.frame = CGRectMake(0, 0, 44, 44);
  more.accessibilityLabel = [NSString stringWithFormat:RBL(@"“%@”的更多操作", @"More actions for %@"), canvas[@"title"] ?: @""];
  __weak typeof(self) weak = self;
  more.menu = [UIMenu menuWithChildren:@[
    [UIAction actionWithTitle:RBL(@"打开", @"Open") image:nil identifier:nil handler:^(UIAction *a) { RBPresentCanvas(canvas[@"id"], canvas[@"title"]); }],
    [UIAction actionWithTitle:RBL(@"分享…", @"Share…") image:nil identifier:nil handler:^(UIAction *a) {
      RBPresentCanvasShare(weak, canvas, ^(NSDictionary *next) { [weak reloadCanvases]; });
    }],
    [UIAction actionWithTitle:RBL(@"删除…", @"Delete…") image:nil identifier:nil handler:^(UIAction *a) { [weak confirmDeleteCanvas:canvas]; }],
  ]];
  more.showsMenuAsPrimaryAction = YES;
  cell.accessoryView = more;
  return cell;
}
- (void)confirmDeleteCanvas:(NSDictionary *)canvas {
  UIAlertController *alert = [UIAlertController
      alertControllerWithTitle:[NSString stringWithFormat:RBL(@"删除“%@”", @"Delete “%@”"), canvas[@"title"] ?: @""]
                       message:RBL(@"这会永久删除这个画布。它的公开链接会立即失效，聊天里的画布卡片会显示为已删除。此操作无法撤销。",
                                   @"This permanently deletes the canvas. Its public link stops working and chat cards show it as deleted. This can’t be undone.")
                preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel") style:UIAlertActionStyleCancel handler:nil]];
  [alert addAction:[UIAlertAction actionWithTitle:RBL(@"删除画布", @"Delete canvas") style:UIAlertActionStyleDestructive handler:^(UIAlertAction *a) {
    RBHostRequest(@"DELETE", [@"/local/canvases/" stringByAppendingString:RBHostPathSegment(canvas[@"id"] ?: @"")], nil, 20,
                  ^(NSInteger status, id json, NSError *error) {
      if (status != 200) self.canvasStatus = RBL(@"无法删除画布，请稍后再试。", @"Couldn’t delete the canvas. Try again later.");
      [self reloadCanvases];
    });
  }]];
  [self presentViewController:alert animated:YES completion:nil];
}
- (void)reload {
  [self reloadCanvases];
  self.status.text = RBL(@"正在读取…", @"Loading…");
  [self request:@"GET"
           path:[@"/local/files?agentId=" stringByAppendingString:[self encoded:self.agentId]]
           body:nil
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         [self.refreshControl endRefreshing];
         NSDictionary *value =
             data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
         if (error || r.statusCode != 200 || ![value[@"files"] isKindOfClass:NSArray.class]) {
           self.status.text = RBL(@"加载失败，下拉重试。", @"Could not load. Pull to retry.");
           return;
         }
         self.files = value[@"files"];
         self.status.text = self.files.count ? @""
                                             : RBL(@"暂无文件", @"No files yet");
         [self.tableView reloadData];
       }];
}
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return section == 0 ? self.canvases.count : self.files.count;
}
- (UITableViewCell *)tableView:(UITableView *)tableView
         cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.section == 0) return [self canvasCell:indexPath];
  UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"file"]
                              ?: [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle
                                                        reuseIdentifier:@"file"];
  NSDictionary *file = self.files[indexPath.row];
  cell.textLabel.text = file[@"name"];
  cell.detailTextLabel.text =
      [NSByteCountFormatter stringFromByteCount:[file[@"sizeBytes"] longLongValue]
                                     countStyle:NSByteCountFormatterCountStyleFile];
  cell.imageView.image = [UIImage systemImageNamed:@"doc.text"];
  cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
  return cell;
}
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  if (indexPath.section == 0) {
    NSDictionary *canvas = self.canvases[indexPath.row];
    RBPresentCanvas(canvas[@"id"], canvas[@"title"]);
    return;
  }
  NSDictionary *file = self.files[indexPath.row];
  self.status.text = RBL(@"正在打开…", @"Opening…");
  NSString *path =
      [NSString stringWithFormat:@"/local/files/content?agentId=%@&name=%@",
                                 [self encoded:self.agentId], [self encoded:file[@"name"]]];
  [self request:@"GET"
           path:path
           body:nil
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         if (error || r.statusCode != 200) {
           self.status.text = RBL(@"无法打开文件，请重试。", @"Could not open the file. Try again.");
           return;
         }
         NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                            inDomains:NSUserDomainMask]
                           .firstObject URLByAppendingPathComponent:@"RokBotFilePreview"
                                                        isDirectory:YES];
         [NSFileManager.defaultManager
                    createDirectoryAtURL:dir
             withIntermediateDirectories:YES
                              attributes:@{
                                NSFileProtectionKey :
                                    NSFileProtectionCompleteUntilFirstUserAuthentication
                              }
                                   error:nil];
         self.previewURL = [dir URLByAppendingPathComponent:[file[@"name"] lastPathComponent]];
         [data writeToURL:self.previewURL options:NSDataWritingAtomic error:nil];
         self.status.text = @"";
         NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
         if (text && ([file[@"contentType"] hasPrefix:@"text/"] ||
                      [@[ @"txt", @"md", @"json", @"csv", @"log" ]
                          containsObject:[file[@"name"] pathExtension].lowercaseString])) {
           UIViewController *reader = [UIViewController new];
           reader.title = file[@"name"];
           UITextView *content = [[UITextView alloc] initWithFrame:reader.view.bounds];
           content.autoresizingMask =
               UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
           content.editable = NO;
           content.text = text;
           content.font = [UIFont monospacedSystemFontOfSize:16 weight:UIFontWeightRegular];
           content.backgroundColor = UIColor.systemGroupedBackgroundColor;
           content.textColor = UIColor.labelColor;
           content.textContainerInset = UIEdgeInsetsMake(24, 20, 24, 20);
           [reader.view addSubview:content];
           [self.navigationController pushViewController:reader animated:YES];
         } else {
           QLPreviewController *preview = [QLPreviewController new];
           preview.dataSource = self;
           [self.navigationController pushViewController:preview animated:YES];
         }
       }];
}
- (NSInteger)numberOfPreviewItemsInPreviewController:(QLPreviewController *)controller {
  return self.previewURL ? 1 : 0;
}
- (id<QLPreviewItem>)previewController:(QLPreviewController *)controller
                    previewItemAtIndex:(NSInteger)index {
  return self.previewURL;
}
- (BOOL)tableView:(UITableView *)tableView canEditRowAtIndexPath:(NSIndexPath *)indexPath {
  return indexPath.section == 1;
}
- (void)tableView:(UITableView *)tableView
    commitEditingStyle:(UITableViewCellEditingStyle)style
     forRowAtIndexPath:(NSIndexPath *)indexPath {
  if (style != UITableViewCellEditingStyleDelete || indexPath.section != 1)
    return;
  NSString *name = self.files[indexPath.row][@"name"];
  [self request:@"DELETE"
           path:@"/local/files"
           body:@{@"agentId" : self.agentId, @"name" : name}
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         if (error || r.statusCode != 200) {
           self.status.text = RBL(@"删除失败，请重试。", @"Could not delete. Try again.");
           return;
         }
         [self reload];
       }];
}
- (void)upload:(NSData *)data name:(NSString *)name mime:(NSString *)mime {
  if (data.length > 20 * 1024 * 1024) {
    self.status.text = RBL(@"单个文件最大为 20 MiB。", @"Files can be up to 20 MiB.");
    return;
  }
  self.status.text = RBL(@"正在上传…", @"Uploading…");
  [self request:@"POST"
           path:@"/local/files"
           body:@{
             @"agentId" : self.agentId,
             @"fileName" : name,
             @"contentType" : mime ?: @"application/octet-stream",
             @"base64" : [data base64EncodedStringWithOptions:0]
           }
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         if (error || r.statusCode != 200) {
           self.status.text = RBL(@"上传失败，请重试。", @"Could not upload. Try again.");
           return;
         }
         [self reload];
       }];
}
- (void)add {
  NSArray<RBChoiceOption *> *options = @[
    [RBChoiceOption optionWithValue:@"file" title:RBL(@"选择文件", @"Choose file") subtitle:nil],
    [RBChoiceOption optionWithValue:@"text" title:RBL(@"添加文本", @"Add text") subtitle:nil],
  ];
  [[RBChoiceSheet sheetWithTitle:RBL(@"添加资料", @"Add to library") message:nil options:options selected:nil
                        onSelect:^(RBChoiceOption *option) {
                          if ([option.value isEqualToString:@"file"]) [self chooseFile];
                          else [self addText];
                        }] presentFrom:self];
}
- (void)chooseFile {
  UIDocumentPickerViewController *picker =
      [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypeItem ] asCopy:YES];
  picker.delegate = self;
  [self presentViewController:picker animated:YES completion:nil];
}
- (void)addText {
  UIAlertController *form = [UIAlertController
      alertControllerWithTitle:RBL(@"添加文本", @"Add text")
                       message:nil
                preferredStyle:UIAlertControllerStyleAlert];
  [form addTextFieldWithConfigurationHandler:^(UITextField *f) {
    f.placeholder = RBL(@"文件名.txt", @"Filename.txt");
    f.autocorrectionType = UITextAutocorrectionTypeNo;
  }];
  [form addTextFieldWithConfigurationHandler:^(UITextField *f) {
    f.placeholder = RBL(@"内容", @"Content");
  }];
  [form
      addAction:[UIAlertAction actionWithTitle:RBL(@"取消", @"Cancel")
                                         style:UIAlertActionStyleCancel
                                       handler:nil]];
  [form
      addAction:[UIAlertAction
                    actionWithTitle:RBL(@"上传", @"Upload")
                              style:UIAlertActionStyleDefault
                            handler:^(UIAlertAction *action) {
                              NSString *name = form.textFields[0].text;
                              NSString *value = form.textFields[1].text;
                              if (name.length && value.length)
                                [self
                                    upload:[value
                                               dataUsingEncoding:
                                                   NSUTF8StringEncoding]
                                      name:name
                                      mime:@"text/plain"];
                              else
                                self.status.text =
                                    RBL(@"文件名和内容不能为空。", @"Enter a filename and content.");
                            }]];
  [self presentViewController:form animated:YES completion:nil];
}
- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *url = urls.firstObject;
  if (!url)
    return;
  BOOL scoped = [url startAccessingSecurityScopedResource];
  NSError *error = nil;
  NSData *data = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:&error];
  if (scoped)
    [url stopAccessingSecurityScopedResource];
  if (!data) {
    self.status.text = RBL(@"无法读取所选文件。", @"Could not read this file.");
    return;
  }
  [self upload:data
          name:url.lastPathComponent
          mime:[UTType typeWithFilenameExtension:url.pathExtension].preferredMIMEType];
}
@end
void RBShowLibrary(void) {
  if (!RBCurrentAgent.length)
    return;
  UIViewController *top = nil;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow)
          top = w.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  RBLibraryController *vc =
      [[RBLibraryController alloc] initWithStyle:UITableViewStyleInsetGrouped];
  vc.agentId = RBCurrentAgent;
  [top presentViewController:[[UINavigationController alloc] initWithRootViewController:vc]
                    animated:YES
                  completion:nil];
}
