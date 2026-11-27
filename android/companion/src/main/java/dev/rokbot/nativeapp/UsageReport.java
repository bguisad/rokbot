package dev.rokbot.nativeapp;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URLEncoder;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.GregorianCalendar;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Pure logic of the usage report page (GET /local/usage/report, version 2, docs/usage-report.md):
 * parsing, the query string, formatting of durations / rates / changes / costs, the scene (kind)
 * names, sorting of breakdown rows, trend stacks, the token composition and the calendar maths of
 * the custom range sheet. Only org.json and java.*: unit-tested on a plain JVM
 * (android/tests/usage-charts.test.mjs). Missing values stay null and show as 「未记录」.
 */
final class UsageReport {
    private UsageReport() {}

    /** The breakdown key / filter value of rows without the field. */
    static final String NONE = "(none)";
    static final String[] RANGE_IDS = {"today", "7d", "30d", "all", "custom"};
    static final String[] DIMENSIONS = {"model", "provider", "profile", "kind", "agent"};
    static final String[] FILTER_KEYS = {"model", "provider", "profile", "kind", "agent", "status"};
    static final int MAX_CUSTOM_DAYS = 400;
    static final int PAGE_SIZE = 20;
    static final String MINUS = "−";

    // ---------------------------------------------------------------- data

    static class Totals {
        long requests, input, output, total, cached, cacheWrite, reasoning, failed, cancelled;
        long statusRecorded, durationRecorded, costRecorded;
        /** null = not recorded in the range. */
        Double avgDurationMs, failureRate, cacheHitRate, cost;

        void read(JSONObject o) {
            requests = count(o, "requests");
            input = count(o, "input");
            output = count(o, "output");
            total = o != null && o.has("total") ? count(o, "total") : input + output;
            cached = count(o, "cached");
            cacheWrite = count(o, "cacheWrite");
            reasoning = count(o, "reasoning");
            failed = count(o, "failed");
            cancelled = count(o, "cancelled");
            statusRecorded = count(o, "statusRecorded");
            durationRecorded = count(o, "durationRecorded");
            costRecorded = count(o, "costRecorded");
            avgDurationMs = num(o, "avgDurationMs");
            failureRate = num(o, "failureRate");
            cacheHitRate = num(o, "cacheHitRate");
            cost = num(o, "cost");
        }
    }

    /** A breakdown row: { key, label, share, ...Totals }. label null = 「未记录」. */
    static final class Row extends Totals {
        String key, label;
        double share;
    }

    static final class ModelTotal {
        final String model;
        final long total;
        ModelTotal(String model, long total) { this.model = model; this.total = total; }
    }

    static final class Bucket extends Totals {
        String start;
        List<ModelTotal> models = new ArrayList<>();
    }

    static final class Option {
        final String key, label;
        final long requests;
        Option(String key, String label, long requests) { this.key = key; this.label = label; this.requests = requests; }
    }

    static final class Request {
        String id, at, kind, model, agentId, agent, profileId, profile, providerId, provider, effort, status, error, requestId;
        long input, output, total, cached, cacheWrite, reasoning;
        Long durationMs;
        Double cost;
    }

    static final class Report {
        int version;
        String timeZone, today, generatedAt;
        String rangeId, from, to, unit;
        int days;
        /** null for range=all. */
        String previousFrom, previousTo;
        Map<String, String> filters = new LinkedHashMap<>();
        boolean priced;
        Totals totals = new Totals();
        Totals previousTotals;
        /** null = no comparison; a key maps to null when it cannot be compared. */
        Map<String, Double> changes;
        List<String> series = new ArrayList<>();
        List<Bucket> buckets = new ArrayList<>();
        Map<String, List<Row>> dimensions = new LinkedHashMap<>();
        Map<String, List<Option>> options = new LinkedHashMap<>();
        long recordedRows, recordedAgent, recordedDuration, recordedStatus, recordedProfile;
        long requestTotal;
        int offset, limit;
        List<Request> items = new ArrayList<>();

        List<Row> rows(String dimension) {
            List<Row> rows = dimensions.get(dimension);
            return rows == null ? Collections.<Row>emptyList() : rows;
        }

        boolean empty() { return totals.requests == 0; }
    }

    private static long count(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return 0;
        long v = o.optLong(key, 0);
        return v > 0 ? v : 0;
    }

