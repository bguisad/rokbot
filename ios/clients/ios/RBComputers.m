#import "RBLocalize.h"
#import "RBComputers.h"
#import "RBConnection.h"
#import "RBHTTP.h"

@interface RBComputersController : UITableViewController
@property(nonatomic, copy) NSArray<NSDictionary *> *computers;
@property(nonatomic, copy) NSString *state;
@end
@implementation RBComputersController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = RBL(@"Bot 电脑", @"Bot Computer");
  self.computers = @[];
  self.state = RBL(@"正在读取…", @"Loading…");
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.refreshControl = [UIRefreshControl new];
  [self.refreshControl addTarget:self
                          action:@selector(reload)
                forControlEvents:UIControlEventValueChanged];
  [self reload];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)reload {
  NSMutableURLRequest *request = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[RBConnection.shared.serverURL
                                              stringByAppendingString:@"/local/computers"]]];
  request.timeoutInterval = 20;
  [request setValue:[@"Bearer " stringByAppendingString:RBConnection.shared.deviceToken ?: @""]
      forHTTPHeaderField:@"Authorization"];
  [[RBHTTPSession()
      dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          dispatch_async(dispatch_get_main_queue(), ^{
            [self.refreshControl endRefreshing];
            if (error || ((NSHTTPURLResponse *)response).statusCode != 200 ||
                ![value isKindOfClass:NSDictionary.class] ||
                ![value[@"computers"] isKindOfClass:NSArray.class]) {
              self.state = RBL(@"加载失败，下拉重试。", @"Could not load. Pull to retry.");
                self.computers = @[];
            } else {
              self.computers = value[@"computers"];
              self.state = [value[@"available"] boolValue] ? RBL(@"尚无已连接的电脑", @"No connected computers") : RBL(@"Host 尚未就绪", @"Host is unavailable");
            }
            [self.tableView reloadData];
          });
        }] resume];
}
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView {
  return 2;
}
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return section == 0 ? MAX(1, self.computers.count) : 1;
}
- (NSString *)tableView:(UITableView *)tableView titleForHeaderInSection:(NSInteger)section {
  return section == 0 ? RBL(@"你的电脑", @"Your computers") : RBL(@"Bot 的远程电脑", @"Remote computer");
}
- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
  return nil;
}
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)path {
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle
                                                 reuseIdentifier:nil];
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  cell.imageView.image =
      [UIImage systemImageNamed:path.section == 0 ? @"laptopcomputer" : @"desktopcomputer"];
  if (path.section == 1) {
    cell.textLabel.text = RBL(@"Linux 桌面", @"Linux desktop");
    cell.detailTextLabel.text = RBL(@"由 Host 管理", @"Managed by Host");
    return cell;
  }
  if (!self.computers.count) {
    cell.textLabel.text = self.state;
    return cell;
  }
  NSDictionary *computer = self.computers[path.row];
  cell.textLabel.text = computer[@"label"] ?: RBL(@"电脑", @"Computer");
  cell.detailTextLabel.text =
      [NSString stringWithFormat:RBL(@"%@ · 命令与文件", @"%@ · Commands and files"),
                                 [computer[@"connected"] boolValue] ? RBL(@"已连接", @"Connected") : RBL(@"已断开", @"Disconnected")];
  return cell;
}
@end
void RBShowComputers(void) {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow)
          top = window.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  [top presentViewController:
           [[UINavigationController alloc]
               initWithRootViewController:[[RBComputersController alloc]
                                              initWithStyle:UITableViewStyleInsetGrouped]]
                    animated:YES
                  completion:nil];
}
