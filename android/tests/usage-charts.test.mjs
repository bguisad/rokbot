// RokBot Android usage page: UsageActivity (period switch, Canvas charts), UsageChartView,
// HostApiClient.getUsage(ctx, period) and the pure UsageModel, which ports the Host's
// usage-charts.js / usage-format.js. UsageModel runs on a plain JVM (org.json shim, no android.jar)
// and its output is compared with the JavaScript originals on the same inputs.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(NATIVE_ROOT, '..');
const SRC = path.join(NATIVE_ROOT, 'companion/src/main/java/dev/rokbot/nativeapp');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');

test('Usage wiring: period switch, Canvas views, 30-day colours and the period= query', () => {
  const api = read('HostApiClient.java');
  const fn = api.slice(api.indexOf('public static JSONObject getUsage(Context context, String period)'));
  const body = fn.slice(0, fn.indexOf('\n    }\n') + 6);
  assert.ok(body.length > 50, 'HostApiClient.getUsage(Context, String period) exists');
  assert.match(body, /"\/local\/usage\?timeZone=" \+ encodeQuery\(tz\)/);
  assert.match(body, /path \+= "&period=" \+ encodeQuery\(period\.trim\(\)\);/, 'period=today|7d|30d is passed as a query parameter');
  assert.match(api, /public static JSONObject getUsage\(Context context\) throws Exception \{/, 'the original getUsage(Context) stays');

  const ua = read('UsageActivity.java');
  assert.match(ua, /\{"today", "今天", "Today"\},\s*\{"7d", "7 天", "7 days"\},\s*\{"30d", "30 天", "30 days"\}/, 'segmented control: today / 7 / 30 days');
  assert.match(ua, /tab\.setOnClickListener\(v -> selectPeriod\(id\)\);/);
  assert.match(ua, /HostApiClient\.getUsage\(this, null\)/, 'all periods at once, as the desktop general pane');
  assert.match(ua, /mSeries = UsageModel\.series\(result\);/, 'colours come from the longest (30-day) period');
  assert.match(ua, /new UsageChartView\(this, mP, mZh\)/);
  assert.match(ua, /new UsageChartView\.ShareBar\(/);
  assert.match(ua, /UiChrome\.palette\(this\)/);
  assert.match(ua, /makeVectorIconButton\(this, "refresh", "refresh_usage_button"/, 'refresh header button kept');
  assert.match(ua, /setOnLongClickListener/, 'long press shows the exact number');
  assert.match(ua, /new HorizontalScrollView\(this\)/, 'detail table scrolls sideways');
  for (const label of ['"总 Token"', '"请求数"', '"输入"', '"输出"', '"缓存命中率"', '"模型占比"', '"明细"', '"合计"', '"缓存写入"',
    '"Total tokens"', '"Requests"', '"Cache hit rate"', '"Share by model"', '"Details"'])
    assert.ok(ua.includes(label), `label ${label}`);
  assert.doesNotMatch(ua, /WebView/);

  const chart = read('UsageChartView.java');
  assert.match(chart, /final class UsageChartView extends View/);
  assert.match(chart, /protected void onDraw\(Canvas canvas\)/);
  assert.match(chart, /canvas\.drawPath\(mPath, mFill\)/);
  assert.match(chart, /MAX_BAR = 24f, RADIUS = 4f, GAP = 2f/);
  assert.match(chart, /public boolean onTouchEvent\(MotionEvent event\)/, 'tapping a column shows the callout');
  assert.match(chart, /drawTip\(canvas, mPeriod\.buckets\.get\(mActive\)/);

  const model = read('UsageModel.java');
  assert.doesNotMatch(model, /^import android\./m, 'UsageModel stays JVM-only');
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
  @SuppressWarnings("unchecked") public JSONArray optJSONArray(String k) { Object v = map.get(k); return v instanceof List ? new JSONArray((List<Object>) v) : null; }
}`,
  'org/json/JSONArray.java': `package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> list;
  JSONArray(List<Object> l) { list = l; }
  public int length() { return list.size(); }
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
        System.out.println("USAGE_MODEL_OK");
    }
}
`);
    const jvmOut = path.join(tmp, 'jvm-classes');
    const jvmFiles = [path.join(SRC, 'UsageModel.java'), harness, ...Object.keys(ORG_JSON_SHIM).map(rel => path.join(jvmSrc, rel))];
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
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
