package dev.rokbot.nativeapp;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Local (on-device, no network) completion while typing: matches the draft against the user's
 * quick phrases and the messages they often send to this Bot (completionCandidates from the Host).
 * Ranking mirrors the Host's matchCompletions: prefix, then substring, then characters in order.
 * Pure Java (no Android types) so it is unit-tested on a JVM.
 */
final class SuggestionHabitMatcher {
    static final int MAX_MATCHES = 3;
    static final int MIN_DRAFT_CHARS = 1;

    private SuggestionHabitMatcher() {}

    static String normalize(String text) {
        if (text == null) return "";
        return text.replace('\u200b', ' ').trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    /** At most {@code max} pool entries completing {@code draft}; never the draft itself. */
    static List<String> match(String draft, List<String> pool, int max) {
        String q = normalize(draft);
        if (q.length() < MIN_DRAFT_CHARS || pool == null || pool.isEmpty() || max <= 0) return Collections.emptyList();
        List<String> prefix = new ArrayList<>();
        List<String> substring = new ArrayList<>();
        List<String> fuzzy = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String raw : pool) {
            if (raw == null) continue;
            String text = raw.trim();
            String key = normalize(text);
            if (key.isEmpty() || key.equals(q) || key.length() <= q.length() || !seen.add(key)) continue;
            if (key.startsWith(q)) prefix.add(text);
            else if (key.contains(q)) substring.add(text);
            else if (q.length() >= 2 && inOrder(q, key)) fuzzy.add(text);
        }
        List<String> out = new ArrayList<>(prefix);
        out.addAll(substring);
        out.addAll(fuzzy);
        return out.size() > max ? new ArrayList<>(out.subList(0, max)) : out;
    }

    private static boolean inOrder(String q, String key) {
        int at = 0;
        for (int i = 0; i < q.length(); i++) {
            char c = q.charAt(i);
            if (c == ' ') continue;
            int found = key.indexOf(c, at);
            if (found < 0) return false;
            at = found + 1;
        }
        return true;
    }

    /** Quick phrases first, then the Host's candidates (deduplicated, case-insensitive). */
    static List<String> pool(List<String> phrases, List<String> candidates) {
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (List<String> list : java.util.Arrays.asList(phrases, candidates)) {
            if (list == null) continue;
            for (String s : list) {
                String key = normalize(s);
                if (!key.isEmpty() && seen.add(key)) out.add(s.trim());
            }
        }
        return out;
    }
}
