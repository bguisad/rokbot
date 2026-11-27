// Composer suggestions are what the USER types next to the Bot. Two shared rules keep the Bot's
// voice out of them (mirrored by the desktop composer, the web client, Android
// SuggestionVoice.java and iOS — see docs in ~/workspace/agy-tasks/suggest-voice-rule.md):
//
//   1. Learn only from messages the user themself sent (isSelfUserEntry): role/kind "user" and no
//      sign of another sender (another Bot in a group / agent messaging, an automation, a system
//      or tool injection).
//   2. Drop every candidate that reads as the assistant offering help (isAssistantOfferPhrase):
//      「要不要我一起查一下这个问题」, "Would you like me to …" — applied to learned habits, local
//      completion candidates and model output.

/** Lower-case prefixes; matched after trimming leading whitespace/punctuation/quotes. */
export const ASSISTANT_OFFER_PREFIXES = Object.freeze([
  '要不要我', '需不需要我', '需要我', '我可以帮你', '我可以为你', '我来帮你', '我帮你', '让我来',
  'would you like me', 'shall i', 'do you want me', 'let me', 'i can help you', "i'll help you", 'i will help you',
]);

/** "Let me know …" is the user asking the Bot, not the Bot offering. */
const OFFER_EXCEPTIONS = Object.freeze(['let me know']);

const LEADING_NOISE = /^[\s"'“”‘’`「」『』（）()【】\[\]<>《》.,，。、!！?？:：;；~～…\-—*_#>]+/u;

export function voiceKey(text) {
  return String(text ?? '').normalize('NFKC').replace(/[’‘]/g, "'").replace(LEADING_NOISE, '').replace(/\s+/g, ' ').toLowerCase();
}

/** True when `text` is phrased as the assistant offering to do something for the user. */
export function isAssistantOfferPhrase(text) {
  const key = voiceKey(text);
  if (!key) return false;
  if (OFFER_EXCEPTIONS.some(prefix => key.startsWith(prefix))) return false;
  return ASSISTANT_OFFER_PREFIXES.some(prefix => key.startsWith(prefix)
    // Latin prefixes must end at a word boundary ("let men" is not "let me").
    && (!/[a-z]$/.test(prefix) || !/^[a-z]/.test(key.slice(prefix.length))));
}

const USER_KINDS = new Set(['user', 'user-message', 'prompt', 'user_message']);
const NON_SELF_SOURCES = new Set(['agent', 'bot', 'assistant', 'system', 'tool', 'automation', 'routine', 'webhook', 'schedule', 'scheduler', 'federation', 'notification']);

const SELF_NAMES = new Set(['self', 'me', 'user', 'human', '我']);

function senderIsSomeoneElse(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'string') return !SELF_NAMES.has(value.toLowerCase());
  if (typeof value === 'object') {
    const kind = String(value.kind ?? value.type ?? value.role ?? '').toLowerCase();
    if (kind) return !SELF_NAMES.has(kind);
    return Boolean(value.id || value.agentId || value.name);
  }
  return Boolean(value);
}

/**
 * A transcript entry the user themself sent. Assistant / bot / system / tool entries never count,
 * nor a "user" turn that another Bot (group chat, agent messaging, federation), an automation or
 * the system injected on the user's behalf.
 */
export function isSelfUserEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const role = typeof entry.role === 'string' ? entry.role.toLowerCase() : '';
  const kind = String(entry.kind ?? entry.type ?? '').toLowerCase();
  if (role) {
    if (role !== 'user') return false;
  } else if (!USER_KINDS.has(kind)) {
    return false;
  }
  if (entry.fromAgent || entry.fromAgentId || entry.senderAgentId || entry.agentSender) return false;
  if (senderIsSomeoneElse(entry.sender) || senderIsSomeoneElse(entry.author) || senderIsSomeoneElse(entry.from)) return false;
  const source = String(entry.source ?? entry.origin ?? '').toLowerCase();
  if (source && NON_SELF_SOURCES.has(source)) return false;
  if (entry.synthetic === true || entry.isSystem === true || entry.automated === true) return false;
  return true;
}
