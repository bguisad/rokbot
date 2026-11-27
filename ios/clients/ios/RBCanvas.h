#import <UIKit/UIKit.h>
NS_ASSUME_NONNULL_BEGIN
// RokBot canvases (/canvas/app/<id> links, the Host's /local/canvases API).
// The canvas id of an in-app canvas link on any Host address, or nil.
NSString *_Nullable RBCanvasAppLinkId(NSURL *_Nullable url);
// Opens an in-app canvas link inside the app; NO when `url` is not one.
BOOL RBOpenCanvasURL(NSURL *_Nullable url);
// Presents the canvas stage over the top view controller.
void RBPresentCanvas(NSString *canvasId, NSString *_Nullable title);
// Presents the share sheet of `canvas` (a /local/canvases item) from `presenter`.
void RBPresentCanvasShare(UIViewController *presenter, NSDictionary *canvas,
                          void (^_Nullable changed)(NSDictionary *canvas));
// Update time in Beijing time: 今天 14:05, 11月26日 09:30, 2025年3月2日.
NSString *RBCanvasShortTime(double ms, double nowMs, BOOL chinese);
NS_ASSUME_NONNULL_END
