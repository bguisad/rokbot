import { t, html, locale } from './i18n.js';
import { $, node, status as statusText } from './ui.js';

// Host facts for the system page, read from the shared status poll (no request of its own).
export function createSystemPage({ copy }) {
  const panel = $('[data-panel=system]');
  panel.innerHTML = html(`<section class="section"><div class="section-head"><h2 class="section-title">运行信息</h2></div>
    <div id="system-info" class="card"></div></section>`);
  const time = value => {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  };
  function row(title, value, { hint = '', tone, copyValue } = {}) {
    const line = node('div', 'row'), copyNode = node('span', 'row-copy'), control = node('span', 'row-control auto');
    copyNode.append(node('span', 'row-title', t(title)));
    if (hint) copyNode.append(node('span', 'row-hint', hint));
    control.append(tone === undefined ? node('span', 'row-value', value) : statusText(value, tone));
    if (copyValue) {
      const button = node('button', 'btn btn-sm', t('复制')); button.type = 'button';
      button.onclick = () => copy(copyValue); control.append(button);
    }
    line.append(copyNode, control);
    return line;
  }
  function render(state) {
    const host = state.host, bots = host.agents.filter(agent => !agent.isGroup), web = state.webClient ?? {};
    const hostState = host.connected ? host.busy ? [t('任务运行中'), 'accent'] : [t('Host 就绪'), 'success']
      : host.waitingForExecutionNode ? [t('需要执行节点'), 'warn'] : state.model.configured ? [t('等待 Host'), 'warn'] : [t('等待配置'), 'warn'];
    $('#system-info').replaceChildren(
      row('Host 状态', hostState[0], { tone: hostState[1] }),
      row('启动时间', time(state.startedAt)),
      row('管理地址', state.publicUrl || '—', { copyValue: state.publicUrl }),
      row('Bot', t('{0} 个', bots.length)),
      row('已配对设备', t('{0} 台', state.devices.filter(device => !device.revokedAt).length)),
      row('网页版界面包', web.installed ? web.rendererVersion || t('已安装') : t('未安装')),
    );
  }
  return {
    status: render,
    statusUnavailable() { $('#system-info').replaceChildren(row('Host 状态', t('状态不可用'), { tone: 'warn' })); },
  };
}
