package dev.rokbot.nativeapp;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Pure JVM-testable business logic for the Create Group Chat flow, matching RokBot Desktop 1.3.0
 * (NewChatBar / HRn / WRn / zRn / tzn):
 * - Maximum 6 Bot members per group chat.
 * - Excludes existing groups, sidebar-hidden Bots, and already-selected Bots from candidates.
 * - Fuzzy token search across name, title, and description with relevance ordering.
 * - Inline "Add '<name>' as a new Bot" creation when query doesn't exact-match an existing/selected Bot.
 * - Auto-generated group name matching Desktop HRn (locale list formatting, collapsed whitespace, max 72 chars).
 */
public final class GroupCreateModel {
    public static final int MAX_GROUP_BOTS = 6;
    public static final int MAX_GROUP_NAME_LENGTH = 72;

    private GroupCreateModel() {}

    public static final class BotCandidate {
        public final String id;
        public final String name;
        public final String title;
        public final String description;
        public final String avatarShape;
        public final String avatarColor;
        public final String avatarDataUrl;
        public final boolean isGroup;
        public final boolean isHiddenFromSidebar;

        public BotCandidate(String id, String name, String title, String description,
                            String avatarShape, String avatarColor, String avatarDataUrl,
                            boolean isGroup, boolean isHiddenFromSidebar) {
            this.id = safe(id);
            String cleanName = safe(name);
            this.name = cleanName.isEmpty() ? this.id : cleanName;
            this.title = safe(title);
            this.description = safe(description);
            this.avatarShape = safe(avatarShape);
            this.avatarColor = safe(avatarColor);
            this.avatarDataUrl = safe(avatarDataUrl);
            this.isGroup = isGroup;
            this.isHiddenFromSidebar = isHiddenFromSidebar;
        }

        public String displaySubtitle() {
            return !title.isEmpty() ? title : description;
        }
    }

    public static final class Recipient {
        public final boolean isNewBot;
        public final String id;
        public final String name;
        public final String avatarShape;
        public final String avatarColor;
        public final String avatarDataUrl;

        private Recipient(boolean isNewBot, String id, String name,
                          String avatarShape, String avatarColor, String avatarDataUrl) {
            this.isNewBot = isNewBot;
            this.id = safe(id);
            this.name = safe(name);
            this.avatarShape = safe(avatarShape);
            this.avatarColor = safe(avatarColor);
            this.avatarDataUrl = safe(avatarDataUrl);
        }

        public static Recipient fromBot(BotCandidate bot) {
            return new Recipient(false, bot.id, bot.name,
                    bot.avatarShape, bot.avatarColor, bot.avatarDataUrl);
        }

        public static Recipient newBot(String rawName) {
            String trimmed = normalizeGroupName(rawName);
            return new Recipient(true, "", trimmed, "", "", "");
        }

        public String key() {
            return isNewBot ? ("new:" + normalizeForMatch(name)) : ("agent:" + id);
        }
    }

    private static String safe(String s) {
        return s == null ? "" : s.trim();
    }

    /** Desktop ZQ(e): trim, collapse whitespace runs to single space, truncate to 72 chars. */
    public static String normalizeGroupName(String raw) {
        if (raw == null) return "";
        String collapsed = raw.trim().replaceAll("\\s+", " ");
        if (collapsed.length() <= MAX_GROUP_NAME_LENGTH) {
            return collapsed;
        }
        return collapsed.substring(0, MAX_GROUP_NAME_LENGTH).trim();
    }

    /** Desktop KQ(e): NFKD-strip combining marks, keep letters/digits separated by single spaces, lowercase. */
    public static String normalizeForMatch(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String norm = Normalizer.normalize(raw, Normalizer.Form.NFKD);
        StringBuilder sb = new StringBuilder(norm.length());
        boolean pendingSpace = false;
        for (int i = 0; i < norm.length(); ) {
            int cp = norm.codePointAt(i);
            i += Character.charCount(cp);
            int type = Character.getType(cp);
            if (type == Character.NON_SPACING_MARK
                    || type == Character.COMBINING_SPACING_MARK
                    || type == Character.ENCLOSING_MARK) {
                continue;
            }
            if (Character.isLetterOrDigit(cp)) {
                if (pendingSpace && sb.length() > 0) {
                    sb.append(' ');
                }
                pendingSpace = false;
                sb.appendCodePoint(Character.toLowerCase(cp));
            } else {
                pendingSpace = true;
            }
        }
        return sb.toString();
    }

    /** Filters raw roster entries down to Bots eligible to join a group chat. */
    public static List<BotCandidate> filterEligibleBots(List<BotCandidate> all) {
        List<BotCandidate> out = new ArrayList<>();
        if (all == null) return out;
        Set<String> seen = new LinkedHashSet<>();
        for (BotCandidate bot : all) {
            if (bot == null) continue;
            if (bot.isGroup || bot.isHiddenFromSidebar) continue;
            if (bot.id.isEmpty() || !seen.add(bot.id)) continue;
            out.add(bot);
        }
        return out;
    }

