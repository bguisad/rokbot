import { html, locale } from './i18n.js';
import { $ } from './ui.js';
import { mountUsageDashboard, usageQuery } from './usage-dashboard.js';

// The usage report page: usage-dashboard.js owns ranges, filters, trend, breakdowns, requests and CSV.
// The dashboard is mounted on the first visit, so other pages never request the report.
export function createUsagePage({ api }) {
  const panel = $('[data-panel=usage]');
  panel.innerHTML = html(`<section id="usage" class="section usage" aria-label="用量统计"><div id="usage-view"></div></section>`);
  const load = query => api(`/admin/api/usage/report?${usageQuery(query)}`);
  let dashboard = null;
  return {
    async load() {
      if (dashboard) void dashboard.refresh();
      else dashboard = mountUsageDashboard($('#usage-view'), { load, exportCsv: load, locale });
    },
  };
}
