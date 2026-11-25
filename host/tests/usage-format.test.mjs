import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCount, formatExactCount, formatTokens, usageLanguage, withRequestUnit } from '../server/public/usage-format.js';

test('Chinese counts use 万, 亿 and 万亿 with one or two decimals; below 10,000 they stay exact', () => {
  const cases = [
    [0, '0'], [7, '7'], [999, '999'], [1000, '1,000'], [9999, '9,999'],
    [10000, '1 万'], [12345, '1.23 万'], [15000, '1.5 万'], [99999, '10 万'], [123456, '12.3 万'], [1234567, '123.5 万'],
    [12345678, '1234.6 万'], [99994999, '9999.5 万'], [99999999, '1 亿'], [100000000, '1 亿'],
    [123456789, '1.23 亿'], [320000000, '3.2 亿'], [2935230652, '29.4 亿'], [999999999999, '1 万亿'], [1.5e13, '15 万亿'],
  ];
  for (const [value, text] of cases) assert.equal(formatCount(value, 'zh-CN'), text, String(value));
  assert.equal(formatCount(12345, 'zh'), '1.23 万');
  assert.equal(formatCount(-12345, 'zh-CN'), '-1.23 万');
});

test('English counts use K, M, B and T; below 1,000 they stay exact', () => {
  const cases = [
    [0, '0'], [999, '999'], [1000, '1K'], [1234, '1.23K'], [9999, '10K'], [12345, '12.3K'], [999999, '1M'],
    [1234567, '1.23M'], [12345678, '12.3M'], [12300000, '12.3M'], [320000000, '320M'], [999950000, '1B'],
    [2935230652, '2.94B'], [1e12, '1T'],
  ];
  for (const [value, text] of cases) assert.equal(formatCount(value, 'en-US'), text, String(value));
  assert.equal(formatTokens(12345678, 'en'), '12.3M tokens');
  assert.equal(formatTokens(1, 'en'), '1 token');
  assert.equal(formatTokens(320000000, 'zh-CN'), '3.2 亿 Token');
});

test('exact counts are grouped, and anything that is not a number shows a dash', () => {
  assert.equal(formatExactCount(320000000, 'zh-CN'), '320,000,000');
  assert.equal(formatExactCount(12345.4, 'en'), '12,345');
  for (const value of [undefined, null, NaN, Infinity, '12']) {
    assert.equal(formatCount(value, 'en'), '—');
    assert.equal(formatExactCount(value, 'zh-CN'), '—');
  }
  assert.equal(usageLanguage('zh-Hans-CN'), 'zh');
  assert.equal(usageLanguage('zh_TW'), 'zh');
  assert.equal(usageLanguage('en-GB'), 'en');
  assert.equal(usageLanguage('zhx'), 'en');
});

test('request counts carry their unit without a doubled space after 万 or 亿', () => {
  assert.equal(withRequestUnit(formatCount(1757, 'zh-CN'), 1757, 'zh-CN'), '1,757 次请求');
  assert.equal(withRequestUnit(formatCount(27694, 'zh-CN'), 27694, 'zh-CN'), '2.77 万次请求');
  assert.equal(withRequestUnit(formatCount(1, 'en'), 1, 'en'), '1 request');
  assert.equal(withRequestUnit(formatCount(27694, 'en'), 27694, 'en'), '27.7K requests');
});
