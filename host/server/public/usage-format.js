// Token and request counts for people: Chinese uses 万 / 亿 / 万亿, English K / M / B / T.
// Below 10,000 (Chinese) or 1,000 (English) the exact number is shown with digit grouping.
// The mantissa keeps two decimals below 10 and one from 10 up, without trailing zeros:
// 12,345 → "1.23 万" / "12.3K", 320,000,000 → "3.2 亿" / "320M", 12,345,678 → "1234.6 万" / "12.3M".
// The admin page imports this file; the desktop and web settings get the same file as
// rok-usage-format.js (windows/tools/desktop-recipes/spec.mjs). Keep it dependency free.
const ROK_USAGE_UNITS = {
  zh: [[1e12, '万亿'], [1e8, '亿'], [1e4, '万']],
  en: [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']],
};

export function usageLanguage(locale) {
  const value = locale ?? globalThis.window?.localBot?.locale ?? globalThis.navigator?.language ?? 'en';
  return /^zh(?:$|[-_])/i.test(String(value)) ? 'zh' : 'en';
}

/** The exact count with digit grouping: "12,345". */
export function formatExactCount(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString(usageLanguage(locale) === 'zh' ? 'zh-CN' : 'en-US');
}

/** A short count: "1.23 万", "3.2 亿", "12.3M"; small counts stay exact ("9,999", "999"). */
export function formatCount(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const language = usageLanguage(locale), units = ROK_USAGE_UNITS[language];
  const size = Math.abs(Math.round(value)), sign = value < 0 && size > 0 ? '-' : '';
  const smallest = units[units.length - 1][0];
  if (size < smallest) return sign + formatExactCount(size, locale);
  for (let index = units.length - 1; index >= 0; index--) {
    const [unit, suffix] = units[index], next = units[index - 1];
    if (next && size >= next[0]) continue;
    const scaled = size / unit, digits = scaled < 10 ? 2 : 1;
    const rounded = Number(scaled.toFixed(digits));
    // 9,999.96 万 rounds up to 10,000 万: that is 1 亿.
    if (next && rounded * unit >= next[0]) return sign + formatCount(next[0], locale);
    const text = rounded.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
    return sign + text + (language === 'zh' ? ' ' : '') + suffix;
  }
  return sign + formatExactCount(size, locale);
}

/** "1.23 万 Token" / "12.3M tokens"; one token stays singular in English. */
export function formatTokens(value, locale) {
  const english = usageLanguage(locale) === 'en';
  return `${formatCount(value, locale)} ${english ? (value === 1 ? 'token' : 'tokens') : 'Token'}`;
}

/** A formatted request count with its unit: "1,757 次请求", "2.77 万次请求", "1 request", "27.7K requests". */
export function withRequestUnit(text, value, locale) {
  if (usageLanguage(locale) === 'zh') return `${text}${/[万亿]$/.test(text) ? '' : ' '}次请求`;
  return `${text} ${value === 1 ? 'request' : 'requests'}`;
}
