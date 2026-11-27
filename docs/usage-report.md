# 用量报表接口与界面结构

所有端（网页管理页、桌面端 / 网页客户端的设置页、安卓 UsageActivity、iOS RBUsage）共用同一个接口和同一套信息结构。

## 接口

- 设备：`GET /local/usage/report`（Bearer 设备凭证；网页客户端走 Cookie）
- 管理页：`GET /admin/api/usage/report`
- 旧接口 `GET /local/usage` 保持不变，供旧版客户端使用。

查询参数：

| 参数 | 说明 |
| --- | --- |
| `timeZone` | IANA 时区，默认 Host 时区 |
| `range` | `today`、`7d`（默认）、`30d`、`all`、`custom` |
| `from`、`to` | `range=custom` 时必填，本地日期 `YYYY-MM-DD`，最长 400 天 |
| `model`、`provider`、`profile`、`kind`、`agent`、`status` | 筛选；值为维度的 `key`，`(none)` 表示「未记录」 |
| `offset`、`limit` | 请求明细分页，`limit` 最大 200，默认 50 |
| `export=csv` | 返回 `{ filename, csv, count }`，`csv` 为带 BOM 的 UTF-8 文本，包含全部筛选后的请求（最多 10 万条） |

错误：参数非法时 400，`{ error }`。

## 返回（`version: 2`）

```jsonc
{
  "version": 2, "timeZone": "Asia/Shanghai", "today": "2026-11-27", "generatedAt": "…",
  "range": { "id": "7d", "from": "2026-11-21", "to": "2026-11-27", "days": 7, "unit": "day" }, // unit: hour | day | month
  "previous": { "from": "2026-11-14", "to": "2026-11-20" },   // range=all 时为 null
  "filters": { "agent": "agent-writer" },                     // 实际生效的筛选
  "priced": false,                                            // Host 是否配置了单价（usage-prices.json）
  "totals": Totals, "previousTotals": Totals | null,
  "changes": { "requests": -0.048, "total": -0.047, "input": …, "output": …, "cached": …, "reasoning": …,
               "cost": null, "avgDurationMs": -0.01, "failureRate": -0.21 } | null,  // 相对上一周期的比例，null = 无法比较
  "series": ["deepseek-v3.2", "claude-sonnet-4.5", …],        // 至多 7 个模型，按顺序取颜色 1…7，其余为「其他模型」（颜色 0）
  "buckets": [ { "start": "2026-11-21" /* 或 "2026-11-27T13"、"2026-11" */, "requests", "total", "input", "output",
                 "cached", "cacheWrite", "reasoning", "failed", "avgDurationMs", "cost",
                 "models": [ { "model": "deepseek-v3.2", "total": 113690 } ] } ],
  "dimensions": { "model": [Row], "provider": [Row], "profile": [Row], "kind": [Row], "agent": [Row] },
  "options": { "model": [ { "key", "label", "requests" } ], …, "status": [ … ] },   // 筛选候选项（不受筛选影响）
  "recorded": { "rows": 198, "agent": 197, "duration": 198, "status": 198, "profile": 198 }, // 有该字段的行数
  "requests": { "total": 198, "offset": 0, "limit": 50, "items": [Request] }
}
```

`Totals`：`requests input output total cached cacheWrite reasoning failed cancelled statusRecorded durationRecorded`
（整数），`avgDurationMs`（毫秒，无记录为 null）、`failureRate`（0–1，无记录为 null）、`cacheHitRate`（cached / input，
input 为 0 时 null）、`cost`（未配置单价为 null）、`costRecorded`。

`Row` = `{ key, label, share, ...Totals }`，按 total 降序。`key` 为 `(none)` 时 `label` 为 null，显示「未记录」。
`kind` 维度的 `label` 就是 key，由客户端翻译（见下表）。

`Request` = `{ id, at (ISO), kind, model, agentId, agent, profileId, profile, providerId, provider, effort,
input, output, total, cached, cacheWrite, reasoning, durationMs, status, error, cost, requestId }`，按时间倒序；
缺失字段为 null，显示「未记录」。`status`：`ok` 成功 / `error` 失败 / `cancelled` 已取消。

旧账本行没有 `agentId`、`durationMs`、`status`：平均耗时、失败率只按有记录的行计算，界面上注明「x / y 条有记录」。

## 场景（kind）名称

| key | 中文 | English |
| --- | --- | --- |
| chat | 对话 | Chat |
| suggestions | 输入建议 | Suggestions |
| completion / autocomplete | 输入补全 | Completion |
| title | 标题 | Titles |
| test | 测试 | Tests |
| summary | 摘要 | Summaries |
| memory | 记忆 | Memory |
| subagent | 子任务 | Subagents |
| automation | 自动化 | Automations |
| classifier | 路由判断 | Routing |
| review | 自动审查 | Auto review |
| 其他 | 原样显示 | as is |

## 界面结构（各端一致）

1. 标题栏「用量」，右侧刷新、导出 CSV。
2. 时间范围分段控件：今天 / 7 天 / 30 天 / 全部 / 自定义（自定义弹出自有样式的日期区间选择，不用系统控件）。
   下方一行：区间文字、对比区间、时区。
3. 筛选：已生效的筛选以「维度：值 ×」小标签显示；「筛选」按钮打开自有样式菜单（维度 → 值）。
4. 汇总卡片：总花费（未配置单价时显示「未配置单价」）、总 Token、请求次数、平均耗时、失败率、缓存命中率；
   每张卡片带与上一周期相比的变化（+12.3% / −4.7%，耗时和失败率上升为警示色，下降为正向色，其余中性）。
   Token 构成卡：未命中输入 / 缓存命中 / 输出 / 推理 的横向堆叠条与图例。
5. 趋势：今天按小时，其余按天（超过 92 天按月）。切换「按模型」（堆叠柱）、「按类型」（堆叠面积：缓存命中、
   未命中输入、输出）、「请求」（柱，失败部分单独颜色）。悬停 / 点按显示提示。
6. 维度拆分：模型 / 服务商 / 配置 / 场景 / Bot 标签页；环形占比图 + 可排序表格（名称、占比条、Token、请求、
   平均耗时、失败率、花费）。点一行即按该值筛选。
7. 请求明细：时间、Bot、场景、模型、Token、耗时、状态；分页（上一页 / 下一页，第 a–b 条，共 n 条）。
   窄屏为卡片列表。
8. 加载时骨架屏，无数据时空状态，失败时可重试。界面中文、无 emoji。

颜色：系列色沿用 `host/server/public/usage-charts.css` 的 `--rok-usage-c0…c7`（浅色、深色两套）。

## 单价（可选）

在 Host 数据目录放一个 `usage-prices.json`，按模型填每百万 Token 的单价，「总花费」卡片和各表格的花费列就会显示：

```json
{
  "currency": "CNY",
  "deepseek-v3.2": { "input": 2, "output": 3, "cached": 0.2 },
  "claude-sonnet-4.5": { "input": 21.6, "output": 108, "cached": 2.16, "cacheWrite": 27 }
}
```

`input` 指未命中缓存的输入；`cached`、`cacheWrite` 不填时按 `input` 计算。没有单价的模型不计入花费，界面会注明「x / y 次请求有单价」。
没有这个文件时，花费卡片显示「未配置单价」。