    public static boolean isAtBotLimit(List<Recipient> selected) {
        return selected != null && selected.size() >= MAX_GROUP_BOTS;
    }

    public static boolean isDuplicateRecipient(List<Recipient> selected, Recipient candidate) {
        if (selected == null || candidate == null) return false;
        String candNorm = normalizeForMatch(candidate.name);
        for (Recipient r : selected) {
            if (r == null) continue;
            if (!candidate.isNewBot && !r.isNewBot) {
                if (r.id.equals(candidate.id)) return true;
            } else if (candidate.isNewBot && r.isNewBot) {
                if (!candNorm.isEmpty() && candNorm.equals(normalizeForMatch(r.name))) return true;
            } else {
                // Prevent creating a new bot with the exact same name as an already-selected existing bot
                if (!candNorm.isEmpty() && candNorm.equals(normalizeForMatch(r.name))) return true;
            }
        }
        return false;
    }

    public static boolean canAddRecipient(List<Recipient> selected, Recipient candidate) {
        if (candidate == null) return false;
        if (candidate.isNewBot && candidate.name.isEmpty()) return false;
        if (!candidate.isNewBot && candidate.id.isEmpty()) return false;
        if (isAtBotLimit(selected)) return false;
        return !isDuplicateRecipient(selected, candidate);
    }

    /**
     * Desktop WRn + XQ: excludes already-selected Bots, applies multi-token search across
     * name/title/description, and ranks stronger name matches first.
     */
    public static List<BotCandidate> filterCandidates(List<BotCandidate> eligible,
                                                      List<Recipient> selected,
                                                      String rawQuery) {
        Set<String> selectedIds = new LinkedHashSet<>();
        if (selected != null) {
            for (Recipient r : selected) {
                if (r != null && !r.isNewBot && !r.id.isEmpty()) {
                    selectedIds.add(r.id);
                }
            }
        }

        List<BotCandidate> remaining = new ArrayList<>();
        if (eligible != null) {
            for (BotCandidate b : eligible) {
                if (b == null || b.isGroup || b.isHiddenFromSidebar) continue;
                if (selectedIds.contains(b.id)) continue;
                remaining.add(b);
            }
        }

        String normQuery = normalizeForMatch(rawQuery);
        if (normQuery.isEmpty()) {
            return remaining;
        }
        String[] tokens = normQuery.split(" ");

        final List<ScoredBot> scored = new ArrayList<>();
        for (int idx = 0; idx < remaining.size(); idx++) {
            BotCandidate bot = remaining.get(idx);
            String normName = normalizeForMatch(bot.name);
            String normSub = normalizeForMatch(bot.displaySubtitle());
            int score = scoreCandidate(normName, normSub, normQuery, tokens);
            if (score >= 0) {
                scored.add(new ScoredBot(bot, score, idx));
            }
        }

        Collections.sort(scored, new Comparator<ScoredBot>() {
            @Override
            public int compare(ScoredBot a, ScoredBot b) {
                int cmp = Integer.compare(b.score, a.score);
                return cmp != 0 ? cmp : Integer.compare(a.originalIndex, b.originalIndex);
            }
        });

        List<BotCandidate> out = new ArrayList<>(scored.size());
        for (ScoredBot s : scored) {
            out.add(s.bot);
        }
        return out;
    }

    private static final class ScoredBot {
        final BotCandidate bot;
        final int score;
        final int originalIndex;

        ScoredBot(BotCandidate bot, int score, int originalIndex) {
            this.bot = bot;
            this.score = score;
            this.originalIndex = originalIndex;
        }
    }

    private static int scoreCandidate(String normName, String normSub, String normQuery, String[] tokens) {
        int total = 0;
        for (String tok : tokens) {
            if (tok.isEmpty()) continue;
            int best = -1;
            if (normName.equals(tok)) {
                best = 100;
            } else if (normName.startsWith(tok)) {
                best = 80;
            } else if (normName.contains(" " + tok)) {
                best = 65;
            } else if (normName.contains(tok)) {
                best = 50;
            } else if (!normSub.isEmpty() && normSub.contains(tok)) {
                best = 20;
            }
            if (best < 0) return -1;
            total += best;
        }
        if (normName.equals(normQuery)) total += 150;
        else if (normName.startsWith(normQuery)) total += 60;
        else if (normName.contains(normQuery)) total += 30;
        return total;
    }

