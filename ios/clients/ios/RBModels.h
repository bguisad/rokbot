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

// Scenario model routes (suggestions, summarization, memoryExtraction, autoReview, subagent, automation).
FOUNDATION_EXPORT NSArray<NSString *> *RBModelsScenarioKeys(void);
// Keeps known scenarios whose profile exists; unknown efforts fall back to "default".
FOUNDATION_EXPORT NSDictionary *RBModelsCleanScenarioRoutes(NSDictionary *routes, NSArray<NSDictionary *> *profiles);
// Adds scenarioRoutes (always) and an existing adaptiveRouting block to a save payload.
FOUNDATION_EXPORT NSDictionary *RBModelsAttachRoutingExtras(NSDictionary *payload,
                                                           NSDictionary *scenarioRoutes,
                                                           NSDictionary *adaptiveRouting,
                                                           NSArray<NSDictionary *> *profiles);
// "Follow default" or "Profile · model (effort)" for scenario / Bot route rows.
FOUNDATION_EXPORT NSString *RBModelsRouteSummary(NSDictionary *route, NSArray<NSDictionary *> *profiles, BOOL chinese);
