package dev.rokbot.nativeapp;

import java.text.Normalizer;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Composer suggestions are what the USER types next to the Bot (same rule as the Host's
 * host/server/suggestion-voice.mjs, the desktop/web composer-assist.cjs and iOS):
 * <ol>
 *   <li>only messages the user themself sent are learned ({@link #isSelfUserMessage});</li>
 *   <li>anything reading as the assistant offering help ({@link #isAssistantOfferPhrase}, e.g.
 *       「要不要我一起查一下这个问题」, "Would you like me to …") is never shown — learned habits,
 *       local completion candidates and model output alike.</li>
 * </ol>
 * Pure Java (no Android types) so it is unit-tested on a JVM.
 */
final class SuggestionVoice {
    private SuggestionVoice() {}

    /** Lower-case prefixes, matched after trimming leading whitespace / punctuation / quotes. */
    static final List<String> ASSISTANT_OFFER_PREFIXES = Collections.unmodifiableList(Arrays.asList(
            "要不要我", "需不需要我", "需要我", "我可以帮你", "我可以为你", "我来帮你", "我帮你", "让我来",
            "would you like me", "shall i", "do you want me", "let me", "i can help you", "i'll help you", "i will help you"));
    /** "Let me know …" is the user asking the Bot. */
    static final List<String> OFFER_EXCEPTIONS = Collections.unmodifiableList(Collections.singletonList("let me know"));

    private static final Pattern LEADING_NOISE =
            Pattern.compile("^[\\s\"'“”‘’`「」『』（）()【】\\[\\]<>《》.,，。、!！?？:：;；~～…\\-—*_#>]+");
    private static final Set<String> SELF_NAMES = new HashSet<>(Arrays.asList("", "self", "me", "user", "human", "我"));
    private static final Set<String> NON_SELF_SOURCES = new HashSet<>(Arrays.asList(
            "agent", "bot", "assistant", "system", "tool", "automation", "routine", "webhook", "schedule", "scheduler",
            "federation", "notification"));
    private static final Set<String> USER_KINDS = new HashSet<>(Arrays.asList("user", "user-message", "prompt", "user_message"));

    static String voiceKey(String text) {
        if (text == null) return "";
        String s = Normalizer.normalize(text, Normalizer.Form.NFKC).replace('’', '\'').replace('‘', '\'');
        s = LEADING_NOISE.matcher(s).replaceFirst("");
        return s.replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    static boolean isAssistantOfferPhrase(String text) {
        String key = voiceKey(text);
        if (key.isEmpty()) return false;
        for (String ex : OFFER_EXCEPTIONS) if (key.startsWith(ex)) return false;
        for (String prefix : ASSISTANT_OFFER_PREFIXES) {
            if (!key.startsWith(prefix)) continue;
            char last = prefix.charAt(prefix.length() - 1);
            if (last >= 'a' && last <= 'z' && key.length() > prefix.length()) {
                char next = key.charAt(prefix.length());
                if (next >= 'a' && next <= 'z') continue; // "let men" is not "let me"
            }
            return true;
        }
        return false;
    }

    /**
     * A transcript message the user themself sent: role (or, without a role, kind) is user, and
     * no other sender (another Bot, an automation, the system) is attached.
     */
    static boolean isSelfUserMessage(String role, String kind, String senderKind, String source, boolean fromOtherAgent) {
        String r = role != null ? role.trim().toLowerCase(Locale.ROOT) : "";
        String k = kind != null ? kind.trim().toLowerCase(Locale.ROOT) : "";
        if (!r.isEmpty() ? !"user".equals(r) : !USER_KINDS.contains(k)) return false;
        if (fromOtherAgent) return false;
        if (senderKind != null && !SELF_NAMES.contains(senderKind.trim().toLowerCase(Locale.ROOT))) return false;
        return source == null || !NON_SELF_SOURCES.contains(source.trim().toLowerCase(Locale.ROOT));
    }

    /** {@code list} without assistant offers (new list; null stays null). */
    static List<String> userVoiceOnly(List<String> list) {
        if (list == null) return null;
        List<String> out = new java.util.ArrayList<>();
        for (String s : list) if (s != null && !isAssistantOfferPhrase(s)) out.add(s);
        return out;
    }

    /** "" when the continuation turns the draft into an offer; a draft the user typed that way stays theirs. */
    static String voiceSafeCompletion(String draft, String completion) {
        if (completion == null || completion.isEmpty()) return "";
        String typed = draft != null ? draft : "";
        if (isAssistantOfferPhrase(typed)) return completion;
        return isAssistantOfferPhrase(typed + completion) ? "" : completion;
    }
}
