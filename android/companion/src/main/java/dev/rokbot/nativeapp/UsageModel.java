package dev.rokbot.nativeapp;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Pure logic of the native usage page (UsageActivity / UsageChartView), ported from the Host's
 * host/server/public/usage-charts.js and usage-format.js so the phone matches the desktop / web
 * settings: number formatting (万 / 亿, K / M / B), y ticks, shares, the colour series per model
 * (fixed by the 30-day ranking) and the bucket parsing of GET /local/usage.
 * Only org.json and java.*: unit-tested on a plain JVM (android/tests/usage-charts.test.mjs).
 */
final class UsageModel {
    private UsageModel() {}

    /** Seven series colours in a fixed order; series 0 is "other models" (grey). */
    static final int SERIES = 7;
    /** usage-charts.css --rok-usage-c0 … c7, light theme. */
    static final int[] LIGHT_COLORS = {
        0xFFA9A8A2, 0xFF2A78D6, 0xFFEB6834, 0xFF1BAF7A, 0xFFEDA100, 0xFFE87BA4, 0xFF008300, 0xFF6250D6,
    };
    /** usage-charts.css --rok-usage-c0 … c7, dark theme. */
    static final int[] DARK_COLORS = {
        0xFF6B6A65, 0xFF3987E5, 0xFFD95926, 0xFF199E70, 0xFFC98500, 0xFFD55181, 0xFF008300, 0xFF9085E9,
    };

    static final String[] PERIOD_IDS = {"today", "7d", "30d"};
    /** The range the usage page opens on: today, unless the caller asks for another one. */
    static final String DEFAULT_PERIOD = "today";

    /**
     * The range UsageActivity opens on. `requested` is the intent's range extra (null: none):
     * one of UsageReport.RANGE_IDS, and "custom" only with a valid from <= to. Anything else is
     * today - never the last range used, so opening the page always shows today first.
     */
    static String initialPeriod(String requested, String from, String to) {
        String id = requested == null ? "" : requested.trim();
        if (id.isEmpty()) return DEFAULT_PERIOD;
        if ("custom".equals(id)) {
            return UsageReport.validDate(from) && UsageReport.validDate(to) && from.compareTo(to) <= 0 ? id : DEFAULT_PERIOD;
        }
        for (String known : UsageReport.RANGE_IDS) if (known.equals(id)) return id;
        return DEFAULT_PERIOD;
    }

    static int seriesColor(int series, boolean dark) {
        int[] colors = dark ? DARK_COLORS : LIGHT_COLORS;
        return colors[series >= 1 && series <= SERIES ? series : 0];
    }

    // ---------------------------------------------------------------- data

    static class Counts {
        long input, output, total, cached, cacheWrite, reasoning, requests;
        /** Older Hosts answer only total / input / output. */
        boolean hasRequests, hasCached;

        void read(JSONObject o) {
            input = count(o, "input");
            output = count(o, "output");
            total = o.has("total") ? count(o, "total") : input + output;
            cached = count(o, "cached");
            cacheWrite = count(o, "cacheWrite");
            reasoning = count(o, "reasoning");
            requests = count(o, "requests");
            hasRequests = o.has("requests");
            hasCached = o.has("cached");
        }
    }

    static final class ModelRow extends Counts {
        String model;
    }

    static final class Bucket extends Counts {
        String start;
        List<ModelRow> models = new ArrayList<>();
    }

    static final class Period extends Counts {
        String id;
        int days;
        String from, to;
        /** "hour" or "day". */
        String unit;
        /** null when the Host does not send buckets (older Host): no column chart. */
        List<Bucket> buckets;
        List<ModelRow> models = new ArrayList<>();

        boolean hourly() { return "hour".equals(unit); }
    }

    static final class Usage {
        String date, timeZone;
        List<Period> periods = new ArrayList<>();
        /** No periods[] in the response: an older Host with today's totals only. */
        boolean legacy;

        Period period(String id) {
            for (Period p : periods) if (p.id.equals(id)) return p;
            return periods.isEmpty() ? null : periods.get(0);
        }

        boolean has(String id) {
            for (Period p : periods) if (p.id.equals(id)) return true;
            return false;
        }
    }

