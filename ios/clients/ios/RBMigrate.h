#import <Foundation/Foundation.h>

@class UIViewController;

NS_ASSUME_NONNULL_BEGIN

// ---- Pure Foundation helpers (unit-tested on macOS) ----

// One-line summary of a package's counts ("3 个 Bot · 6 条记忆 ..."); chinese selects the language.
FOUNDATION_EXPORT NSString *RBMigrateCountsLine(NSDictionary *_Nullable counts, BOOL chinese);
// Body for POST /local/migrate/packages/<id>/import from the reviewed Bot keys.
// excluded: keys the user unticked; policies: key -> "rename" | "skip" | "overwrite" (default rename).
FOUNDATION_EXPORT NSDictionary *RBMigrateSelection(NSArray<NSDictionary *> *bots,
                                                   NSSet<NSString *> *excluded,
                                                   NSDictionary<NSString *, NSString *> *policies,
                                                   BOOL includeChat);

// ---- iOS runtime ----
// "Migrate from Grok Bot": copy the migration prompt, manage upload URLs, review and import packages.
FOUNDATION_EXPORT void RBShowMigrateFrom(UIViewController *_Nullable presenter);

NS_ASSUME_NONNULL_END
