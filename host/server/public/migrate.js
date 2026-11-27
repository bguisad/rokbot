import { $, copyText } from './ui.js';
import { createMigrationWizard } from './migrate-wizard.js';

/** Streams a file to the admin API as the raw request body, so there is no upload size limit. */
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/admin/api/migrate/packages?name=${encodeURIComponent(file.name)}`);
    request.withCredentials = true;
    request.setRequestHeader('x-rokbot-csrf', '1');
    request.setRequestHeader('content-type', /\.json$/i.test(file.name) ? 'application/json' : 'application/zip');
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total * 0.9); };
    request.onload = () => {
      let value = null; try { value = JSON.parse(request.responseText); } catch {}
      if (request.status === 401) { document.dispatchEvent(new Event('rokbot:logout')); reject(new Error('会话已过期，请重新登录。')); return; }
      if (request.status >= 200 && request.status < 300) { onProgress(1); resolve(value); }
      else reject(new Error(value?.error || `上传失败（${request.status}）`));
    };
    request.onerror = () => reject(new Error('上传失败，请检查网络后重试。'));
    request.send(file);
  });
}
function chooseFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.zip,.json,application/zip,application/json';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

export function createMigratePage({ api, toast }) {
  const panel = $('[data-panel=migrate]');
  panel.innerHTML = '<header class="page-header"><h1>从 Grok Bot 迁移</h1></header><div id="migrate-root"></div>';
  const wizard = createMigrationWizard($('#migrate-root'), {
    toast,
    copy: copyText,
    sources: [{
      title: '上传迁移包',
      description: '把 Grok Bot 数据目录整个打包成 ZIP 后上传，或上传 Bot 导出的 rokbot-migrate.json；可以把多个导出文件放进同一个 ZIP。数据目录位置：macOS 为 ~/Library/Application Support/Grok Bot，Windows 为 %APPDATA%\\Grok Bot，Linux 为 ~/.config/Grok Bot。文件大小不限。',
      actions: [{ label: '选择 ZIP 或 JSON 文件', primary: true, run: async progress => {
        const file = await chooseFile();
        return file ? upload(file, progress) : null;
      } }],
    }],
    list: () => api('/admin/api/migrate'),
    createToken: body => api('/admin/api/migrate/tokens', { method: 'POST', body }),
    revokeToken: id => api(`/admin/api/migrate/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    prompt: ({ tokenId, scope } = {}) => api(`/admin/api/migrate/prompt?${new URLSearchParams({ ...(tokenId ? { tokenId } : {}), ...(scope ? { scope } : {}) })}`),
    preview: id => api(`/admin/api/migrate/packages/${encodeURIComponent(id)}`),
    import: (id, body) => api(`/admin/api/migrate/packages/${encodeURIComponent(id)}/import`, { method: 'POST', body }),
    discard: id => api(`/admin/api/migrate/packages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  });
  return { load: () => wizard.refresh(), reset: () => wizard.close() };
}