    private static long count(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return 0;
        long v = o.optLong(key, 0);
        return v > 0 ? v : 0;
    }

    private static String str(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return "";
        String v = o.optString(key, "");
        return v == null ? "" : v;
    }

    private static List<ModelRow> models(JSONArray arr) {
        List<ModelRow> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            ModelRow row = new ModelRow();
            row.read(o);
            String name = str(o, "model");
            row.model = name.isEmpty() ? "unknown" : name;
            out.add(row);
        }
        return out;
    }

    private static Period period(JSONObject o) {
        Period p = new Period();
        p.read(o);
        String id = str(o, "id");
        if (id.isEmpty()) id = str(o, "key");
        if (id.isEmpty()) id = str(o, "period");
        p.id = id.isEmpty() ? "today" : id;
        int days = o.optInt("days", 0);
        if (days <= 0) days = "today".equals(p.id) ? 1 : "7d".equals(p.id) ? 7 : "30d".equals(p.id) ? 30 : 0;
        p.days = days;
        p.from = str(o, "from");
        p.to = str(o, "to");
        p.models = models(o.optJSONArray("models"));
        JSONArray buckets = o.optJSONArray("buckets");
        String unit = str(o, "unit");
        if (buckets != null) {
            p.buckets = new ArrayList<>();
            for (int i = 0; i < buckets.length(); i++) {
                JSONObject b = buckets.optJSONObject(i);
                if (b == null) continue;
                Bucket bucket = new Bucket();
                bucket.read(b);
                String start = str(b, "start");
                if (start.isEmpty()) start = str(b, "label");
                bucket.start = start;
                bucket.models = models(b.optJSONArray("models"));
                p.buckets.add(bucket);
            }
            if (unit.isEmpty()) unit = !p.buckets.isEmpty() && p.buckets.get(0).start.indexOf('T') > 0 ? "hour" : "day";
        }
        p.unit = "hour".equals(unit) ? "hour" : "day";
        return p;
    }

    /** GET /local/usage → Usage. Without periods[] (older Host) today's top-level totals become one period. */
    static Usage parse(JSONObject json) {
        Usage u = new Usage();
        u.date = str(json, "date");
        u.timeZone = str(json, "timeZone");
        JSONArray periods = json.optJSONArray("periods");
        if (periods != null) {
            for (int i = 0; i < periods.length(); i++) {
                JSONObject o = periods.optJSONObject(i);
                if (o != null) u.periods.add(period(o));
            }
        }
        if (u.periods.isEmpty()) {
            u.legacy = true;
            Period today = new Period();
            today.read(json);
            today.id = "today";
            today.days = 1;
            today.from = u.date;
            today.to = u.date;
            today.unit = "hour";
            today.buckets = null;
            today.models = models(json.optJSONArray("models"));
            u.periods.add(today);
        }
        return u;
    }

    /** True when there is nothing to chart in the period (usage-charts.js: no requests). */
    static boolean isEmpty(Period p) {
        return p == null || (p.hasRequests ? p.requests == 0 : p.total == 0);
    }

    // ---------------------------------------------------------------- series

    /**
     * usageSeries(): 1 … SERIES for the largest models of the longest period, 0 ("other models")
     * for the rest. The longest period is 30 days, so switching the period never recolours a model.
     */
    static Map<String, Integer> series(Usage usage) {
        Map<String, Integer> out = new LinkedHashMap<>();
        if (usage == null) return out;
        Period longest = null;
        int best = -1;
        for (Period p : usage.periods) {
            if (p.days > best) { best = p.days; longest = p; }
        }
        if (longest == null) return out;
        for (ModelRow row : longest.models) {
            if (row.total > 0 && out.size() < SERIES && !out.containsKey(row.model)) out.put(row.model, out.size() + 1);
        }
        return out;
    }

    static int seriesOf(Map<String, Integer> series, String model) {
        Integer s = series.get(model);
        return s == null ? 0 : s;
    }

    static String modelName(String model, boolean zh) {
        return "unknown".equals(model) ? (zh ? "未知模型" : "Unknown model") : model;
    }

    // ---------------------------------------------------------------- numbers

    private static final double[] UNITS_ZH = {1e12, 1e8, 1e4};
    private static final String[] SUFFIX_ZH = {"万亿", "亿", "万"};
    private static final double[] UNITS_EN = {1e12, 1e9, 1e6, 1e3};
    private static final String[] SUFFIX_EN = {"T", "B", "M", "K"};

    /** The exact count with digit grouping: "12,345" (the same in zh-CN and en-US). */
    static String formatExact(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) return "—";
        return String.format(Locale.US, "%,d", Math.round(value));
    }

    /**
     * usage-format.js formatCount(): "1.23 万", "3.2 亿", "12.3M"; below 10,000 (zh) or 1,000 (en)
     * the exact grouped number. Two decimals below 10, one from 10 up, no trailing zeros.
     */
    static String formatCount(double value, boolean zh) {
        if (Double.isNaN(value) || Double.isInfinite(value)) return "—";
        double[] units = zh ? UNITS_ZH : UNITS_EN;
        String[] suffixes = zh ? SUFFIX_ZH : SUFFIX_EN;
        long size = Math.abs(Math.round(value));
        String sign = value < 0 && size > 0 ? "-" : "";
        if (size < units[units.length - 1]) return sign + formatExact(size);
        for (int index = units.length - 1; index >= 0; index--) {
            double unit = units[index];
            boolean hasNext = index > 0;
            double next = hasNext ? units[index - 1] : 0;
            if (hasNext && size >= next) continue;
            double scaled = size / unit;
            int digits = scaled < 10 ? 2 : 1;
            BigDecimal rounded = new BigDecimal(scaled).setScale(digits, RoundingMode.HALF_UP);
            // 9,999.96 万 rounds up to 10,000 万: that is 1 亿.
            if (hasNext && rounded.doubleValue() * unit >= next) return sign + formatCount(next, zh);
            return sign + stripZeros(rounded.toPlainString()) + (zh ? " " : "") + suffixes[index];
        }
        return sign + formatExact(size);
    }

    private static String stripZeros(String text) {
        int dot = text.indexOf('.');
        if (dot < 0) return text;
        int end = text.length();
        while (end > dot + 1 && text.charAt(end - 1) == '0') end--;
        if (end == dot + 1) end = dot;
        return text.substring(0, end);
    }

    /** "1,757 次请求" / "2.77 万次请求" / "1 request" / "27.7K requests". */
    static String withRequestUnit(String text, long value, boolean zh) {
        if (zh) return text + (text.endsWith("万") || text.endsWith("亿") ? "" : " ") + "次请求";
        return text + " " + (value == 1 ? "request" : "requests");
    }

    /** formatShare(): "45%", "9.7%", "<0.1%", "0%". */
    static String formatShare(double part, double whole) {
        if (whole == 0 || part == 0 || Double.isNaN(whole) || Double.isNaN(part)) return "0%";
        double share = part / whole * 100;
        if (share < 0.1) return "<0.1%";
        // Intl.NumberFormat rounds the shortest decimal form of the double (9.95 → "10"), not its exact
        // binary value as toFixed() does: BigDecimal.valueOf() starts from that same decimal string.
        BigDecimal rounded = BigDecimal.valueOf(share).setScale(share < 10 ? 1 : 0, RoundingMode.HALF_UP);
        return stripZeros(rounded.toPlainString()) + "%";
    }

    /** Cache hit rate = cached / input; "—" without input or (older Host) without a cached field. */
    static String cacheHitRate(Counts c) {
        if (c == null || !c.hasCached || c.input <= 0) return "—";
        return formatShare(c.cached, c.input);
    }

    /** usageTicks(): up to five round ticks from 0 that reach `max`, steps of 1 / 2 / 2.5 / 5 × 10ⁿ. */
    static double[] ticks(double max, int wanted) {
        if (!(max > 0)) return new double[] {0};
        double rough = max / wanted, power = Math.pow(10, Math.floor(Math.log10(rough)));
        double step = 10 * power;
        for (double factor : new double[] {1, 2, 2.5, 5, 10}) {
            if (factor * power >= rough) { step = factor * power; break; }
        }
        List<Double> out = new ArrayList<>();
        for (double value = 0; value < max + step; value += step) out.add(Math.round(value * 1e6) / 1e6);
        if (out.size() > 1 && out.get(out.size() - 2) >= max) out.remove(out.size() - 1);
        double[] arr = new double[out.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = out.get(i);
        return arr;
    }

    static double[] ticks(double max) { return ticks(max, 4); }

    // ---------------------------------------------------------------- labels

    private static final String[] MONTHS = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

    private static int num(String s, int from, int to) {
        try { return Integer.parseInt(s.substring(from, to)); } catch (RuntimeException e) { return -1; }
    }

    /** Axis label: "13:00" for "2026-11-25T13", "11/25" for "2026-11-25". */
    static String axisLabel(String start, boolean hourly) {
        if (start == null) return "";
        if (hourly) {
            int hour = start.length() >= 13 ? num(start, 11, 13) : -1;
            return hour < 0 ? start : hour + ":00";
        }
        int month = start.length() >= 10 ? num(start, 5, 7) : -1, day = start.length() >= 10 ? num(start, 8, 10) : -1;
        return month < 1 || day < 1 ? start : month + "/" + day;
    }

    /** Tooltip title: "13:00–14:00", "11月25日" / "Nov 25". */
    static String titleLabel(String start, boolean hourly, boolean zh) {
        if (start == null) return "";
        if (hourly) {
            int hour = start.length() >= 13 ? num(start, 11, 13) : -1;
            return hour < 0 ? start : hour + ":00–" + (hour + 1) + ":00";
        }
        int month = start.length() >= 10 ? num(start, 5, 7) : -1, day = start.length() >= 10 ? num(start, 8, 10) : -1;
        if (month < 1 || month > 12 || day < 1) return start;
        return zh ? month + "月" + day + "日" : MONTHS[month - 1] + " " + day;
    }

    /** "2026-11-26" for today, "2026-11-20 – 2026-11-26" otherwise. */
    static String rangeLabel(Period p) {
        if (p == null) return "";
        String from = p.from == null ? "" : p.from, to = p.to == null ? "" : p.to;
        if (from.isEmpty() || from.equals(to)) return to;
        return from + " – " + to;
    }

    /**
     * Label every n-th column so labels (about 40–44 dp each) do not collide: hours every
     * 1 / 2 / 3 / 6 / 12 hours, days every ceil(44 / step) days. `step` is the column pitch in dp.
     */
    static int labelEvery(boolean hourly, double step) {
        if (hourly) {
            for (int v : new int[] {1, 2, 3, 6, 12}) if (v * step >= 40) return v;
            return 12;
        }
        return Math.max(1, (int) Math.ceil(44 / step));
    }

    /** Hours from midnight; days counted back from the last (today), so today is always labelled. */
    static boolean showLabel(boolean hourly, int index, int count, int every) {
        return hourly ? index % every == 0 : (count - 1 - index) % every == 0;
    }

    // ---------------------------------------------------------------- stacks, shares, tooltip

    /** One stacked part of a column: `series` and its token total. */
    static final class Stack {
        final int series;
        final long total;
        Stack(int series, long total) { this.series = series; this.total = total; }
    }

    /** The bucket's models summed per series, in the fixed series order from the baseline, others on top. */
    static List<Stack> stacks(Bucket bucket, Map<String, Integer> series) {
        Map<Integer, Long> sums = new LinkedHashMap<>();
        for (ModelRow row : bucket.models) {
            int s = seriesOf(series, row.model);
            Long cur = sums.get(s);
            sums.put(s, (cur == null ? 0 : cur) + row.total);
        }
        List<Integer> order = new ArrayList<>(sums.keySet());
        Collections.sort(order, (a, b) -> Integer.compare(a == 0 ? 99 : a, b == 0 ? 99 : b));
        List<Stack> out = new ArrayList<>();
        for (int s : order) out.add(new Stack(s, sums.get(s)));
        return out;
    }

    /** A drawn segment in pixels: `low` is the bottom edge, `high` the top (low > high). */
    static final class Segment {
        final int series;
        final double low, high;
        final boolean top;
        Segment(int series, double low, double high, boolean top) {
            this.series = series; this.low = low; this.high = high; this.top = top;
        }
    }

    /**
     * Segments of one column, as in columnChart(): `gap` px of the surface between segments; a
     * segment thinner than `minVisible` px is not drawn (it stays in the tooltip). The last drawn
     * segment is the top one (rounded corners).
     */
    static List<Segment> segments(List<Stack> stacks, double topValue, double plotTop, double plotHeight, double gap, double minVisible) {
        List<double[]> parts = new ArrayList<>();
        List<Integer> seriesList = new ArrayList<>();
        double sum = 0;
        double scaleTop = topValue > 0 ? topValue : 1;
        for (int at = 0; at < stacks.size(); at++) {
            Stack st = stacks.get(at);
            double low = plotTop + plotHeight - sum / scaleTop * plotHeight - (at > 0 ? gap : 0);
            sum += st.total;
            double high = plotTop + plotHeight - sum / scaleTop * plotHeight;
            if (low - high >= minVisible) {
                parts.add(new double[] {low, high});
                seriesList.add(st.series);
            }
        }
        List<Segment> out = new ArrayList<>();
        for (int i = 0; i < parts.size(); i++) {
            out.add(new Segment(seriesList.get(i), parts.get(i)[0], parts.get(i)[1], i == parts.size() - 1));
        }
        return out;
    }

    /** A row of the share list: the series, its label and total. */
    static final class SharePart {
        final int series;
        final String name;
        final long total;
        final int models;
        SharePart(int series, String name, long total, int models) {
            this.series = series; this.name = name; this.total = total; this.models = models;
        }
        /** "其他模型 (3)" for the merged grey row. */
        String label() { return series > 0 ? name : name + " (" + models + ")"; }
    }

    /** shareList(): one row per coloured model, the rest merged into "other models" at the end. */
    static List<SharePart> shares(Period period, Map<String, Integer> series, boolean zh) {
        Map<String, long[]> parts = new LinkedHashMap<>();
        Map<String, Integer> seriesByKey = new LinkedHashMap<>();
        Map<String, String> names = new LinkedHashMap<>();
        for (ModelRow row : period.models) {
            int s = seriesOf(series, row.model);
            String key = s > 0 ? row.model : "";
            long[] part = parts.get(key);
            if (part == null) {
                part = new long[2];
                parts.put(key, part);
                seriesByKey.put(key, s);
                names.put(key, s > 0 ? modelName(row.model, zh) : (zh ? "其他模型" : "Other models"));
            }
            part[0] += row.total;
            part[1]++;
        }
        List<SharePart> out = new ArrayList<>();
        for (Map.Entry<String, long[]> e : parts.entrySet()) {
            if (e.getValue()[0] <= 0) continue;
            out.add(new SharePart(seriesByKey.get(e.getKey()), names.get(e.getKey()), e.getValue()[0], (int) e.getValue()[1]));
        }
        Collections.sort(out, (a, b) -> {
            int oa = a.series == 0 ? 1 : 0, ob = b.series == 0 ? 1 : 0;
            if (oa != ob) return Integer.compare(oa, ob);
            return Long.compare(b.total, a.total);
        });
        return out;
    }

    /** Width of a share bar as a fraction of the track: the largest row fills it, at least 0.5 %. */
    static double shareBarFraction(long total, long largest) {
        return Math.max(0.005, total / (double) Math.max(1, largest));
    }

    /** A tooltip line: series, model name and exact total. */
    static final class TipRow {
        final int series;
        final String name;
        final long total;
        TipRow(int series, String name, long total) { this.series = series; this.name = name; this.total = total; }
    }

    static List<TipRow> tipRows(Bucket bucket, Map<String, Integer> series, boolean zh) {
        List<TipRow> out = new ArrayList<>();
        for (ModelRow row : bucket.models) {
            if (row.total > 0) out.add(new TipRow(seriesOf(series, row.model), modelName(row.model, zh), row.total));
        }
        return out;
    }

    /** The tooltip's total line: "合计 Token · 1,757 次请求" / "tokens in total · 1 request". */
    static String tipTotalLabel(Bucket bucket, boolean zh) {
        String requests = withRequestUnit(formatExact(bucket.requests), bucket.requests, zh);
        return (zh ? "合计 Token" : "tokens in total") + " · " + requests;
    }

    /** Largest bucket total of the period (0 without buckets). */
    static long maxBucket(Period p) {
        long max = 0;
        if (p != null && p.buckets != null) for (Bucket b : p.buckets) max = Math.max(max, b.total);
        return max;
    }
}
