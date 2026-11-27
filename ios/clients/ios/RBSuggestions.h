#import <Foundation/Foundation.h>

@class UIViewController;

NS_ASSUME_NONNULL_BEGIN

// ---- Pure Foundation helpers (unit-tested on macOS) ----

// Normalized Host settings: {enabled: BOOL, aiEnabled: BOOL, quickPhrases: [{id, text}]}.
// Missing keys keep the defaults (enabled / aiEnabled true, no phrases).
FOUNDATION_EXPORT NSDictionary *RBSuggestionsParseSettings(id _Nullable response);
// AI suggestions from POST /local/suggestions; only accepted when source == "model" (max 3).
FOUNDATION_EXPORT NSArray<NSString *> *RBSuggestionsAIFromResponse(id _Nullable response);
// Quick phrases first, then AI suggestions; trimmed, case-insensitive de-duplicated.
// Items are {type: "phrase" | "ai", text}.
FOUNDATION_EXPORT NSArray<NSDictionary *> *RBSuggestionsMergeItems(NSArray *_Nullable phrases,
                                                                   NSArray *_Nullable ai);
// Rejects inputs that are clearly not the chat composer (search / name fields).
FOUNDATION_EXPORT BOOL RBSuggestionsPlaceholderAllowed(NSString *_Nullable placeholder);
// Body for POST /api/sendPrompt when a suggestion is tapped (click-to-send).
FOUNDATION_EXPORT NSDictionary *RBSuggestionsSendBody(NSString *agentId, NSString *text, NSString *_Nullable nonce);
// How an observed RN gateway request relates to the bot currently on screen.
typedef NS_ENUM(NSInteger, RBSuggestionsSignal) {
  RBSuggestionsSignalNone = 0,
  // Read-only refresh (getAgent, transcript fetches, markAgentRead, getForeverBoxStatus).
  // RN issues these for background bots too, so they never change the current bot.
  RBSuggestionsSignalWeak = 1,
  // Navigation into a chat (openAgentWindowed, markAgentViewed, deep link / notification open).
  RBSuggestionsSignalActivate = 2,
  // The user sent a prompt (sendPrompt): activates the bot and starts a new turn.
  RBSuggestionsSignalTurn = 3,
};
// Agent ID observed from an RN gateway request; *signalOut tells strong (Activate/Turn) from Weak.
FOUNDATION_EXPORT NSString *_Nullable RBSuggestionsAgentFromRequest(NSString *_Nullable path,
                                                                    NSData *_Nullable body,
                                                                    RBSuggestionsSignal *_Nullable signalOut);
// Current bot after observing `observed` with `signal`: only Activate / Turn may switch it.
FOUNDATION_EXPORT NSString *_Nullable RBSuggestionsResolveAgent(NSString *_Nullable current,
                                                                NSString *_Nullable observed,
                                                                RBSuggestionsSignal signal);
// Client cache key: per-bot generation + locale ("agent:generation:locale").
FOUNDATION_EXPORT NSString *RBSuggestionsCacheKey(NSString *_Nullable agentId, NSUInteger generation,
                                                  NSString *_Nullable locale);
// Late-response guard for POST /local/suggestions. Accepts only when the response belongs to the
// latest request (requestSeq == latestSeq), the request was made for the bot that is still current,
// and any echoed agentId / requestId matches the request (older Hosts without echoes are accepted).
FOUNDATION_EXPORT BOOL RBSuggestionsAcceptResponse(id _Nullable response,
                                                   NSString *_Nullable requestAgent,
                                                   NSString *_Nullable requestId,
                                                   NSString *_Nullable currentAgent,
                                                   NSUInteger requestSeq,
                                                   NSUInteger latestSeq);
// Body for POST /local/suggestions (requestId clipped to 64 characters; prefetch only when YES).
FOUNDATION_EXPORT NSDictionary *RBSuggestionsRequestBody(NSString *agentId, NSString *_Nullable locale,
                                                         NSString *_Nullable requestId, BOOL prefetch);
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
// Strong navigation signal from native code (notification tap, deep link, App Intent).
FOUNDATION_EXPORT void RBSuggestionsNoteOpenedAgent(NSString *_Nullable agentId);
// A new reply arrived for `agentId` (foreground task-completion receipt).
FOUNDATION_EXPORT void RBSuggestionsNoteReply(NSString *_Nullable agentId);
FOUNDATION_EXPORT void RBSuggestionsInvalidate(void);
FOUNDATION_EXPORT void RBShowSuggestionsSettingsFrom(UIViewController *_Nullable presenter);

NS_ASSUME_NONNULL_END
