#import <Foundation/Foundation.h>

@class UIViewController;

/*
 * iOS Code-Signing & Sandbox Update Constraints:
 * 1. Sandboxed iOS apps cannot overwrite their own signed .app bundle or silently
 *    apply binary/dylib delta patches in place (Expo OTA is also disabled in patch-app.py).
 * 2. In-place upgrades require a matching CFBundleIdentifier (dev.rokbot.local) and valid
 *    code signing (Ad-Hoc/Enterprise/Developer profile, AltStore/SideStore re-signing, or TrollStore).
 * 3. itms-services:// is executed by iOS system daemons (itunesstored) outside RokBot's
 *    process sandbox: it requires a trusted HTTPS manifest.plist URL and CANNOT reach
 *    Tailcat 127.0.0.1 loopback URLs or attach custom Authorization headers.
 * 4. Authenticated .ipa download + UIActivityViewController works over both direct HTTPS
 *    and Tailcat, verifying byte size and chunked CC_SHA256 on disk before handing off to
 *    TrollStore / Sideloadly / Files / AirDrop.
 */

FOUNDATION_EXPORT void RBShowUpdater(void);
FOUNDATION_EXPORT void RBShowUpdaterFrom(UIViewController *presenter);
FOUNDATION_EXPORT void RBCheckUpdatesInBackgroundIfNeeded(void);

// Pure Foundation helpers (unit-testable on macOS host and iOS)
FOUNDATION_EXPORT NSString *RBUpdaterPercentEncodeQueryValue(NSString *value);
FOUNDATION_EXPORT NSURL *RBUpdaterResolveURL(NSString *rawUrl, NSString *baseServerURL);
FOUNDATION_EXPORT NSURL *RBUpdaterBuildItmsServicesURL(NSString *rawUrl, NSString *baseServerURL);
FOUNDATION_EXPORT NSURL *RBUpdaterBuildSourceSchemeURL(NSString *scheme,
                                                       NSString *rawUrl,
                                                       NSString *baseServerURL);
FOUNDATION_EXPORT NSComparisonResult RBUpdaterCompareVersionAndBuild(NSString *remoteVersion,
                                                                     NSString *remoteBuild,
                                                                     NSString *localVersion,
                                                                     NSString *localBuild);
FOUNDATION_EXPORT NSDictionary *RBUpdaterParseManifest(NSDictionary *json,
                                                       NSString *currentBundleId,
                                                       NSString **errorMessage);
FOUNDATION_EXPORT BOOL RBUpdaterIsItmsURLReachableOutsideSandbox(NSURL *manifestPlistURL,
                                                                 NSString **warningReason);
FOUNDATION_EXPORT BOOL RBUpdaterShouldAttachBearerAuth(NSURL *targetURL, NSString *baseServerURL);
FOUNDATION_EXPORT NSString *RBUpdaterFileSHA256(NSURL *fileURL, NSError **error);
FOUNDATION_EXPORT BOOL RBUpdaterVerifyFileSHA256(NSURL *fileURL,
                                                  NSString *expectedHex,
                                                  uint64_t expectedSize,
                                                  NSError **error);