    private static Double num(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return null;
        double v = o.optDouble(key, Double.NaN);
        return Double.isNaN(v) || Double.isInfinite(v) ? null : v;
    }

    private static String str(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return null;
        String v = o.optString(key, "");
        return v == null || v.isEmpty() ? null : v;
    }

    /** GET /local/usage/report → Report. */
    static Report parse(JSONObject json) {
        Report r = new Report();
        r.version = json.optInt("version", 0);
        r.timeZone = orEmpty(str(json, "timeZone"));
        r.today = orEmpty(str(json, "today"));
        r.generatedAt = orEmpty(str(json, "generatedAt"));
        JSONObject range = json.optJSONObject("range");
        r.rangeId = range != null && str(range, "id") != null ? str(range, "id") : "7d";
        r.from = range != null ? orEmpty(str(range, "from")) : "";
        r.to = range != null ? orEmpty(str(range, "to")) : "";
        r.days = range != null ? range.optInt("days", 0) : 0;
        String unit = range != null ? str(range, "unit") : null;
        r.unit = "hour".equals(unit) || "month".equals(unit) ? unit : "day";
        JSONObject previous = json.optJSONObject("previous");
        if (previous != null) {
            r.previousFrom = str(previous, "from");
            r.previousTo = str(previous, "to");
        }
        JSONObject filters = json.optJSONObject("filters");
        if (filters != null) {
            for (String key : FILTER_KEYS) {
                String v = str(filters, key);
                if (v != null) r.filters.put(key, v);
            }
        }
        r.priced = json.optBoolean("priced", false);
        String currency = json.optString("currency", "");
        sCurrency = currency.matches("[A-Z]{3}") ? currency : null;
        r.totals.read(json.optJSONObject("totals"));
        JSONObject prev = json.optJSONObject("previousTotals");
        if (prev != null) {
            r.previousTotals = new Totals();
            r.previousTotals.read(prev);
        }
        JSONObject changes = json.optJSONObject("changes");
        if (changes != null) {
            r.changes = new LinkedHashMap<>();
            Iterator<String> keys = changes.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                r.changes.put(key, num(changes, key));
            }
        }
        JSONArray series = json.optJSONArray("series");
        if (series != null) for (int i = 0; i < series.length(); i++) {
            String s = series.optString(i, "");
            if (s != null && !s.isEmpty() && r.series.size() < UsageModel.SERIES) r.series.add(s);
        }
        JSONArray buckets = json.optJSONArray("buckets");
        if (buckets != null) for (int i = 0; i < buckets.length(); i++) {
            JSONObject b = buckets.optJSONObject(i);
            if (b == null) continue;
            Bucket bucket = new Bucket();
            bucket.read(b);
            bucket.start = orEmpty(str(b, "start"));
            JSONArray models = b.optJSONArray("models");
            if (models != null) for (int j = 0; j < models.length(); j++) {
                JSONObject m = models.optJSONObject(j);
                if (m == null) continue;
                String name = str(m, "model");
                bucket.models.add(new ModelTotal(name == null ? NONE : name, count(m, "total")));
            }
            r.buckets.add(bucket);
        }
        JSONObject dims = json.optJSONObject("dimensions");
        for (String dim : DIMENSIONS) {
            List<Row> rows = new ArrayList<>();
            JSONArray arr = dims != null ? dims.optJSONArray(dim) : null;
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Row row = new Row();
                row.read(o);
                row.key = str(o, "key") == null ? NONE : str(o, "key");
                row.label = NONE.equals(row.key) ? null : str(o, "label");
                row.share = o.optDouble("share", 0);
                rows.add(row);
            }
            r.dimensions.put(dim, rows);
        }
        JSONObject options = json.optJSONObject("options");
        for (String key : FILTER_KEYS) {
            List<Option> list = new ArrayList<>();
            JSONArray arr = options != null ? options.optJSONArray(key) : null;
            if (arr != null) for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String k = str(o, "key") == null ? NONE : str(o, "key");
                list.add(new Option(k, NONE.equals(k) ? null : str(o, "label"), count(o, "requests")));
            }
            r.options.put(key, list);
        }
        JSONObject recorded = json.optJSONObject("recorded");
        r.recordedRows = count(recorded, "rows");
        r.recordedAgent = count(recorded, "agent");
        r.recordedDuration = count(recorded, "duration");
        r.recordedStatus = count(recorded, "status");
        r.recordedProfile = count(recorded, "profile");
        JSONObject requests = json.optJSONObject("requests");
        r.requestTotal = count(requests, "total");
        r.offset = requests != null ? Math.max(0, requests.optInt("offset", 0)) : 0;
        r.limit = requests != null ? Math.max(1, requests.optInt("limit", PAGE_SIZE)) : PAGE_SIZE;
        JSONArray items = requests != null ? requests.optJSONArray("items") : null;
        if (items != null) for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            Request q = new Request();
            q.id = str(o, "id");
            q.at = str(o, "at");
            q.kind = str(o, "kind");
            q.model = str(o, "model");
            q.agentId = str(o, "agentId");
            q.agent = str(o, "agent");
            q.profileId = str(o, "profileId");
            q.profile = str(o, "profile");
            q.providerId = str(o, "providerId");
            q.provider = str(o, "provider");
            q.effort = str(o, "effort");
            q.input = count(o, "input");
            q.output = count(o, "output");
            q.total = o.has("total") ? count(o, "total") : q.input + q.output;
            q.cached = count(o, "cached");
            q.cacheWrite = count(o, "cacheWrite");
            q.reasoning = count(o, "reasoning");
            Double d = num(o, "durationMs");
            q.durationMs = d == null ? null : Math.round(d);
            q.status = str(o, "status");
            q.error = str(o, "error");
            q.cost = num(o, "cost");
            q.requestId = str(o, "requestId");
            r.items.add(q);
        }
        return r;
    }

    private static String orEmpty(String s) { return s == null ? "" : s; }

    // ---------------------------------------------------------------- query

    static String encode(String value) {
        try {
            return URLEncoder.encode(value != null ? value : "", "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * The path of GET /local/usage/report: timeZone, range (from / to for custom), the filters in
     * FILTER_KEYS order, offset and limit; `export` adds export=csv (no paging then).
     */
    static String query(String timeZone, String range, String from, String to, Map<String, String> filters,
                        int offset, int limit, boolean export) {
        StringBuilder b = new StringBuilder("/local/usage/report?timeZone=").append(encode(timeZone));
        String id = range == null || range.trim().isEmpty() ? "7d" : range.trim();
        b.append("&range=").append(encode(id));
        if ("custom".equals(id)) {
            b.append("&from=").append(encode(from)).append("&to=").append(encode(to));
        }
        if (filters != null) {
            for (String key : FILTER_KEYS) {
                String v = filters.get(key);
                if (v != null && !v.isEmpty()) b.append('&').append(key).append('=').append(encode(v));
            }
        }
        if (export) b.append("&export=csv");
        else b.append("&offset=").append(Math.max(0, offset)).append("&limit=").append(Math.max(1, Math.min(200, limit)));
        return b.toString();
    }

    // ---------------------------------------------------------------- names

    static String missing(boolean zh) { return zh ? "未记录" : "Not recorded"; }

    private static final String[][] KINDS = {
        {"chat", "对话", "Chat"},
        {"suggestions", "输入建议", "Suggestions"},
        {"completion", "输入补全", "Completion"},
        {"autocomplete", "输入补全", "Completion"},
        {"title", "标题", "Titles"},
        {"test", "测试", "Tests"},
        {"summary", "摘要", "Summaries"},
        {"memory", "记忆", "Memory"},
        {"subagent", "子任务", "Subagents"},
        {"automation", "自动化", "Automations"},
        {"classifier", "路由判断", "Routing"},
        {"review", "自动审查", "Auto review"},
    };

    /** The scene (kind) name; unknown kinds as they are, none = 「未记录」. */
    static String kindLabel(String kind, boolean zh) {
        if (kind == null || kind.isEmpty() || NONE.equals(kind)) return missing(zh);
        for (String[] k : KINDS) if (k[0].equals(kind)) return zh ? k[1] : k[2];
        return kind;
    }

    static String statusLabel(String status, boolean zh) {
        if (status == null || status.isEmpty() || NONE.equals(status)) return missing(zh);
        switch (status) {
            case "ok": return zh ? "成功" : "Succeeded";
            case "error": return zh ? "失败" : "Failed";
            case "cancelled": return zh ? "已取消" : "Cancelled";
            default: return status;
        }
    }

    static String dimensionTitle(String dimension, boolean zh) {
        switch (dimension) {
            case "model": return zh ? "模型" : "Model";
            case "provider": return zh ? "服务商" : "Provider";
            case "profile": return zh ? "配置" : "Profile";
            case "kind": return zh ? "场景" : "Scene";
            case "agent": return "Bot";
            case "status": return zh ? "状态" : "Status";
            default: return dimension;
        }
    }

    /** The shown name of a dimension value (row, option or filter chip). */
    static String valueLabel(String dimension, String key, String label, boolean zh) {
        if (key == null || NONE.equals(key)) return missing(zh);
        if ("kind".equals(dimension)) return kindLabel(key, zh);
        if ("status".equals(dimension)) return statusLabel(key, zh);
        return label == null || label.isEmpty() ? key : label;
    }

    /** The label of the filter value `key` from the report's options (falls back to the key). */
    static String filterLabel(Report r, String dimension, String key, boolean zh) {
        if (r != null) {
            List<Option> list = r.options.get(dimension);
            if (list != null) for (Option o : list) if (o.key.equals(key)) return valueLabel(dimension, o.key, o.label, zh);
        }
        return valueLabel(dimension, key, null, zh);
    }

    /** 「模型：deepseek-v3.2」 */
    static String chipLabel(Report r, String dimension, String key, boolean zh) {
        return dimensionTitle(dimension, zh) + (zh ? "：" : ": ") + filterLabel(r, dimension, key, zh);
    }

    // ---------------------------------------------------------------- numbers

    private static String stripZeros(String text) {
        int dot = text.indexOf('.');
        if (dot < 0) return text;
        int end = text.length();
        while (end > dot + 1 && text.charAt(end - 1) == '0') end--;
        if (end == dot + 1) end = dot;
        return text.substring(0, end);
    }

    private static String round(double value, int digits) {
        return stripZeros(BigDecimal.valueOf(value).setScale(digits, RoundingMode.HALF_UP).toPlainString());
    }

    /** 「850 ms」「7.4 s」「12 s」「1 分 5 秒」/「1m 5s」; null = 「未记录」. */
    static String formatDuration(Double ms, boolean zh) {
        if (ms == null) return missing(zh);
        double v = Math.max(0, ms);
        if (Math.round(v) < 1000) return Math.round(v) + " ms";
        double s = v / 1000;
        if (s < 10) return round(s, 1) + " s";
        if (s < 59.5) return Math.round(s) + " s";
        long total = Math.round(s), minutes = total / 60, seconds = total % 60;
        if (minutes >= 60) {
            long hours = minutes / 60, rest = minutes % 60;
            return zh ? hours + " 小时 " + rest + " 分" : hours + "h " + rest + "m";
        }
        return zh ? minutes + " 分 " + seconds + " 秒" : minutes + "m " + seconds + "s";
    }

    /** A 0–1 rate as a share: 「3%」「<0.1%」; null = `none`. */
    static String formatRate(Double rate, String none) {
        if (rate == null) return none;
        return UsageModel.formatShare(rate, 1);
    }

    /** The change from the previous period: 「+12.3%」「−4.7%」「0%」, empty when it cannot be compared. */
    static String formatChange(Double ratio) {
        if (ratio == null || Double.isNaN(ratio) || Double.isInfinite(ratio)) return "";
        double pct = ratio * 100;
        double abs = Math.abs(pct);
        String text = round(abs, abs >= 100 ? 0 : 1);
        if ("0".equals(text)) return "0%";
        return (pct > 0 ? "+" : MINUS) + text + "%";
    }

    static final int TONE_NEUTRAL = 0, TONE_WARN = 1, TONE_GOOD = 2;

    /** Durations and failure rates that rise are a warning, falling ones good; everything else neutral. */
    static int changeTone(String key, Double ratio) {
        if (ratio == null || formatChange(ratio).isEmpty() || "0%".equals(formatChange(ratio))) return TONE_NEUTRAL;
        if ("avgDurationMs".equals(key) || "failureRate".equals(key)) return ratio > 0 ? TONE_WARN : TONE_GOOD;
        return TONE_NEUTRAL;
    }

    static Double change(Report r, String key) {
        return r == null || r.changes == null ? null : r.changes.get(key);
    }

    /** Cost in the Host's currency units: 4 decimals below 1, else 2; not priced = 「未配置单价」. */
    static String formatCost(Double cost, boolean priced, boolean zh) {
        if (!priced) return zh ? "未配置单价" : "No prices set";
        if (cost == null) return missing(zh);
        double v = cost;
        if (v == 0) return "0";
        if (Math.abs(v) < 0.0001) return "<0.0001";
        return currencySymbol() + round(v, Math.abs(v) < 1 ? 4 : 2);
    }

    /** The currency of the last parsed report (usage-prices.json "currency"), null without one. */
    static String sCurrency;
    static String currencySymbol() {
        if (sCurrency == null) return "";
        if ("CNY".equals(sCurrency)) return "¥";
        try { return java.util.Currency.getInstance(sCurrency).getSymbol(java.util.Locale.US); }
        catch (IllegalArgumentException e) { return sCurrency + " "; }
    }

    /** 「198 / 200 条有记录」, or null when every row recorded the field. */
    static String recordedNote(long recorded, long rows, boolean zh) {
        if (rows <= 0 || recorded >= rows) return null;
        String a = UsageModel.formatExact(recorded), b = UsageModel.formatExact(rows);
        return zh ? a + " / " + b + " 条有记录" : a + " / " + b + " recorded";
    }

    /** 「第 1–20 条，共 198 条」/「1–20 of 198」. */
    static String pageLabel(int offset, int shown, long total, boolean zh) {
        if (total <= 0 || shown <= 0) return zh ? "共 " + UsageModel.formatExact(total) + " 条" : UsageModel.formatExact(total) + " in total";
        String a = UsageModel.formatExact(offset + 1), b = UsageModel.formatExact(offset + shown), n = UsageModel.formatExact(total);
        return zh ? "第 " + a + "–" + b + " 条，共 " + n + " 条" : a + "–" + b + " of " + n;
    }

    static boolean hasPrevPage(Report r) { return r != null && r.offset > 0; }

    static boolean hasNextPage(Report r) { return r != null && r.offset + r.items.size() < r.requestTotal; }

    // ---------------------------------------------------------------- dates

    /** 「2026-11-21 – 2026-11-27」 or one date. */
    static String span(String from, String to) {
        from = from == null ? "" : from;
        to = to == null ? "" : to;
        if (from.isEmpty() || from.equals(to)) return to;
        if (to.isEmpty()) return from;
        return from + " – " + to;
    }

    /** 「2026-11-21 – 2026-11-27 · 对比 2026-11-14 – 2026-11-20 · Asia/Shanghai」 */
    static String rangeLine(Report r, boolean zh) {
        StringBuilder b = new StringBuilder(span(r.from, r.to));
        if (r.previousFrom != null && r.previousTo != null) {
            b.append(" · ").append(zh ? "对比 " : "vs ").append(span(r.previousFrom, r.previousTo));
        }
        if (r.timeZone != null && !r.timeZone.isEmpty()) b.append(" · ").append(r.timeZone);
        return b.toString();
    }

    private static final String[] MONTHS = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

    private static int part(String s, int from, int to) {
        try { return Integer.parseInt(s.substring(from, to)); } catch (RuntimeException e) { return -1; }
    }

    /** Axis label of a bucket: 「9:00」, 「11/25」, 「11月」/「Nov」 (January of a new year with the year). */
    static String axisLabel(String start, String unit, boolean zh) {
        if ("month".equals(unit)) {
            int month = start != null && start.length() >= 7 ? part(start, 5, 7) : -1;
            if (month < 1 || month > 12) return start == null ? "" : start;
            if (month == 1) return start.substring(0, 4);
            return zh ? month + "月" : MONTHS[month - 1];
        }
        return UsageModel.axisLabel(start, "hour".equals(unit));
    }

    /** Tooltip title of a bucket: 「9:00–10:00」, 「11月25日」/「Nov 25」, 「2026年11月」/「Nov 2026」. */
    static String titleLabel(String start, String unit, boolean zh) {
        if ("month".equals(unit)) {
            int month = start != null && start.length() >= 7 ? part(start, 5, 7) : -1;
            if (month < 1 || month > 12) return start == null ? "" : start;
            String year = start.substring(0, 4);
            return zh ? year + "年" + month + "月" : MONTHS[month - 1] + " " + year;
        }
        return UsageModel.titleLabel(start, "hour".equals(unit), zh);
    }

    /** The request time in the report's time zone: 「11-27 14:03:12」 (with the year when not this year). */
    static String requestTime(String isoAt, String timeZone, String today) {
        if (isoAt == null || isoAt.isEmpty()) return "";
        Date date = parseIso(isoAt);
        if (date == null) return isoAt;
        TimeZone zone = TimeZone.getTimeZone(timeZone == null || timeZone.isEmpty() ? "UTC" : timeZone);
        SimpleDateFormat year = new SimpleDateFormat("yyyy", Locale.US);
        year.setTimeZone(zone);
        boolean sameYear = today == null || today.length() < 4 || today.startsWith(year.format(date));
        SimpleDateFormat out = new SimpleDateFormat(sameYear ? "MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm", Locale.US);
        out.setTimeZone(zone);
        return out.format(date);
    }

    private static Date parseIso(String iso) {
        String s = iso;
        // 2026-11-27T06:00:00.000Z / without millis.
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX"};
        for (String p : patterns) {
            try {
                SimpleDateFormat f = new SimpleDateFormat(p, Locale.US);
                f.setTimeZone(TimeZone.getTimeZone("UTC"));
                f.setLenient(false);
                return f.parse(s);
            } catch (ParseException | IllegalArgumentException ignored) {
            }
        }
        return null;
    }

    private static GregorianCalendar cal(String date) {
        if (date == null || date.length() != 10) return null;
        int y = part(date, 0, 4), m = part(date, 5, 7), d = part(date, 8, 10);
        if (y < 1 || m < 1 || m > 12 || d < 1) return null;
        GregorianCalendar c = new GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.US);
        c.clear();
        c.setLenient(false);
        try {
            c.set(y, m - 1, d);
            c.getTimeInMillis();
        } catch (RuntimeException e) {
            return null;
        }
        return c;
    }

    static boolean validDate(String date) { return cal(date) != null; }

    static String date(int year, int month, int day) {
        return String.format(Locale.US, "%04d-%02d-%02d", year, month, day);
    }

    static String addDays(String date, int days) {
        GregorianCalendar c = cal(date);
        if (c == null) return date;
        c.setLenient(true);
        c.add(Calendar.DAY_OF_MONTH, days);
        return date(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    /** Days from `from` to `to`, both included (0 when invalid). */
    static int daysBetween(String from, String to) {
        GregorianCalendar a = cal(from), b = cal(to);
        if (a == null || b == null) return 0;
        return (int) Math.round((b.getTimeInMillis() - a.getTimeInMillis()) / 86400000d) + 1;
    }

    static int daysInMonth(int year, int month) {
        GregorianCalendar c = new GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.US);
        c.clear();
        c.set(year, month - 1, 1);
        return c.getActualMaximum(Calendar.DAY_OF_MONTH);
    }

    /** 0 = Monday … 6 = Sunday, the weekday of the 1st (the grid starts on Monday). */
    static int firstWeekday(int year, int month) {
        GregorianCalendar c = new GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.US);
        c.clear();
        c.set(year, month - 1, 1);
        return (c.get(Calendar.DAY_OF_WEEK) + 5) % 7;
    }

    /** 「2026 年 11 月」/「November 2026」 */
    static String monthTitle(int year, int month, boolean zh) {
        String[] full = {"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"};
        return zh ? year + " 年 " + month + " 月" : full[month - 1] + " " + year;
    }

    /**
     * Checks a custom range picked in the sheet: null when fine, else the message. Dates after
     * `today` and ranges longer than MAX_CUSTOM_DAYS are refused, as the Host does.
     */
    static String validateCustom(String from, String to, String today, boolean zh) {
        if (!validDate(from) || !validDate(to)) return zh ? "请选择开始和结束日期" : "Pick a start and an end date";
        if (from.compareTo(to) > 0) return zh ? "开始日期晚于结束日期" : "The range starts after it ends";
        if (today != null && validDate(today) && to.compareTo(today) > 0) return zh ? "不能选择今天之后的日期" : "Dates after today are not available";
        if (daysBetween(from, to) > MAX_CUSTOM_DAYS)
            return zh ? "最长 " + MAX_CUSTOM_DAYS + " 天" : "At most " + MAX_CUSTOM_DAYS + " days";
        return null;
    }

    /** Tapping `day` in the range sheet: the first tap starts, the second ends (swapped when earlier). */
    static String[] pickDay(String from, String to, String day) {
        if (from == null || to != null) return new String[] {day, null};
        if (day.compareTo(from) < 0) return new String[] {day, from};
        return new String[] {from, day};
    }

    // ---------------------------------------------------------------- series, stacks, composition

    /** Colour series of a model: 1 … 7 by its place in `series`, 0 (grey) for the rest. */
    static int seriesOf(Report r, String model) {
        if (r == null || model == null) return 0;
        int i = r.series.indexOf(model);
        return i >= 0 && i < UsageModel.SERIES ? i + 1 : 0;
    }

    /** Colour of a breakdown row: the model series for models, else by place; 「未记录」 grey. */
    static int rowSeries(Report r, String dimension, Row row, int index) {
        if (row == null || NONE.equals(row.key)) return 0;
        if ("model".equals(dimension)) return seriesOf(r, row.key);
        return index < UsageModel.SERIES ? index + 1 : 0;
    }

    /** Model mode: tokens per series from the baseline (series order), other models on top. */
    static List<UsageModel.Stack> modelStacks(Report r, Bucket b) {
        Map<Integer, Long> sums = new LinkedHashMap<>();
        for (ModelTotal m : b.models) {
            int s = seriesOf(r, m.model);
            Long cur = sums.get(s);
            sums.put(s, (cur == null ? 0 : cur) + m.total);
        }
        List<Integer> order = new ArrayList<>(sums.keySet());
        Collections.sort(order, (x, y) -> Integer.compare(x == 0 ? 99 : x, y == 0 ? 99 : y));
        List<UsageModel.Stack> out = new ArrayList<>();
        for (int s : order) out.add(new UsageModel.Stack(s, sums.get(s)));
        return out;
    }

    /** Type mode, from the baseline: cached input, uncached input, output. */
    static long[] typeStack(Bucket b) {
        long cached = Math.min(b.cached, b.input);
        return new long[] {cached, Math.max(0, b.input - cached), b.output};
    }

    /** Requests mode: succeeded (or not recorded) and failed. */
    static long[] requestStack(Bucket b) {
        long failed = Math.min(b.failed, b.requests);
        return new long[] {b.requests - failed, failed};
    }

    static final String MODE_MODEL = "model", MODE_TYPE = "type", MODE_REQUESTS = "requests";

    /** The top of the y scale of a trend mode. */
    static long trendMax(Report r, String mode) {
        long max = 0;
        for (Bucket b : r.buckets) {
            if (MODE_REQUESTS.equals(mode)) max = Math.max(max, b.requests);
            else if (MODE_TYPE.equals(mode)) max = Math.max(max, b.input + b.output);
            else max = Math.max(max, b.total);
        }
        return max;
    }

    /**
     * Token composition, as parts of the input and output: uncached input, cached input, output
     * without reasoning, reasoning (output includes reasoning in the ledger).
     */
    static long[] composition(Totals t) {
        long cached = Math.min(t.cached, t.input);
        long reasoning = Math.min(t.reasoning, t.output);
        return new long[] {Math.max(0, t.input - cached), cached, Math.max(0, t.output - reasoning), reasoning};
    }

    // ---------------------------------------------------------------- sorting

    static final String SORT_TOTAL = "total", SORT_REQUESTS = "requests", SORT_DURATION = "avgDurationMs",
            SORT_FAILURE = "failureRate", SORT_COST = "cost", SORT_NAME = "name";

    private static Double sortValue(Row row, String column) {
        switch (column) {
            case SORT_REQUESTS: return (double) row.requests;
            case SORT_DURATION: return row.avgDurationMs;
            case SORT_FAILURE: return row.failureRate;
            case SORT_COST: return row.cost;
            default: return (double) row.total;
        }
    }

    /** A sorted copy: by `column`, descending or not; unrecorded values always last, ties by total. */
    static List<Row> sortRows(List<Row> rows, final String column, final boolean descending, final String dimension, final boolean zh) {
        List<Row> out = new ArrayList<>(rows);
        Comparator<Row> cmp = (a, b) -> {
            if (SORT_NAME.equals(column)) {
                boolean na = NONE.equals(a.key), nb = NONE.equals(b.key);
                if (na != nb) return na ? 1 : -1;
                int c = valueLabel(dimension, a.key, a.label, zh).compareToIgnoreCase(valueLabel(dimension, b.key, b.label, zh));
                return descending ? -c : c;
            }
            Double va = sortValue(a, column), vb = sortValue(b, column);
            if (va == null || vb == null) {
                if (va != vb) return va == null ? 1 : -1;
            } else {
                int c = Double.compare(va, vb);
                if (c != 0) return descending ? -c : c;
            }
            return Long.compare(b.total, a.total);
        };
        Collections.sort(out, cmp);
        return out;
    }
}
