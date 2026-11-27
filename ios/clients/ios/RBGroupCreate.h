#import <Foundation/Foundation.h>

@class UIViewController, UIView;

NS_ASSUME_NONNULL_BEGIN

// ---- Pure Foundation model (unit-tested on macOS), mirrors Desktop 1.3.0 NewChatBar rules ----
FOUNDATION_EXPORT const NSUInteger RBGroupMaxBots;        // 6
FOUNDATION_EXPORT const NSUInteger RBGroupMaxNameLength;  // 72

// Bot candidate / recipient dictionaries:
//   candidate: {id, name, subtitle, avatarDataUrl}
//   recipient: {isNewBot: BOOL, id, name, avatarDataUrl}
FOUNDATION_EXPORT NSString *RBGroupNormalizeName(NSString *_Nullable raw);
FOUNDATION_EXPORT NSString *RBGroupNormalizeForMatch(NSString *_Nullable raw);
FOUNDATION_EXPORT NSArray<NSDictionary *> *RBGroupEligibleBots(id _Nullable listAgentsResponse);
FOUNDATION_EXPORT NSDictionary *RBGroupRecipientFromBot(NSDictionary *bot);
FOUNDATION_EXPORT NSDictionary *RBGroupRecipientNewBot(NSString *rawName);
FOUNDATION_EXPORT BOOL RBGroupCanAddRecipient(NSArray<NSDictionary *> *selected, NSDictionary *candidate);
FOUNDATION_EXPORT NSArray<NSDictionary *> *RBGroupFilterCandidates(NSArray<NSDictionary *> *eligible,
                                                                   NSArray<NSDictionary *> *selected,
                                                                   NSString *_Nullable query);
FOUNDATION_EXPORT BOOL RBGroupCanOfferNewBot(NSArray<NSDictionary *> *eligible,
                                             NSArray<NSDictionary *> *selected,
                                             NSString *_Nullable query);
FOUNDATION_EXPORT NSString *RBGroupFormatList(NSArray<NSString *> *items, BOOL chinese, BOOL narrow);
FOUNDATION_EXPORT NSString *RBGroupComposerNames(NSArray<NSDictionary *> *recipients, BOOL chinese);
FOUNDATION_EXPORT NSString *RBGroupAutoName(NSArray<NSDictionary *> *recipients,
                                            NSString *_Nullable accountName,
                                            BOOL chinese);
FOUNDATION_EXPORT BOOL RBGroupCanSubmit(NSArray<NSDictionary *> *recipients, BOOL submitting);
// ID returned by /api/createAgent or /api/createGroup ({agent: {id}} or {id}).
FOUNDATION_EXPORT NSString *RBGroupCreatedId(id _Nullable response);
// Body for /api/createGroup, identical to Desktop: {name, description: "", memberAgentIds}.
FOUNDATION_EXPORT NSDictionary *RBGroupCreateBody(NSString *name, NSArray<NSString *> *memberIds);
// Labels of the React Native "+" new-chat control that opens the RokBot chooser.
FOUNDATION_EXPORT BOOL RBGroupIsNewChatLabel(NSString *_Nullable label);

// ---- iOS runtime ----
FOUNDATION_EXPORT void RBShowCreateGroupFrom(UIViewController *_Nullable presenter);
// Shows the RokBot "New Bot / New Group" bottom chooser. newBot runs when "New Bot" is chosen.
FOUNDATION_EXPORT void RBShowNewChatChooser(UIViewController *_Nullable presenter, void (^newBot)(void));
// Installs a transparent chooser overlay on the RN "+" control; returns YES when the view was handled.
FOUNDATION_EXPORT BOOL RBReplaceNewChatView(UIView *view, NSString *label);

NS_ASSUME_NONNULL_END