    /**
     * Desktop WRn: offer "Add '<query>' as a new Bot" when query is non-empty, under the 6-Bot cap,
     * and does not exact-match any eligible existing Bot or already-selected recipient.
     */
    public static boolean canOfferCreateNewBot(List<BotCandidate> eligible,
                                               List<Recipient> selected,
                                               String rawQuery) {
        if (isAtBotLimit(selected)) return false;
        String normQuery = normalizeForMatch(rawQuery);
        if (normQuery.isEmpty()) return false;

        if (eligible != null) {
            for (BotCandidate b : eligible) {
                if (b != null && normQuery.equals(normalizeForMatch(b.name))) {
                    return false;
                }
            }
        }
        if (selected != null) {
            for (Recipient r : selected) {
                if (r != null && normQuery.equals(normalizeForMatch(r.name))) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Formats names in locale-natural list style:
     * - narrow=false (conjunction, Desktop bd):
     *   zh: ["A"] -> "A", ["A","B"] -> "A和B", ["A","B","C"] -> "A、B和C"
     *   en: ["A"] -> "A", ["A","B"] -> "A and B", ["A","B","C"] -> "A, B, and C"
     * - narrow=true (comma/pause list, Desktop xd):
     *   zh: "A、B、C"
     *   en: "A, B, C"
     */
    public static String formatList(List<String> items, boolean chinese, boolean narrow) {
        if (items == null || items.isEmpty()) return "";
        List<String> clean = new ArrayList<>();
        for (String item : items) {
            if (item != null && !item.trim().isEmpty()) {
                clean.add(item.trim());
            }
        }
        int n = clean.size();
        if (n == 0) return "";
        if (n == 1) return clean.get(0);

        if (narrow) {
            String sep = chinese ? "、" : ", ";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n; i++) {
                if (i > 0) sb.append(sep);
                sb.append(clean.get(i));
            }
            return sb.toString();
        }

        if (n == 2) {
            return chinese
                    ? (clean.get(0) + "和" + clean.get(1))
                    : (clean.get(0) + " and " + clean.get(1));
        }

        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            if (i == n - 1) {
                sb.append(chinese ? "和" : ", and ");
            } else if (i > 0) {
                sb.append(chinese ? "、" : ", ");
            }
            sb.append(clean.get(i));
        }
        return sb.toString();
    }

    /** Desktop VRn(recipients): names joined for composer placeholder ("Message Alice and Bob"). */
    public static String formatComposerNames(List<Recipient> recipients, boolean chinese) {
        if (recipients == null || recipients.isEmpty()) return "";
        List<String> names = new ArrayList<>(recipients.size());
        for (Recipient r : recipients) {
            if (r != null && !r.name.isEmpty()) {
                names.add(r.name);
            }
        }
        return formatList(names, chinese, false);
    }

    /**
     * Desktop HRn(recipients, accountName):
     * - If accountName is blank: ZQ(bd(names))
     * - If accountName is non-blank: ZQ(xd(names.size()==1 ? [names[0], accountName] : [accountName, ...names]))
     */
    public static String buildAutoGroupName(List<Recipient> recipients, String accountName, boolean chinese) {
        if (recipients == null || recipients.isEmpty()) return "";
        List<String> names = new ArrayList<>(recipients.size());
        for (Recipient r : recipients) {
            if (r != null && !r.name.isEmpty()) {
                names.add(r.name);
            }
        }
        if (names.isEmpty()) return "";

        String acct = accountName != null ? accountName.trim() : "";
        if (acct.isEmpty()) {
            return normalizeGroupName(formatList(names, chinese, false));
        }
        List<String> combined = new ArrayList<>(names.size() + 1);
        if (names.size() == 1) {
            combined.add(names.get(0));
            combined.add(acct);
        } else {
            combined.add(acct);
            combined.addAll(names);
        }
        return normalizeGroupName(formatList(combined, chinese, true));
    }

    /** Validates whether a group creation submit is ready (at least 1 recipient, <= 6). */
    public static boolean canSubmitGroup(List<Recipient> recipients, boolean submitting) {
        return !submitting && recipients != null && !recipients.isEmpty() && recipients.size() <= MAX_GROUP_BOTS;
    }

    /** Validates whether sending a first message from the composer is ready. */
    public static boolean canSendFirstMessage(List<Recipient> recipients, String prompt, boolean submitting) {
        return canSubmitGroup(recipients, submitting) && prompt != null && !prompt.trim().isEmpty();
    }

    /** Helper for tests: checks whether a UI string contains Unicode emoji / pictographs. */
    public static boolean containsEmoji(String text) {
        if (text == null) return false;
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);
            if ((cp >= 0x1F300 && cp <= 0x1FAFF)
                    || (cp >= 0x2600 && cp <= 0x27BF)
                    || cp == 0xFE0F) {
                return true;
            }
        }
        return false;
    }

    /** Helper for tests: checks if text contains forbidden legacy brand name (case-insensitive). */
    public static boolean containsLegacyBrand(String text) {
        return text != null && text.toLowerCase(Locale.US).contains("grok");
    }
}
