// RokBot Android usage page: UsageActivity (range switch, filters, Canvas charts, requests, CSV
// export), UsageChartView, UsageRangeSheet, HostApiClient.getUsageReport / exportUsageCsv /
// getUsage and the pure UsageModel (ports usage-charts.js / usage-format.js) and UsageReport
// (parses GET /local/usage/report, docs/usage-report.md). Both run on a plain JVM (org.json shim,
// no android.jar); their output is compared with the JavaScript originals on the same inputs
// (usageSummary() and usageReport() over test ledgers and the demo ledger).
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatCount, formatExactCount, withRequestUnit } from '../../host/server/public/usage-format.js';
import { formatShare, usageSeries, usageTicks } from '../../host/server/public/usage-charts.js';
import { usageSummary } from '../../host/runtime/usage-ledger.mjs';
import { usageReport } from '../../host/runtime/usage-report.mjs';
import { DEMO_NAMES, writeDemoLedger } from '../../host/tests/fixtures/usage-demo.mjs';
import { MockHostServer } from './mock-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(NATIVE_ROOT, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('Usage wiring: range switch, report API, Canvas views, filters, export and the older-Host fallback', () => {
  const api = read('HostApiClient.java');
  const fn = api.slice(api.indexOf('public static JSONObject getUsage(Context context, String period)'));
  const body = fn.slice(0, fn.indexOf('\n    }\n') + 6);
  assert.ok(body.length > 50, 'HostApiClient.getUsage(Context, String period) exists');
  assert.match(body, /"\/local\/usage\?timeZone=" \+ encodeQuery\(tz\)/);
  assert.match(body, /path \+= "&period=" \+ encodeQuery\(period\.trim\(\)\);/, 'period=today|7d|30d is passed as a query parameter');
  assert.match(api, /public static JSONObject getUsage\(Context context\) throws Exception \{/, 'the original getUsage(Context) stays');
  assert.match(api, /public static JSONObject getUsageReport\(Context context, String range, String from, String to,\s*Map<String, String> filters, int offset, int limit\) throws Exception \{/);
  assert.match(api, /UsageReport\.query\(tz, range, from, to, filters, offset, limit, false\)/, 'report path built by the JVM-tested UsageReport.query');
  assert.match(api, /public static JSONObject exportUsageCsv\(Context context, String range, String from, String to,\s*Map<String, String> filters\) throws Exception \{/);
  assert.match(api, /UsageReport\.query\(tz, range, from, to, filters, 0, 0, true\)/, 'export=csv');

  const ua = read('UsageActivity.java');
  assert.match(ua, /\{"today", "今天", "Today"\},\s*\{"7d", "7 天", "7 days"\},\s*\{"30d", "30 天", "30 days"\},\s*\{"all", "全部", "All"\},\s*\{"custom", "自定义", "Custom"\}/,
    'segmented control: today / 7 / 30 days / all / custom');
  assert.match(ua, /tab\.setOnClickListener\(v -> selectRange\(id\)\);/);
  assert.match(ua, /UsageRangeSheet\.show\(this, today, from, to,/, 'custom range: own calendar sheet');
  assert.match(ua, /HostApiClient\.getUsageReport\(this, range, from, to, filters, offset, UsageReport\.PAGE_SIZE\)/);
  assert.match(ua, /e\.statusCode == 404[\s\S]*HostApiClient\.getUsage\(this, null\)/, 'older Hosts (404) fall back to GET /local/usage');
  assert.match(ua, /升级 Host 后可查看详细用量/);
  assert.match(ua, /mSeries = UsageModel\.series\(legacy\);/, 'legacy colours still come from the longest (30-day) period');
  assert.match(ua, /new UsageChartView\(this, mP, mZh\)/);
  assert.match(ua, /chart\.setReport\(r, mMode, animate\)/);
  assert.match(ua, /new UsageChartView\.ShareBar\(/);
  assert.match(ua, /new UsageChartView\.Donut\(/);
  assert.match(ua, /new UsageChartView\.StackBar\(/);
  assert.match(ua, /new UsageChartView\.Skeleton\(/, 'loading skeleton, no ProgressBar');
  assert.match(ua, /ChoiceField\.showSheet\(this, t\("筛选", "Filter"\)/, 'filter menu is the RokBot choice sheet');
  assert.match(ua, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(ua, /HostApiClient\.exportUsageCsv\(this, range, from, to, filters\)/);
  assert.match(ua, /UiChrome\.palette\(this\)/);
  assert.match(ua, /makeVectorIconButton\(this, "refresh", "refresh_usage_button"/, 'refresh header button kept');
  assert.match(ua, /makeVectorIconButton\(this, "download", "export_usage_csv_button"/, 'export header button');
  assert.match(ua, /setOnLongClickListener/, 'long press shows the exact number');
  assert.match(ua, /new HorizontalScrollView\(this\)/, 'filter chips and sort chips scroll sideways');
  assert.match(ua, /mContent\.animate\(\)\.alpha\(1f\)/, 'content fades in after a range change');
  for (const label of ['"总花费"', '"总 Token"', '"请求次数"', '"平均耗时"', '"失败率"', '"缓存命中率"', '"Token 构成"', '"趋势"', '"维度拆分"',
    '"请求明细"', '"上一页"', '"下一页"', '"按模型"', '"按类型"', '"筛选"', '"重试"', '"请求数"', '"输入"', '"输出"', '"模型占比"',
    '"Total tokens"', '"Requests"', '"Cache hit rate"', '"Share by model"', '"Breakdown"'])
    assert.ok(ua.includes(label), `label ${label}`);
  for (const name of ['UsageActivity.java', 'UsageReport.java', 'UsageRangeSheet.java', 'UsageChartView.java']) {
    const src = read(name);
    assert.doesNotMatch(src, /WebView|ProgressBar|Spinner|DatePicker/, `${name}: no platform pickers / spinners`);
    assert.doesNotMatch(src, /Grok/i, `${name}: no Grok`);
    assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name}: no emoji`);
  }

  const chart = read('UsageChartView.java');
  assert.match(chart, /final class UsageChartView extends View/);
  assert.match(chart, /protected void onDraw\(Canvas canvas\)/);
  assert.match(chart, /canvas\.drawPath\(mPath, mFill\)/);
  assert.match(chart, /canvas\.drawPath\(mArea, mFill\)/, 'stacked areas by type');
  assert.match(chart, /MAX_BAR = 24f, RADIUS = 4f, GAP = 2f/);
  assert.match(chart, /public boolean onTouchEvent\(MotionEvent event\)/, 'tapping a column shows the callout');
  assert.match(chart, /drawTip\(canvas, mPeriod\.buckets\.get\(mActive\)/);
  assert.match(chart, /drawReportTip\(canvas, mReport\.buckets\.get\(mActive\)/);

  const sheet = read('UsageRangeSheet.java');
  assert.match(sheet, /final class UsageRangeSheet extends Dialog/);
  assert.match(sheet, /UsageReport\.pickDay\(mFrom, mTo, day\)/);
  assert.match(sheet, /UsageReport\.validateCustom\(/);

  for (const name of ['UsageModel.java', 'UsageReport.java'])
    assert.doesNotMatch(read(name), /^import android\./m, `${name} stays JVM-only`);
});

test('Usage palette: the 7 series colours + grey match usage-charts.css, light and dark', () => {
  const css = fs.readFileSync(path.join(REPO_ROOT, 'host/server/public/usage-charts.css'), 'utf8');
  const block = selector => {
    const start = css.indexOf(selector);
    return css.slice(start, css.indexOf('}', start));
  };
  const colours = text => Array.from({ length: 8 }, (_, i) => text.match(new RegExp(`--rok-usage-c${i}: (#[0-9a-f]{6})`, 'i'))[1].toUpperCase());
  const light = colours(block('.rok-usage-view {'));
  const dark = colours(block(':root[data-theme="dark"] .rok-usage-view'));
  const model = read('UsageModel.java');
  const javaArray = name => {
    const body = model.slice(model.indexOf(`static final int[] ${name} = {`));
    return [...body.slice(0, body.indexOf('};')).matchAll(/0xFF([0-9A-F]{6})/g)].map(m => '#' + m[1]);
  };
  assert.deepEqual(javaArray('LIGHT_COLORS'), light);
  assert.deepEqual(javaArray('DARK_COLORS'), dark);
});

// --------------------------------------------------------------------------- JVM

const ORG_JSON_SHIM = {
  'org/json/JSONObject.java': `package org.json;
import java.util.*;
public class JSONObject {
  public static final Object NULL = new Object() { @Override public String toString() { return "null"; } };
  final Map<String, Object> map;
  public JSONObject(String json) { this(asMap(Mini.parse(json))); }
  @SuppressWarnings("unchecked") static Map<String, Object> asMap(Object o) { if (!(o instanceof Map)) throw new RuntimeException("not an object"); return (Map<String, Object>) o; }
  JSONObject(Map<String, Object> m) { map = m; }
  public boolean has(String k) { return map.containsKey(k); }
  public boolean isNull(String k) { Object v = map.get(k); return v == null || v == NULL; }
  public String optString(String k, String d) { Object v = map.get(k); return v == null || v == NULL ? d : String.valueOf(v); }
  public long optLong(String k, long d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).longValue() : d; }
  public int optInt(String k, int d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).intValue() : d; }
  public double optDouble(String k, double d) { Object v = map.get(k); return v instanceof Number ? ((Number) v).doubleValue() : d; }
  public boolean optBoolean(String k, boolean d) { Object v = map.get(k); return v instanceof Boolean ? (Boolean) v : d; }
  @SuppressWarnings("unchecked") public JSONObject optJSONObject(String k) { Object v = map.get(k); return v instanceof Map ? new JSONObject((Map<String, Object>) v) : null; }
  public Iterator<String> keys() { return map.keySet().iterator(); }
  @SuppressWarnings("unchecked") public JSONArray optJSONArray(String k) { Object v = map.get(k); return v instanceof List ? new JSONArray((List<Object>) v) : null; }
}`,
  'org/json/JSONArray.java': `package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> list;
  JSONArray(List<Object> l) { list = l; }
  public int length() { return list.size(); }
  public String optString(int i, String d) { Object v = i >= 0 && i < list.size() ? list.get(i) : null; return v == null || v == JSONObject.NULL ? d : String.valueOf(v); }
  @SuppressWarnings("unchecked") public JSONObject optJSONObject(int i) { Object v = i >= 0 && i < list.size() ? list.get(i) : null; return v instanceof Map ? new JSONObject((Map<String, Object>) v) : null; }
}`,
  'org/json/Mini.java': `package org.json;
import java.util.*;
final class Mini {
  final String s; int i;
  Mini(String s) { this.s = s; }
  static Object parse(String s) { return new Mini(s).val(); }
  void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
  Object val() {
    ws(); char c = s.charAt(i);
    if (c == '{') { i++; Map<String, Object> m = new LinkedHashMap<>(); ws(); if (s.charAt(i) == '}') { i++; return m; }
      while (true) { ws(); String k = str(); ws(); i++; m.put(k, val()); ws(); if (s.charAt(i++) == '}') return m; } }
    if (c == '[') { i++; List<Object> l = new ArrayList<>(); ws(); if (s.charAt(i) == ']') { i++; return l; }
      while (true) { l.add(val()); ws(); if (s.charAt(i++) == ']') return l; } }
    if (c == '"') return str();
    if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
    if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
    if (s.startsWith("null", i)) { i += 4; return JSONObject.NULL; }
    int start = i; while (i < s.length() && "0123456789.-+eE".indexOf(s.charAt(i)) >= 0) i++;
    String n = s.substring(start, i);
    return n.matches("-?\\\\d+") ? (Object) Long.parseLong(n) : (Object) Double.parseDouble(n);
  }
  String str() {
    i++; StringBuilder b = new StringBuilder();
    while (true) { char c = s.charAt(i++); if (c == '"') return b.toString();
      if (c == '\\\\') { char e = s.charAt(i++); if (e == 'u') { b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
        else b.append(e == 'n' ? '\\n' : e == 't' ? '\\t' : e == 'r' ? '\\r' : e); }
      else b.append(c); }
  }
}`,
};

const COUNT_VALUES = [0, 1, 999, 1000, 1234, 9999, 10000, 12345, 41_350, 41_355, 99_994, 99_995, 99_999, 100_000, 999_999, 1_000_000, 1_234_567, 12_345_678,
  99_999_499, 99_999_500, 99_995_000, 99_999_999, 100_000_000, 320_000_000, 999_999_999, 1_000_000_000, 1_900_000_000, 2_500_000_000,
  999_950_000_000, 999_999_999_999, 1_000_000_000_000, 1_234_567_890_123, -12_345, 1.4, 1.5, 9999.5];
const SHARE_PAIRS = [[0, 100], [5, 0], [1, 10000], [1, 1000], [1, 3], [2, 3], [45.3, 100], [9.95, 100], [9.96, 100], [99.96, 100], [100, 100], [5, 8], [1, 16]];
const TICK_MAXES = [0, 1, 3, 7, 10, 42, 99, 100, 101, 1234, 9999, 41_350, 52_200, 320_012_345, 999_999, 2_400_000_000];
const javaDouble = v => Number.isInteger(v) ? `${v}d` : String(v);

// A ledger with 9 models: "small-today" is the largest model today but only 5th over 30 days, so
// its colour must come from the 30-day ranking; models 8 and 9 merge into "other models".
function writeLedger(dir) {
  const rows = [];
  let id = 0;
  const add = (at, model, input, output, cached = 0, write = 0) => rows.push({ id: `r${++id}`, at, model, kind: 'chat', input, output,
    total: input + output, cached, cacheWrite: write, reasoning: 0 });
  // Asia/Shanghai, "today" = 2026-11-26; 01:00Z = 09:00 local.
  const big = [['alpha', 900_000], ['beta', 800_000], ['gamma', 700_000], ['delta', 600_000], ['small-today', 500_000],
    ['zeta', 400_000], ['eta', 300_000], ['theta', 200_000], ['iota', 100_000]];
  for (const [model, tokens] of big) add('2026-11-10T03:00:00.000Z', model, tokens - 1000, 1000, Math.floor(tokens / 4));
  add('2026-11-24T05:00:00.000Z', 'alpha', 41_000, 350, 20_000, 500);
  add('2026-11-26T01:10:00.000Z', 'small-today', 20_000, 5_000, 10_000);
  add('2026-11-26T01:40:00.000Z', 'alpha', 3_000, 500, 1_000);
  add('2026-11-26T05:00:00.000Z', 'theta', 700, 300);
  add('2026-11-26T05:30:00.000Z', 'iota', 80, 20);
  fs.mkdirSync(dir, { recursive: true });
  const byDay = new Map();
  for (const row of rows) byDay.set(row.at.slice(0, 10), [...(byDay.get(row.at.slice(0, 10)) ?? []), row]);
  for (const [day, list] of byDay) fs.writeFileSync(path.join(dir, `${day}.jsonl`), list.map(r => JSON.stringify(r)).join('\n') + '\n');
}

test('Usage model (JVM): formatting, ticks, shares, 30-day colours, bucket parsing and older Hosts', async () => {
  const sdkRoot = [process.env.ANDROID_HOME, '/Users/lianqishi/Library/Android/sdk', '/Volumes/ORICO/android/sdk']
    .find(d => d && fs.existsSync(path.join(d, 'platforms/android-36/android.jar')));
  const javacBin = ['javac', '/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/javac']
    .find(bin => { try { return cp.spawnSync(bin, ['-version']).status === 0; } catch { return false; } });
  assert.ok(sdkRoot && javacBin, 'Android SDK and JDK required for JVM verification');
  const javaBin = javacBin.endsWith('javac') ? javacBin.slice(0, -1) : 'java';
  const androidJar = path.join(sdkRoot, 'platforms/android-36/android.jar');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rokbot-usage-charts-'));
  try {
    // 1. The whole companion (with UsageActivity / UsageChartView) still compiles against android.jar.
    const files = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.java')) files.push(full);
      }
    };
    walk(path.join(NATIVE_ROOT, 'companion/compile-stubs/src/main/java'));
    walk(path.join(NATIVE_ROOT, 'companion/src/main/java'));
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-nowarn', '-cp', androidJar, '-d', path.join(tmp, 'android-classes'), ...files], { stdio: 'pipe' });

    // 2. Fixtures from the real Host ledger code.
    const ledger = path.join(tmp, 'usage');
    writeLedger(ledger);
    const now = new Date('2026-11-26T08:00:00.000Z');
    const full = await usageSummary(ledger, 'Asia/Shanghai', now);
    const week = await usageSummary(ledger, 'Asia/Shanghai', now, { period: '7d' });
    const noBuckets = { ...full, periods: full.periods.map(({ buckets, unit, ...rest }) => rest) };
    const legacy = { total: 41350, input: 12450, output: 28900, period: '30d', timeZone: 'UTC' };
    const fixtures = { full, week, noBuckets, legacy };

    // Report fixtures (GET /local/usage/report) from the real report code over the demo ledger.
    const demo = path.join(tmp, 'demo');
    const reportNow = new Date('2026-11-27T06:00:00.000Z');
    await writeDemoLedger(demo, { now: reportNow });
    const rep = options => usageReport(demo, { timeZone: 'Asia/Shanghai', now: reportNow, names: DEMO_NAMES, limit: 20, ...options });
    const reports = {
      r7d: await rep({ range: '7d' }),
      rToday: await rep({ range: 'today' }),
      rAll: await rep({ range: 'all' }),
      rFiltered: await rep({ range: '30d', filters: { agent: 'agent-writer', kind: 'chat' } }),
      rNone: await rep({ range: '30d', filters: { agent: '(none)' } }),
      rLong: await rep({ range: 'custom', from: '2026-07-01', to: '2026-11-27' }),
      rEmpty: await rep({ range: 'custom', from: '2020-01-01', to: '2020-01-05' }),
      rPage: await rep({ range: '7d', offset: 20 }),
      rLast: await rep({ range: '7d', offset: 180 }),
      rPriced: await rep({ range: '7d', prices: { 'deepseek-v3.2': { input: 2, output: 3, cached: 0.5 } } }),
    };
    Object.assign(fixtures, reports);
    for (const [name, value] of Object.entries(fixtures)) fs.writeFileSync(path.join(tmp, `${name}.json`), JSON.stringify(value));

    // 3. UsageModel + an org.json shim + the harness on a plain JVM (no android.jar: no android.* use).
    const jvmSrc = path.join(tmp, 'jvm-src');
    for (const [rel, body] of Object.entries(ORG_JSON_SHIM)) {
      fs.mkdirSync(path.dirname(path.join(jvmSrc, rel)), { recursive: true });
      fs.writeFileSync(path.join(jvmSrc, rel), body);
    }
    const harness = path.join(jvmSrc, 'dev/rokbot/nativeapp/UsageModelHarness.java');
    fs.mkdirSync(path.dirname(harness), { recursive: true });
    fs.writeFileSync(harness, `package dev.rokbot.nativeapp;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import org.json.JSONObject;

public class UsageModelHarness {
    static UsageModel.Usage load(String dir, String name) throws Exception {
        return UsageModel.parse(new JSONObject(new String(Files.readAllBytes(Paths.get(dir, name + ".json")), StandardCharsets.UTF_8)));
    }
    static void out(String... parts) { System.out.println(String.join("|", parts)); }
    static String join(double[] v) { StringBuilder b = new StringBuilder(); for (double d : v) { if (b.length() > 0) b.append(','); b.append(d == Math.rint(d) ? String.valueOf((long) d) : String.valueOf(d)); } return b.toString(); }

    public static void main(String[] a) throws Exception {
        double[] counts = {${COUNT_VALUES.map(javaDouble).join(', ')}};
        for (double v : counts) {
            out("count", "zh", String.valueOf(v), UsageModel.formatCount(v, true));
            out("count", "en", String.valueOf(v), UsageModel.formatCount(v, false));
            out("exact", String.valueOf(v), UsageModel.formatExact(v));
        }
        double[][] shares = {${SHARE_PAIRS.map(([p, w]) => `{${javaDouble(p)}, ${javaDouble(w)}}`).join(', ')}};
        for (double[] s : shares) out("share", String.valueOf(s[0]), String.valueOf(s[1]), UsageModel.formatShare(s[0], s[1]));
        double[] maxes = {${TICK_MAXES.map(javaDouble).join(', ')}};
        for (double m : maxes) out("ticks", String.valueOf(m), join(UsageModel.ticks(m)));
        for (long r : new long[] {1, 2, 1757, 27_700}) {
            out("req", "zh", String.valueOf(r), UsageModel.withRequestUnit(UsageModel.formatCount(r, true), r, true));
            out("req", "en", String.valueOf(r), UsageModel.withRequestUnit(UsageModel.formatCount(r, false), r, false));
        }

        for (String name : new String[] {"full", "week", "noBuckets", "legacy"}) {
            UsageModel.Usage u = load(a[0], name);
            Map<String, Integer> series = UsageModel.series(u);
            out("usage", name, String.valueOf(u.legacy), String.valueOf(u.periods.size()), u.timeZone);
            for (Map.Entry<String, Integer> e : series.entrySet()) out("series", name, e.getKey(), String.valueOf(e.getValue()));
            for (UsageModel.Period p : u.periods) {
                out("period", name, p.id, String.valueOf(p.days), p.unit, p.buckets == null ? "null" : String.valueOf(p.buckets.size()),
                    String.valueOf(p.total), String.valueOf(p.requests), String.valueOf(p.hasRequests), UsageModel.cacheHitRate(p),
                    String.valueOf(UsageModel.isEmpty(p)), String.valueOf(p.models.size()), UsageModel.rangeLabel(p),
                    UsageModel.formatCount(p.total, true), UsageModel.formatCount(p.total, false), String.valueOf(UsageModel.maxBucket(p)));
                for (UsageModel.SharePart s : UsageModel.shares(p, series, true))
                    out("sharepart", name, p.id, String.valueOf(s.series), s.label(), String.valueOf(s.total), UsageModel.formatShare(s.total, p.total));
                if (p.buckets == null) continue;
                boolean hourly = p.hourly();
                for (int i = 0; i < p.buckets.size(); i++) {
                    UsageModel.Bucket b = p.buckets.get(i);
                    if (b.total == 0 && i != 0 && i != p.buckets.size() - 1) continue;
                    StringBuilder st = new StringBuilder();
                    for (UsageModel.Stack s : UsageModel.stacks(b, series)) st.append(s.series).append(':').append(s.total).append(' ');
                    StringBuilder tips = new StringBuilder();
                    for (UsageModel.TipRow r : UsageModel.tipRows(b, series, false)) tips.append(r.series).append(':').append(r.name).append(':').append(r.total).append(' ');
                    out("bucket", name, p.id, String.valueOf(i), b.start, String.valueOf(b.total), String.valueOf(b.requests),
                        UsageModel.axisLabel(b.start, hourly), UsageModel.titleLabel(b.start, hourly, true), UsageModel.titleLabel(b.start, hourly, false),
                        st.toString().trim(), tips.toString().trim(), UsageModel.tipTotalLabel(b, true), UsageModel.tipTotalLabel(b, false));
                }
            }
        }

        // Column geometry: 2 px gap above the first segment, thin segments dropped, last one rounded.
        List<UsageModel.Stack> stacks = Arrays.asList(new UsageModel.Stack(1, 100), new UsageModel.Stack(2, 50), new UsageModel.Stack(0, 0));
        for (UsageModel.Segment s : UsageModel.segments(stacks, 200, 8, 168, 2, 0.75))
            out("seg", String.valueOf(s.series), String.valueOf(s.low), String.valueOf(s.high), String.valueOf(s.top));
        for (double step : new double[] {3, 10, 14, 20, 40}) out("every", "hour", String.valueOf(step), String.valueOf(UsageModel.labelEvery(true, step)));
        for (double step : new double[] {8, 10, 30, 44, 60}) out("every", "day", String.valueOf(step), String.valueOf(UsageModel.labelEvery(false, step)));
        StringBuilder shown = new StringBuilder();
        for (int i = 0; i < 30; i++) if (UsageModel.showLabel(false, i, 30, 5)) shown.append(i).append(',');
        out("show", "day", shown.toString());
        shown.setLength(0);
        for (int i = 0; i < 24; i++) if (UsageModel.showLabel(true, i, 24, 6)) shown.append(i).append(',');
        out("show", "hour", shown.toString());
        out("bar", String.valueOf(UsageModel.shareBarFraction(1, 1000)), String.valueOf(UsageModel.shareBarFraction(500, 1000)));
        out("color", Integer.toHexString(UsageModel.seriesColor(0, false)), Integer.toHexString(UsageModel.seriesColor(1, true)), Integer.toHexString(UsageModel.seriesColor(9, false)));

        // ------------------------------------------------------------ usage report (UsageReport)
        for (String name : new String[] {"r7d", "rToday", "rAll", "rFiltered", "rNone", "rLong", "rEmpty", "rPage", "rLast", "rPriced"}) {
            UsageReport.Report r = UsageReport.parse(new JSONObject(new String(Files.readAllBytes(Paths.get(a[0], name + ".json")), StandardCharsets.UTF_8)));
            UsageReport.Totals s = r.totals;
            out("report", name, String.valueOf(r.version), r.rangeId, r.from, r.to, String.valueOf(r.days), r.unit, String.valueOf(r.previousFrom),
                String.valueOf(r.previousTo), r.timeZone, String.valueOf(r.priced), String.valueOf(r.buckets.size()), String.join(",", r.series),
                String.valueOf(r.requestTotal), String.valueOf(r.offset), String.valueOf(r.items.size()), String.valueOf(r.empty()),
                UsageReport.rangeLine(r, true), UsageReport.pageLabel(r.offset, r.items.size(), r.requestTotal, true),
                UsageReport.pageLabel(r.offset, r.items.size(), r.requestTotal, false), String.valueOf(UsageReport.hasPrevPage(r)),
                String.valueOf(UsageReport.hasNextPage(r)), String.valueOf(r.changes == null), String.valueOf(r.recordedRows), String.valueOf(r.recordedAgent));
            out("totals", name, String.valueOf(s.requests), String.valueOf(s.total), String.valueOf(s.input), String.valueOf(s.output), String.valueOf(s.cached),
                String.valueOf(s.reasoning), String.valueOf(s.failed), String.valueOf(s.durationRecorded), String.valueOf(s.statusRecorded),
                UsageReport.formatDuration(s.avgDurationMs, true), UsageReport.formatRate(s.failureRate, UsageReport.missing(true)),
                UsageReport.formatRate(s.cacheHitRate, "-"), UsageReport.formatCost(s.cost, r.priced, true),
                String.valueOf(UsageReport.recordedNote(s.durationRecorded, s.requests, true)), String.valueOf(UsageReport.recordedNote(s.statusRecorded, s.requests, false)));
            long[] comp = UsageReport.composition(s);
            out("comp", name, comp[0] + "," + comp[1] + "," + comp[2] + "," + comp[3]);
            for (String key : new String[] {"requests", "total", "cost", "avgDurationMs", "failureRate"}) {
                Double c = UsageReport.change(r, key);
                out("change", name, key, String.valueOf(c), UsageReport.formatChange(c), String.valueOf(UsageReport.changeTone(key, c)));
            }
            for (Map.Entry<String, String> f : r.filters.entrySet())
                out("filter", name, f.getKey(), f.getValue(), UsageReport.chipLabel(r, f.getKey(), f.getValue(), true), UsageReport.chipLabel(r, f.getKey(), f.getValue(), false));
            for (String dim : UsageReport.DIMENSIONS) {
                List<UsageReport.Row> rows = r.rows(dim);
                for (int i = 0; i < rows.size(); i++) {
                    UsageReport.Row row = rows.get(i);
                    out("row", name, dim, String.valueOf(i), row.key, UsageReport.valueLabel(dim, row.key, row.label, true), UsageReport.valueLabel(dim, row.key, row.label, false),
                        UsageModel.formatShare(row.share, 1), String.valueOf(row.total), String.valueOf(row.requests), String.valueOf(UsageReport.rowSeries(r, dim, row, i)),
                        UsageReport.formatDuration(row.avgDurationMs, true), UsageReport.formatRate(row.failureRate, "none"), UsageReport.formatCost(row.cost, r.priced, false));
                }
                for (String column : new String[] {"total", "requests", "avgDurationMs", "failureRate", "cost", "name"}) {
                    for (boolean desc : new boolean[] {true, false}) {
                        StringBuilder keys = new StringBuilder();
                        for (UsageReport.Row row : UsageReport.sortRows(rows, column, desc, dim, false)) keys.append(row.key).append(',');
                        out("sorted", name, dim, column, String.valueOf(desc), keys.toString());
                    }
                }
            }
            for (String key : UsageReport.FILTER_KEYS) {
                List<UsageReport.Option> opts = r.options.get(key);
                StringBuilder o = new StringBuilder();
                for (UsageReport.Option opt : opts) o.append(UsageReport.valueLabel(key, opt.key, opt.label, true)).append(':').append(opt.requests).append(',');
                out("opt", name, key, o.toString());
            }
            for (String mode : new String[] {"model", "type", "requests"}) out("max", name, mode, String.valueOf(UsageReport.trendMax(r, mode)));
            for (int i = 0; i < r.buckets.size(); i++) {
                UsageReport.Bucket b = r.buckets.get(i);
                StringBuilder st = new StringBuilder();
                for (UsageModel.Stack x : UsageReport.modelStacks(r, b)) st.append(x.series).append(':').append(x.total).append(' ');
                long[] ty = UsageReport.typeStack(b), rq = UsageReport.requestStack(b);
                out("rb", name, String.valueOf(i), b.start, UsageReport.axisLabel(b.start, r.unit, true), UsageReport.axisLabel(b.start, r.unit, false),
                    UsageReport.titleLabel(b.start, r.unit, true), UsageReport.titleLabel(b.start, r.unit, false), st.toString().trim(),
                    ty[0] + "," + ty[1] + "," + ty[2], rq[0] + "," + rq[1], String.valueOf(b.total), String.valueOf(b.requests), String.valueOf(b.avgDurationMs));
            }
            for (UsageReport.Request q : r.items) {
                out("item", name, q.id, UsageReport.requestTime(q.at, r.timeZone, r.today), UsageReport.kindLabel(q.kind, true), UsageReport.statusLabel(q.status, true),
                    UsageReport.formatDuration(q.durationMs == null ? null : (double) q.durationMs, true), String.valueOf(q.total), String.valueOf(q.agent),
                    String.valueOf(q.profile), String.valueOf(q.error), UsageReport.formatCost(q.cost, r.priced, true));
            }
        }

        // Pure helpers.
        for (double ms : new double[] {0, 1, 850, 999.4, 999.6, 1000, 1234, 7401, 9960, 9999, 10000, 12345, 59400, 59600, 65000, 3599000, 3600000, 7380000})
            out("dur", String.valueOf(ms), UsageReport.formatDuration(ms, true), UsageReport.formatDuration(ms, false));
        out("dur", "null", UsageReport.formatDuration(null, true), UsageReport.formatDuration(null, false));
        for (double c : new double[] {0, 0.0004, -0.0004, 0.123, -0.047, 0.12345, -0.21212121, 1, 2.5, 9.996, -1, 0.00049, 0.00051})
            out("chg", String.valueOf(c), UsageReport.formatChange(c), String.valueOf(UsageReport.changeTone("avgDurationMs", c)),
                String.valueOf(UsageReport.changeTone("failureRate", c)), String.valueOf(UsageReport.changeTone("total", c)));
        out("chg", "null", UsageReport.formatChange(null), String.valueOf(UsageReport.changeTone("failureRate", null)));
        for (double c : new double[] {0, 0.00004, 0.0123, 0.5, 1.23456, 12.345, 1234.5})
            out("cost", String.valueOf(c), UsageReport.formatCost(c, true, true));
        out("cost", "null", UsageReport.formatCost(null, true, true), UsageReport.formatCost(null, false, true), UsageReport.formatCost(1.0, false, false));
        for (double rate : new double[] {0, 0.0004, 0.03030303, 0.6279544898, 1}) out("rate", String.valueOf(rate), UsageReport.formatRate(rate, "-"));
        for (String k : new String[] {"chat", "suggestions", "completion", "autocomplete", "title", "test", "summary", "memory", "subagent", "automation", "classifier", "review", "weird-kind", "(none)"})
            out("kind", k, UsageReport.kindLabel(k, true), UsageReport.kindLabel(k, false));
        out("kind", "null", UsageReport.kindLabel(null, true));
        for (String st : new String[] {"ok", "error", "cancelled", "(none)", "odd"}) out("status", st, UsageReport.statusLabel(st, true), UsageReport.statusLabel(st, false));
        Map<String, String> qf = new LinkedHashMap<>();
        qf.put("status", "error");
        qf.put("agent", "(none)");
        qf.put("model", "claude sonnet/4.5");
        out("query", UsageReport.query("Asia/Shanghai", "7d", null, null, qf, 40, 20, false));
        out("query", UsageReport.query("America/New_York", "custom", "2026-11-01", "2026-11-27", null, -5, 999, false));
        out("query", UsageReport.query("UTC", null, null, null, new HashMap<String, String>(), 0, 0, true));
        out("days", UsageReport.addDays("2026-11-27", 5), UsageReport.addDays("2024-02-28", 1), UsageReport.addDays("2026-01-01", -1),
            String.valueOf(UsageReport.daysBetween("2026-11-21", "2026-11-27")), String.valueOf(UsageReport.daysBetween("2025-10-24", "2026-11-27")),
            String.valueOf(UsageReport.daysInMonth(2024, 2)), String.valueOf(UsageReport.daysInMonth(2026, 2)), String.valueOf(UsageReport.daysInMonth(2026, 11)),
            String.valueOf(UsageReport.firstWeekday(2026, 11)), String.valueOf(UsageReport.firstWeekday(2026, 6)), String.valueOf(UsageReport.validDate("2026-02-30")),
            String.valueOf(UsageReport.validDate("2026-02-28")), UsageReport.monthTitle(2026, 11, true), UsageReport.monthTitle(2026, 11, false));
        out("valid", String.valueOf(UsageReport.validateCustom("2026-11-01", "2026-11-27", "2026-11-27", true)),
            String.valueOf(UsageReport.validateCustom("2026-11-27", "2026-11-01", "2026-11-27", true)),
            String.valueOf(UsageReport.validateCustom("2026-11-01", "2026-11-28", "2026-11-27", true)),
            String.valueOf(UsageReport.validateCustom("2025-10-23", "2026-11-27", "2026-11-27", true)),
            String.valueOf(UsageReport.validateCustom("2025-10-24", "2026-11-27", "2026-11-27", true)),
            String.valueOf(UsageReport.validateCustom(null, "2026-11-27", "2026-11-27", false)));
        String[] p1 = UsageReport.pickDay(null, null, "2026-11-10");
        String[] p2 = UsageReport.pickDay("2026-11-10", null, "2026-11-03");
        String[] p3 = UsageReport.pickDay("2026-11-10", null, "2026-11-20");
        String[] p4 = UsageReport.pickDay("2026-11-10", "2026-11-20", "2026-11-05");
        out("pick", p1[0] + ">" + p1[1], p2[0] + ">" + p2[1], p3[0] + ">" + p3[1], p4[0] + ">" + p4[1]);
        out("time", UsageReport.requestTime("2026-11-27T06:03:12.345Z", "Asia/Shanghai", "2026-11-27"), UsageReport.requestTime("2026-01-01T03:00:00Z", "America/New_York", "2026-11-27"),
            UsageReport.requestTime("2025-12-31T20:00:00.000Z", "Asia/Shanghai", "2026-11-27"), UsageReport.requestTime("garbage", "UTC", "2026-11-27"));
        out("span", UsageReport.span("2026-11-27", "2026-11-27"), UsageReport.span("2026-11-21", "2026-11-27"), UsageReport.axisLabel("2026-01", "month", true),
            UsageReport.axisLabel("2026-03", "month", false), UsageReport.titleLabel("2026-03", "month", true), UsageReport.titleLabel("2026-03", "month", false));
        out("note", String.valueOf(UsageReport.recordedNote(5, 5, true)), String.valueOf(UsageReport.recordedNote(0, 0, true)), UsageReport.recordedNote(197, 1234, true),
            UsageReport.pageLabel(0, 0, 0, true), UsageReport.pageLabel(0, 0, 0, false), UsageReport.pageLabel(1000, 20, 12345, true));
        System.out.println("USAGE_MODEL_OK");
    }
}
`);
    const jvmOut = path.join(tmp, 'jvm-classes');
    const jvmFiles = [path.join(SRC, 'UsageModel.java'), path.join(SRC, 'UsageReport.java'), harness, ...Object.keys(ORG_JSON_SHIM).map(rel => path.join(jvmSrc, rel))];
    cp.execFileSync(javacBin, ['--release', '17', '-encoding', 'UTF-8', '-d', jvmOut, ...jvmFiles], { stdio: 'pipe' });
    const res = cp.execFileSync(javaBin, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', jvmOut, 'dev.rokbot.nativeapp.UsageModelHarness', tmp], { encoding: 'utf8' });
    assert.ok(res.includes('USAGE_MODEL_OK'), res);
    const lines = res.trim().split('\n').map(line => line.split('|'));
    const pick = (...prefix) => lines.filter(line => prefix.every((part, i) => line[i] === part));

    // Number formatting matches usage-format.js for every value, both languages.
    for (const value of COUNT_VALUES) {
      const key = String(Number.isInteger(value) ? value.toFixed(1) : value);
      const zh = pick('count', 'zh').find(line => Number(line[2]) === value), en = pick('count', 'en').find(line => Number(line[2]) === value);
      assert.equal(zh[3], formatCount(value, 'zh-CN'), `zh ${key}`);
      assert.equal(en[3], formatCount(value, 'en'), `en ${key}`);
      assert.equal(pick('exact').find(line => Number(line[1]) === value)[2], formatExactCount(value, 'en'), `exact ${key}`);
    }
    const zh = value => pick('count', 'zh').find(line => Number(line[2]) === value)[3];
    const en = value => pick('count', 'en').find(line => Number(line[2]) === value)[3];
    // Spot checks of the boundaries (万 from 10,000; 亿 from 1e8; K / M / B).
    assert.equal(zh(9999), '9,999');
    assert.equal(zh(10000), '1 万');
    assert.equal(zh(12345), '1.23 万');
    assert.equal(zh(12_345_678), '1234.6 万');
    assert.equal(zh(99_999_499), '9999.9 万');
    assert.equal(zh(99_995_000), '9999.5 万');
    assert.equal(zh(99_999_500), '1 亿', '9,999.95 万 rounds up to 1 亿');
    assert.equal(zh(320_000_000), '3.2 亿');
    assert.equal(zh(1_234_567_890_123), '1.23 万亿');
    assert.equal(en(999), '999');
    assert.equal(en(1000), '1K');
    assert.equal(en(12345), '12.3K');
    assert.equal(en(999_999), '1M');
    assert.equal(en(1_900_000_000), '1.9B');
    assert.equal(en(320_000_000), '320M');
    assert.equal(en(-12_345), '-12.3K');

    for (const [part, whole] of SHARE_PAIRS) {
      const line = pick('share').find(l => Number(l[1]) === part && Number(l[2]) === whole);
      assert.equal(line[3], formatShare(part, whole, 'en'), `share ${part}/${whole}`);
      assert.equal(line[3], formatShare(part, whole, 'zh-CN'), `share zh ${part}/${whole}`);
    }
    for (const max of TICK_MAXES) {
      const line = pick('ticks').find(l => Number(l[1]) === max);
      assert.equal(line[2], usageTicks(max).join(','), `ticks ${max}`);
    }
    assert.equal(pick('ticks').find(l => Number(l[1]) === 41_350)[2], '0,20000,40000,60000');
    assert.equal(pick('ticks').find(l => Number(l[1]) === 9999)[2], '0,2500,5000,7500,10000', '2.5 steps');
    assert.equal(pick('ticks').find(l => Number(l[1]) === 52_200)[2], '0,20000,40000,60000');
    assert.equal(pick('ticks').find(l => Number(l[1]) === 2_400_000_000)[2], '0,1000000000,2000000000,3000000000');
    for (const [, lang, value, text] of pick('req')) {
      const n = Number(value), locale = lang === 'zh' ? 'zh-CN' : 'en';
      assert.equal(text, withRequestUnit(formatCount(n, locale), n, locale), `requests ${lang} ${value}`);
    }

    // Buckets: 24 hours today, 7 and 30 days, parsed from the real usageSummary() response.
    const periods = pick('period', 'full');
    assert.deepEqual(periods.map(l => [l[2], l[3], l[4], l[5]]), [['today', '1', 'hour', '24'], ['7d', '7', 'day', '7'], ['30d', '30', 'day', '30']]);
    for (const line of periods) {
      const js = full.periods.find(p => p.id === line[2]);
      assert.equal(Number(line[6]), js.total);
      assert.equal(Number(line[7]), js.requests);
      assert.equal(line[9], js.input ? formatShare(js.cached, js.input, 'en') : '—', `cache hit rate ${js.id}`);
      assert.equal(Number(line[15]), Math.max(...js.buckets.map(b => b.total)));
    }
    const today = periods[0];
    assert.equal(today[9], '46%', 'cache hit rate = cached / input (11,000 / 23,780)');
    assert.equal(today[12], '2026-11-26');
    assert.equal(periods[1][12], '2026-11-20 – 2026-11-26');

    // Colours are fixed by the 30-day ranking, whichever period is shown: "small-today" keeps
    // series 5 although it leads today, and every period's share rows use the same series.
    const seriesFull = Object.fromEntries(pick('series', 'full').map(l => [l[2], Number(l[3])]));
    const jsSeries = usageSeries(full);
    for (const model of ['alpha', 'beta', 'gamma', 'delta', 'small-today', 'zeta', 'eta', 'theta', 'iota'])
      assert.equal(seriesFull[model] ?? 0, jsSeries(model), `series of ${model}`);
    assert.deepEqual(seriesFull, { alpha: 1, beta: 2, gamma: 3, delta: 4, 'small-today': 5, zeta: 6, eta: 7 });
    const todayShares = pick('sharepart', 'full', 'today');
    assert.deepEqual(todayShares.map(l => [l[3], l[4]]), [['5', 'small-today'], ['1', 'alpha'], ['0', '其他模型 (2)']],
      'today: coloured models by size, then theta + iota merged into grey "other models"');
    assert.equal(todayShares[0][6], formatShare(25_000, 29_600, 'en'));
    for (const line of pick('sharepart', 'full')) if (line[3] !== '0') assert.equal(Number(line[3]), seriesFull[line[4]], `${line[2]} ${line[4]}`);
    const monthShares = pick('sharepart', 'full', '30d');
    assert.equal(monthShares.length, 8);
    assert.deepEqual(monthShares.at(-1).slice(3, 5), ['0', '其他模型 (2)']);

    // Today's 09:00 bucket: alpha (series 1) at the baseline, small-today (5) above; tooltip rows by size.
    const nine = pick('bucket', 'full', 'today').find(l => l[3] === '9');
    assert.deepEqual(nine.slice(4, 8), ['2026-11-26T09', '28500', '2', '9:00']);
    assert.equal(nine[8], '9:00–10:00');
    assert.equal(nine[10], '1:3500 5:25000');
    assert.equal(nine[11], '5:small-today:25000 1:alpha:3500');
    assert.equal(nine[12], '合计 Token · 2 次请求');
    assert.equal(nine[13], 'tokens in total · 2 requests');
    const thirteen = pick('bucket', 'full', 'today').find(l => l[3] === '13');
    assert.equal(thirteen[10], '0:1100', 'theta and iota stack as one grey "other" segment');
    const monthLast = pick('bucket', 'full', '30d').find(l => l[3] === '29');
    assert.deepEqual([monthLast[4], monthLast[7], monthLast[8], monthLast[9]], ['2026-11-26', '11/26', '11月26日', 'Nov 26']);
    const monthFirst = pick('bucket', 'full', '30d').find(l => l[3] === '0');
    assert.equal(monthFirst[4], '2026-10-28');

    // A period-filtered response still parses (one period, its own ranking).
    assert.deepEqual(pick('period', 'week').map(l => [l[2], l[5]]), [['7d', '7']]);
    // periods[] without buckets (older Host): cards + table, no chart.
    assert.deepEqual(pick('period', 'noBuckets').map(l => l[5]), ['null', 'null', 'null']);
    assert.equal(pick('sharepart', 'noBuckets', 'today').length, 3);
    // No periods[] at all (the oldest Hosts, and the e2e mock): today's totals only.
    assert.deepEqual(pick('usage', 'legacy')[0].slice(2), ['true', '1', 'UTC']);
    const old = pick('period', 'legacy')[0];
    assert.deepEqual([old[2], old[5], old[6], old[8], old[9], old[10], old[13], old[14]],
      ['today', 'null', '41350', 'false', '—', 'false', '4.13 万', '41.4K']);

    // Column geometry and label thinning.
    assert.deepEqual(pick('seg').map(l => l.slice(1)), [['1', '176.0', '92.0', 'false'], ['2', '90.0', '50.0', 'true']]);
    assert.deepEqual(pick('every', 'hour').map(l => l[3]), ['12', '6', '3', '2', '1']);
    assert.deepEqual(pick('every', 'day').map(l => l[3]), ['6', '5', '2', '1', '1']);
    assert.equal(pick('show', 'day')[0][2], '4,9,14,19,24,29,', 'days are labelled back from today');
    assert.equal(pick('show', 'hour')[0][2], '0,6,12,18,');
    assert.deepEqual(pick('bar')[0].slice(1), ['0.005', '0.5']);
    assert.deepEqual(pick('color')[0].slice(1), ['ffa9a8a2', 'ff3987e5', 'ffa9a8a2']);

    // ---------------------------------------------------------------- usage report (UsageReport.parse and helpers)
    const KINDS_ZH = { chat: '对话', suggestions: '输入建议', completion: '输入补全', autocomplete: '输入补全', title: '标题', test: '测试', summary: '摘要',
      memory: '记忆', subagent: '子任务', automation: '自动化', classifier: '路由判断', review: '自动审查' };
    const STATUS_ZH = { ok: '成功', error: '失败', cancelled: '已取消' };
    const span = (from, to) => from === to ? to : `${from} – ${to}`;
    for (const [name, js] of Object.entries(reports)) {
      const [line] = pick('report', name);
      assert.ok(line, `report ${name} parsed`);
      assert.deepEqual(line.slice(2, 12), [String(js.version), js.range.id, js.range.from, js.range.to, String(js.range.days), js.range.unit,
        String(js.previous?.from ?? null), String(js.previous?.to ?? null), js.timeZone, String(js.priced)], `${name} range`);
      assert.equal(Number(line[12]), js.buckets.length, `${name} buckets`);
      assert.equal(line[13], js.series.join(','), `${name} series`);
      assert.deepEqual(line.slice(14, 18).map(String), [String(js.requests.total), String(js.requests.offset), String(js.requests.items.length), String(js.totals.requests === 0)]);
      assert.equal(line[18], `${span(js.range.from, js.range.to)}${js.previous ? ` · 对比 ${span(js.previous.from, js.previous.to)}` : ''} · Asia/Shanghai`, `${name} range line`);
      const n = js.requests.items.length, fmt = v => v.toLocaleString('en-US');
      assert.equal(line[19], n ? `第 ${fmt(js.requests.offset + 1)}–${fmt(js.requests.offset + n)} 条，共 ${fmt(js.requests.total)} 条` : `共 ${fmt(js.requests.total)} 条`);
      assert.equal(line[21], String(js.requests.offset > 0), `${name} previous page`);
      assert.equal(line[22], String(js.requests.offset + n < js.requests.total), `${name} next page`);
      assert.equal(line[23], String(js.changes === null), `${name} changes`);
      assert.deepEqual(line.slice(24, 26), [String(js.recorded.rows), String(js.recorded.agent)]);

      const [totals] = pick('totals', name), t = js.totals;
      assert.deepEqual(totals.slice(2, 11).map(Number), [t.requests, t.total, t.input, t.output, t.cached, t.reasoning, t.failed, t.durationRecorded, t.statusRecorded], `${name} totals`);
      assert.equal(totals[12], t.failureRate === null ? '未记录' : formatShare(t.failureRate, 1, 'en'), `${name} failure rate`);
      assert.equal(totals[13], t.cacheHitRate === null ? '-' : formatShare(t.cacheHitRate, 1, 'en'), `${name} cache hit rate`);
      assert.equal(totals[15], t.durationRecorded < t.requests ? `${fmt(t.durationRecorded)} / ${fmt(t.requests)} 条有记录` : 'null', `${name} recorded note`);
      // Composition: uncached + cached = input, output without reasoning + reasoning = output.
      const comp = pick('comp', name)[0][2].split(',').map(Number);
      assert.equal(comp[0] + comp[1], t.input);
      assert.equal(comp[2] + comp[3], t.output);
      assert.equal(comp[1], t.cached);
      assert.equal(comp[3], t.reasoning);

      for (const [, , key, value] of pick('change', name)) assert.equal(value === 'null' ? null : Number(value), js.changes?.[key] ?? null, `${name} change ${key}`);
      assert.deepEqual(pick('filter', name).map(l => [l[2], l[3]]).sort(), Object.entries(js.filters).sort(), `${name} filters`);

      for (const dim of ['model', 'provider', 'profile', 'kind', 'agent']) {
        const rows = pick('row', name, dim);
        assert.equal(rows.length, js.dimensions[dim].length, `${name} ${dim} rows`);
        rows.forEach((l, i) => {
          const row = js.dimensions[dim][i];
          assert.equal(l[4], row.key);
          const expected = row.key === '(none)' ? '未记录' : dim === 'kind' ? KINDS_ZH[row.key] ?? row.key : row.label;
          assert.equal(l[5], expected, `${name} ${dim} ${row.key} label`);
          assert.equal(l[7], formatShare(row.share, 1, 'en'));
          assert.deepEqual([Number(l[8]), Number(l[9])], [row.total, row.requests]);
          const series = row.key === '(none)' ? 0 : dim === 'model' ? (js.series.indexOf(row.key) + 1) : (i < 7 ? i + 1 : 0);
          assert.equal(Number(l[10]), series, `${name} ${dim} ${row.key} colour`);
        });
        // Sorting: by the column with unrecorded values last, ties by total.
        for (const [column, desc] of [['requests', true], ['requests', false], ['avgDurationMs', true], ['failureRate', false], ['total', true]]) {
          const keys = pick('sorted', name, dim, column, String(desc))[0][5].split(',').filter(Boolean);
          const expected = js.dimensions[dim].slice().sort((a, b) => {
            const va = a[column], vb = b[column];
            if (va === null || vb === null) { if (va !== vb) return va === null ? 1 : -1; }
            else if (va !== vb) return desc ? vb - va : va - vb;
            return b.total - a.total;
          }).map(r => r.key);
          assert.deepEqual(keys, expected, `${name} ${dim} sorted by ${column} ${desc ? 'desc' : 'asc'}`);
        }
      }
      for (const key of ['model', 'provider', 'profile', 'kind', 'agent', 'status']) {
        const expected = js.options[key].map(o => `${o.key === '(none)' ? '未记录' : key === 'kind' ? KINDS_ZH[o.key] ?? o.key : key === 'status' ? STATUS_ZH[o.key] ?? o.key : o.label}:${o.requests},`).join('');
        assert.equal(pick('opt', name, key)[0][3], expected, `${name} options ${key}`);
      }
      const max = mode => Number(pick('max', name, mode)[0][3]);
      assert.equal(max('model'), Math.max(0, ...js.buckets.map(b => b.total)));
      assert.equal(max('type'), Math.max(0, ...js.buckets.map(b => b.input + b.output)));
      assert.equal(max('requests'), Math.max(0, ...js.buckets.map(b => b.requests)));
      pick('rb', name).forEach(l => {
        const b = js.buckets[Number(l[2])];
        assert.equal(l[3], b.start);
        // Model stacks: series order from the baseline, other models (0) on top, summing to the total.
        const parts = l[8] ? l[8].split(' ').map(p => p.split(':').map(Number)) : [];
        assert.equal(parts.reduce((sum, [, v]) => sum + v, 0), b.models.reduce((sum, m) => sum + m.total, 0));
        const order = parts.map(([series]) => series === 0 ? 99 : series);
        assert.deepEqual(order, order.slice().sort((x, y) => x - y));
        const type = l[9].split(',').map(Number);
        assert.deepEqual(type, [b.cached, b.input - b.cached, b.output]);
        assert.deepEqual(l[10].split(',').map(Number), [b.requests - b.failed, b.failed]);
        assert.deepEqual([Number(l[11]), Number(l[12])], [b.total, b.requests]);
        assert.equal(l[13] === 'null' ? null : Number(l[13]), b.avgDurationMs);
      });
      pick('item', name).forEach((l, i) => {
        const q = js.requests.items[i];
        assert.equal(l[2], q.id, `${name} request order`);
        const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
          .formatToParts(new Date(q.at)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
        assert.equal(l[3], `${local.month}-${local.day} ${local.hour}:${local.minute}:${local.second}`, `${name} ${q.id} local time`);
        assert.equal(l[4], q.kind ? KINDS_ZH[q.kind] ?? q.kind : '未记录');
        assert.equal(l[5], q.status ? STATUS_ZH[q.status] : '未记录');
        assert.equal(l[6] === '未记录', q.durationMs === null);
        assert.equal(Number(l[7]), q.total);
        assert.equal(l[8], String(q.agent));
        assert.equal(l[10], String(q.error));
      });
    }
    // Spot checks on the demo ledger: 7 days vs the 7 before, legacy rows without bot / duration / status.
    assert.deepEqual(pick('change', 'r7d').map(l => [l[2], l[4], l[5]]),
      [['requests', '−4.8%', '0'], ['total', '−4.7%', '0'], ['cost', '', '0'], ['avgDurationMs', '−1.1%', '2'], ['failureRate', '−21.2%', '2']],
      'falling durations and failures are good (2), the rest neutral (0)');
    assert.deepEqual(pick('totals', 'r7d')[0].slice(11, 15), ['7.4 s', '3%', '63%', '未配置单价']);
    assert.deepEqual(pick('totals', 'rAll')[0].slice(15), ['635 / 1,383 条有记录', '635 / 1,383 recorded'], 'only recorded rows count for durations');
    assert.equal(pick('report', 'rAll')[0][18], '2026-10-13 – 2026-11-27 · Asia/Shanghai', 'range=all: no comparison');
    assert.equal(pick('report', 'rToday')[0][7], 'hour');
    assert.deepEqual(pick('rb', 'rToday').slice(0, 1).map(l => l.slice(4, 8)), [['0:00', '0:00', '0:00–1:00', '0:00–1:00']]);
    assert.equal(pick('report', 'rLong')[0][7], 'month', 'over 92 days: per month');
    assert.deepEqual(pick('rb', 'rLong').map(l => l.slice(3, 8).join(' ')),
      ['2026-07 7月 Jul 2026年7月 Jul 2026', '2026-08 8月 Aug 2026年8月 Aug 2026', '2026-09 9月 Sep 2026年9月 Sep 2026',
        '2026-10 10月 Oct 2026年10月 Oct 2026', '2026-11 11月 Nov 2026年11月 Nov 2026']);
    assert.deepEqual(pick('report', 'rEmpty')[0].slice(17, 21), ['true', '2020-01-01 – 2020-01-05 · 对比 2019-12-27 – 2019-12-31 · Asia/Shanghai', '共 0 条', '0 in total']);
    assert.deepEqual(pick('totals', 'rEmpty')[0].slice(11, 15), ['未记录', '未记录', '-', '未配置单价'], 'missing values are 「未记录」, never 0');
    assert.deepEqual(pick('report', 'rPage')[0].slice(19, 23), ['第 21–40 条，共 198 条', '21–40 of 198', 'true', 'true']);
    assert.deepEqual(pick('report', 'rLast')[0].slice(19, 23), ['第 181–198 条，共 198 条', '181–198 of 198', 'true', 'false']);
    assert.deepEqual(pick('filter', 'rFiltered').map(l => l.slice(4)), [['场景：对话', 'Scene: Chat'], ['Bot：写作助手', 'Bot: 写作助手']]);
    assert.deepEqual(pick('filter', 'rNone').map(l => l.slice(4)), [['Bot：未记录', 'Bot: Not recorded']]);
    assert.equal(pick('row', 'r7d', 'agent').at(-1)[5], '未记录');
    assert.equal(pick('row', 'r7d', 'kind').find(l => l[4] === 'test')[10], '0', '8th row and later are grey');
    assert.equal(pick('totals', 'rPriced')[0][14], String(Number(reports.rPriced.totals.cost.toFixed(2))));
    assert.deepEqual(pick('row', 'rPriced', 'model').map(l => l[13]), ['1.54', 'Not recorded', 'Not recorded', 'Not recorded', 'Not recorded'], 'unpriced models: 「未记录」');
    assert.equal(pick('change', 'rPriced', 'cost')[0][4], '−25.6%');
    assert.equal(pick('sorted', 'rPriced', 'model', 'cost', 'false')[0][5], 'deepseek-v3.2,claude-sonnet-4.5,deepseek-reasoner,gpt-5-mini,qwen3-max,', 'unrecorded costs stay last');

    const helper = (...prefix) => Object.fromEntries(pick(...prefix).map(l => [l[prefix.length], l.slice(prefix.length + 1)]));
    const dur = helper('dur');
    assert.deepEqual(Object.fromEntries(Object.entries(dur).map(([k, v]) => [k, v[0]])), {
      '0.0': '0 ms', '1.0': '1 ms', '850.0': '850 ms', '999.4': '999 ms', '999.6': '1 s', '1000.0': '1 s', '1234.0': '1.2 s', '7401.0': '7.4 s',
      '9960.0': '10 s', '9999.0': '10 s', '10000.0': '10 s', '12345.0': '12 s', '59400.0': '59 s', '59600.0': '1 分 0 秒', '65000.0': '1 分 5 秒',
      '3599000.0': '59 分 59 秒', '3600000.0': '1 小时 0 分', '7380000.0': '2 小时 3 分', null: '未记录' });
    assert.deepEqual([dur['65000.0'][1], dur['7380000.0'][1], dur.null[1]], ['1m 5s', '2h 3m', 'Not recorded']);
    const chg = helper('chg');
    assert.deepEqual(Object.fromEntries(Object.entries(chg).map(([k, v]) => [k, v.join(' ')])), {
      '0.0': '0% 0 0 0', '4.0E-4': '0% 0 0 0', '-4.0E-4': '0% 0 0 0', '0.123': '+12.3% 1 1 0', '-0.047': '−4.7% 2 2 0', '0.12345': '+12.3% 1 1 0',
      '-0.21212121': '−21.2% 2 2 0', '1.0': '+100% 1 1 0', '2.5': '+250% 1 1 0', '9.996': '+1000% 1 1 0', '-1.0': '−100% 2 2 0',
      '4.9E-4': '0% 0 0 0', '5.1E-4': '+0.1% 1 1 0', null: ' 0' }, 'rising durations / failures warn (1), falling good (2), U+2212 minus');
    assert.deepEqual(Object.fromEntries(Object.entries(helper('cost')).map(([k, v]) => [k, v.join(' ')])), {
      '0.0': '0', '4.0E-5': '<0.0001', '0.0123': '0.0123', '0.5': '0.5', '1.23456': '1.23', '12.345': '12.35', '1234.5': '1234.5',
      null: '未记录 未配置单价 No prices set' });
    assert.deepEqual(Object.values(helper('rate')).map(v => v[0]), ['0%', '<0.1%', '3%', '63%', '100%']);
    const kinds = helper('kind');
    for (const [key, zhName] of Object.entries(KINDS_ZH)) assert.equal(kinds[key][0], zhName, `kind ${key}`);
    assert.deepEqual([kinds.review[1], kinds.classifier[1], kinds.completion[1], kinds['weird-kind'][0], kinds['(none)'][0], kinds.null[0]],
      ['Auto review', 'Routing', 'Completion', 'weird-kind', '未记录', '未记录']);
    assert.deepEqual(Object.fromEntries(Object.entries(helper('status')).map(([k, v]) => [k, v.join(' ')])),
      { ok: '成功 Succeeded', error: '失败 Failed', cancelled: '已取消 Cancelled', '(none)': '未记录 Not recorded', odd: 'odd odd' });
    assert.deepEqual(pick('query').map(l => l[1]), [
      '/local/usage/report?timeZone=Asia%2FShanghai&range=7d&model=claude%20sonnet%2F4.5&agent=%28none%29&status=error&offset=40&limit=20',
      '/local/usage/report?timeZone=America%2FNew_York&range=custom&from=2026-11-01&to=2026-11-27&offset=0&limit=200',
      '/local/usage/report?timeZone=UTC&range=7d&export=csv']);
    for (const [query] of pick('query').map(l => [l[1]])) {
      const params = new URL(query, 'http://host').searchParams;
      if (params.get('model')) assert.deepEqual([params.get('model'), params.get('agent'), params.get('status')], ['claude sonnet/4.5', '(none)', 'error']);
    }
    assert.deepEqual(pick('days')[0].slice(1), ['2026-12-02', '2024-02-29', '2025-12-31', '7', '400', '29', '28', '30', '6', '0', 'false', 'true',
      '2026 年 11 月', 'November 2026'], 'calendar maths (2026-11-01 is a Sunday, 2026-06-01 a Monday)');
    assert.deepEqual(pick('valid')[0].slice(1), ['null', '开始日期晚于结束日期', '不能选择今天之后的日期', '最长 400 天', 'null', 'Pick a start and an end date']);
    assert.deepEqual(pick('pick')[0].slice(1), ['2026-11-10>null', '2026-11-03>2026-11-10', '2026-11-10>2026-11-20', '2026-11-05>null']);
    assert.deepEqual(pick('time')[0].slice(1), ['11-27 14:03:12', '2025-12-31 22:00', '01-01 04:00:00', 'garbage']);
    assert.deepEqual(pick('span')[0].slice(1), ['2026-11-27', '2026-11-21 – 2026-11-27', '2026', 'Mar', '2026年3月', 'Mar 2026']);
    assert.deepEqual(pick('note')[0].slice(1), ['null', 'null', '197 / 1,234 条有记录', '共 0 条', '0 in total', '第 1,001–1,020 条，共 12,345 条']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Mock host: GET /local/usage/report over the demo ledger, export=csv, 400 and the 404 of older Hosts', async () => {
  const pair = async host => {
    const res = await fetch(`${host.origin}/connect/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingKey: 'ABCDEF', deviceName: 'UsageTest', platform: 'android' }),
    }).then(r => r.json());
    return { Authorization: `Bearer ${res.token}` };
  };
  const host = new MockHostServer({ port: 0, pairingKey: 'ABCDEF', usageNow: '2026-11-27T06:00:00.000Z' });
  await host.start();
  try {
    const auth = await pair(host);
    const report = await fetch(`${host.origin}/local/usage/report?timeZone=Asia%2FShanghai&range=7d&offset=0&limit=20`, { headers: auth }).then(r => r.json());
    assert.equal(report.version, 2);
    assert.deepEqual([report.range.from, report.range.to, report.requests.items.length, report.requests.total], ['2026-11-21', '2026-11-27', 20, 198]);
    assert.equal(report.dimensions.agent[0].label, '写作助手', 'demo names');
    const filtered = await fetch(`${host.origin}/local/usage/report?timeZone=Asia%2FShanghai&range=7d&agent=agent-review&status=error`, { headers: auth }).then(r => r.json());
    assert.deepEqual(filtered.filters, { agent: 'agent-review', status: 'error' });
    assert.ok(filtered.requests.items.every(item => item.agentId === 'agent-review' && item.status === 'error'));
    const csv = await fetch(`${host.origin}/local/usage/report?timeZone=Asia%2FShanghai&range=7d&export=csv`, { headers: auth }).then(r => r.json());
    assert.equal(csv.filename, 'rokbot-usage-2026-11-21_2026-11-27.csv');
    assert.equal(csv.count, 198);
    assert.ok(csv.csv.startsWith('﻿时间,Bot,场景,模型'));
    const bad = await fetch(`${host.origin}/local/usage/report?timeZone=UTC&range=custom&from=2026-11-27&to=2026-11-01`, { headers: auth });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${host.origin}/local/usage/report?range=7d`)).status, 401, 'device credential required');
  } finally {
    await host.stop();
  }
  const old = new MockHostServer({ port: 0, pairingKey: 'ABCDEF', usageReport: false });
  await old.start();
  try {
    const auth = await pair(old);
    assert.equal((await fetch(`${old.origin}/local/usage/report?range=7d`, { headers: auth })).status, 404, 'older Host: the page falls back to /local/usage');
    const legacy = await fetch(`${old.origin}/local/usage?timeZone=UTC`, { headers: auth }).then(r => r.json());
    assert.equal(legacy.total, 41350);
  } finally {
    await old.stop();
  }
});
