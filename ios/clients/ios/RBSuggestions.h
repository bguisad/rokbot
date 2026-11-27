#import <Foundation/Foundation.h>

@class UIViewController;

NS_ASSUME_NONNULL_BEGIN

// ---- Pure Foundation helpers (unit-tested on macOS) ----

// Normalized Host settings: {enabled: BOOL, aiEnabled: BOOL, quickPhrases: [{id, text}]}.
// Missing keys keep the defaults (enabled / aiEnabled true, no phrases).
FOUNDATION_EXPORT NSDictionary *RBSuggestionsParseSettings(id _Nullable response);
// AI suggestions from POST /local/suggestions; only accepted when source == "model" (max 4).
FOUNDATION_EXPORT NSArray<NSString *> *RBSuggestionsAIFromResponse(id _Nullable response);
// Quick phrases first, then AI suggestions; trimmed, case-insensitive de-duplicated.
// Items are {type: "phrase" | "ai", text}.
FOUNDATION_EXPORT NSArray<NSDictionary *> *RBSuggestionsMergeItems(NSArray *_Nullable phrases,
                                                                   NSArray *_Nullable ai);
// Rejects inputs that are clearly not the chat composer (search / name fields).
FOUNDATION_EXPORT BOOL RBSuggestionsPlaceholderAllowed(NSString *_Nullable placeholder);
// Body for POST /api/sendPrompt when a suggestion is tapped (click-to-send).
FOUNDATION_EXPORT NSDictionary *RBSuggestionsSendBody(NSString *agentId, NSString *text, NSString *_Nullable nonce);
// Agent ID observed from an RN gateway request (openAgentWindowed, getAgentTranscriptTail, sendPrompt...).
// Sets *turnOut when the request starts a new turn (sendPrompt / openAgentWindowed).
FOUNDATION_EXPORT NSString *_Nullable RBSuggestionsAgentFromRequest(NSString *_Nullable path,
                                                                    NSData *_Nullable body,
                                                                    BOOL *_Nullable turnOut);
// Validates a quick phrase before it is sent to the Host (1-120 characters, no duplicates).
FOUNDATION_EXPORT NSString *_Nullable RBSuggestionsValidatePhrase(NSString *_Nullable text,
                                                                  NSArray<NSDictionary *> *_Nullable existing,
                                                                  NSString *_Nullable editingId,
                                                                  BOOL chinese);
// Order of IDs after moving one phrase up (-1) or down (+1); nil when the move is impossible.
FOUNDATION_EXPORT NSArray<NSString *> *_Nullable RBSuggestionsMovedIds(NSArray<NSDictionary *> *phrases,
                                                                        NSUInteger index,
                                                                        NSInteger delta);

// ---- iOS runtime ----
FOUNDATION_EXPORT void RBInstallSuggestions(void);
FOUNDATION_EXPORT void RBSuggestionsNoteRequest(NSString *_Nullable path, NSData *_Nullable body);
FOUNDATION_EXPORT NSString *_Nullable RBSuggestionsCurrentAgent(void);
FOUNDATION_EXPORT void RBSuggestionsInvalidate(void);
FOUNDATION_EXPORT void RBShowSuggestionsSettingsFrom(UIViewController *_Nullable presenter);

NS_ASSUME_NONNULL_END
