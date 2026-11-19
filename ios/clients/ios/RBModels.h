#import <Foundation/Foundation.h>

@class UIViewController;

FOUNDATION_EXPORT void RBShowModels(void);
FOUNDATION_EXPORT void RBShowModelsFrom(UIViewController *presenter);
FOUNDATION_EXPORT void RBCheckModelOnboardingIfNeeded(void);
FOUNDATION_EXPORT void RBClearModelOnboardingState(void);

// Pure Foundation helpers (unit-testable on macOS host and iOS)
FOUNDATION_EXPORT NSDictionary *RBModelsExtractRoutingConfig(NSDictionary *response);
FOUNDATION_EXPORT NSDictionary *RBModelsExtractReloadState(NSDictionary *response);
FOUNDATION_EXPORT BOOL RBModelsParseNeedsModel(NSDictionary *statusResponse, BOOL *canConfigureOut);
FOUNDATION_EXPORT NSString *RBModelsDefaultBaseURLForFormat(NSString *apiFormat);
FOUNDATION_EXPORT NSString *RBModelsNormalizeIdCandidate(NSString *raw, NSString *fallbackPrefix);
FOUNDATION_EXPORT NSDictionary *RBModelsBuildSavePayload(
    NSArray<NSDictionary *> *providers,
    NSArray<NSDictionary *> *profiles,
    NSDictionary *defaultRoute,
    NSDictionary *botRoutes,
    NSDictionary *pendingApiKeys,
    BOOL migrateLegacyRouting,
    NSString **errorMessage);
