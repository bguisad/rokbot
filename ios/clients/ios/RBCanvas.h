#import <Foundation/Foundation.h>

@class UIViewController;

NS_ASSUME_NONNULL_BEGIN

// ---- Pure Foundation helpers (unit-tested on macOS) ----

// The canvas id of an in-app canvas link (/canvas/app/<uuid>) on any Host address, or nil.
FOUNDATION_EXPORT NSString *_Nullable RBCanvasAppLinkId(NSURL *_Nullable url);
// Validates a Host public canvas link (/canvas/<43-char-token>).
FOUNDATION_EXPORT BOOL RBCanvasIsPublicLink(NSString *_Nullable value);
// Update time in Beijing time: 今天 14:05, 11月26日 09:30, 2025年3月2日.
FOUNDATION_EXPORT NSString *RBCanvasShortTime(double ms, double nowMs, BOOL chinese);

// ---- iOS runtime ----

// Opens an in-app canvas link inside the app; NO when `url` is not one.
FOUNDATION_EXPORT BOOL RBOpenCanvasURL(NSURL *_Nullable url);
// Presents the canvas stage over the top view controller.
FOUNDATION_EXPORT void RBPresentCanvas(NSString *canvasId, NSString *_Nullable title);
// Presents the share sheet of `canvas` (a /local/canvases item) from `presenter`.
FOUNDATION_EXPORT void RBPresentCanvasShare(UIViewController *presenter, NSDictionary *canvas,
                                            void (^_Nullable changed)(NSDictionary *canvas));

NS_ASSUME_NONNULL_END
