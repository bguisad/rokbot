#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

// One option row of the RokBot bottom choice sheet.
@interface RBChoiceOption : NSObject
@property(nonatomic, copy) NSString *value;
@property(nonatomic, copy) NSString *title;
@property(nonatomic, copy, nullable) NSString *subtitle;
@property(nonatomic, assign) BOOL destructive;
+ (instancetype)optionWithValue:(NSString *)value title:(NSString *)title subtitle:(nullable NSString *)subtitle;
@end

// RokBot-styled bottom selection sheet that replaces UIAlertController action
// sheets and system pickers: 24pt top corners, grabber, title, options inside an
// 18pt rounded card with hairline separators, bold selected row with a vector
// check, scrim tap / swipe-down to dismiss, max 62% of the screen, auto scrolls
// to the selected row. Adapts to light / dark and Dynamic Type.
@interface RBChoiceSheet : UIViewController
@property(nonatomic, copy, readonly) NSArray<RBChoiceOption *> *options;
@property(nonatomic, copy, readonly) NSSet<NSString *> *selectedValues;
@property(nonatomic, assign, readonly) BOOL multiple;

+ (instancetype)sheetWithTitle:(NSString *)title
                       message:(nullable NSString *)message
                       options:(NSArray<RBChoiceOption *> *)options
                      selected:(nullable NSString *)selected
                      onSelect:(void (^)(RBChoiceOption *option))onSelect;
// Multi-select variant (e.g. fallback profiles); onDone receives values in option order.
+ (instancetype)multiSheetWithTitle:(NSString *)title
                            message:(nullable NSString *)message
                            options:(NSArray<RBChoiceOption *> *)options
                           selected:(NSArray<NSString *> *)selected
                             onDone:(void (^)(NSArray<NSString *> *values))onDone;
- (void)presentFrom:(UIViewController *)presenter;
@end

// Pure helper (unit-tested): index of the first option whose value matches, or NSNotFound.
FOUNDATION_EXPORT NSUInteger RBChoiceSelectedIndex(NSArray<RBChoiceOption *> *options, NSString *_Nullable value);
// Pure helper (unit-tested): toggles a value in an ordered selection while preserving option order.
FOUNDATION_EXPORT NSArray<NSString *> *RBChoiceToggle(NSArray<RBChoiceOption *> *options,
                                                      NSArray<NSString *> *selected,
                                                      NSString *value,
                                                      NSUInteger limit);

NS_ASSUME_NONNULL_END
