// Desktop window for "Migrate from Grok Bot": the shared wizard over the main-process bridge.
import { createMigrationWizard } from './migrate-wizard.js';

const bridge = window.rokMigrate, toastElement = document.getElementById('toast');
let toastTimer, progressHandler = null;
function toast(message, error = false) {
  clearTimeout(toastTimer); toastElement.textContent = message; toastElement.classList.toggle('error', error); toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 5000);
}
bridge.onProgress(value => progressHandler?.(value));
const withProgress = work => async progress => { progressHandler = progress; try { return await work(); } finally { progressHandler = null; } };

function sources(found) {
  return [
    ...found.map(folder => ({
      title: `本机 ${folder.title}`,
      description: `${folder.path} · ${folder.legacy ? '本地缓存文件' : `${folder.cacheFiles} 个缓存文件`}。只读取 Bot 列表、侧栏分组和聊天缓存，不修改这个目录。`,
      actions: [{ label: '扫描并加入待导入', primary: true, run: withProgress(() => bridge.uploadFolder(folder.path)) }],
    })),
    { title: found.length ? '其他位置' : '没有自动找到 Grok Bot 数据目录',
      description: '可以手动选择数据目录（macOS：~/Library/Application Support/Grok Bot；Windows：%APPDATA%\\Grok Bot；Linux：~/.config/Grok Bot），或选择打包好的 ZIP、Bot 导出的 rokbot-migrate.json。',
      actions: [{ label: '选择目录', run: withProgress(() => bridge.chooseFolder()) }, { label: '选择 ZIP 或 JSON 文件', run: withProgress(() => bridge.chooseFile()) }] },
  ];
}
const wizard = createMigrationWizard(document.getElementById('root'), {
  toast, sources: sources([]),
  list: () => bridge.list(), createToken: body => bridge.createToken(body), revokeToken: id => bridge.revokeToken(id),
  prompt: options => bridge.prompt(options), preview: id => bridge.preview(id), import: (id, selection) => bridge.import(id, selection),
  discard: id => bridge.discard(id), copy: text => bridge.copy(text),
});
bridge.detect().then(found => wizard.setSources(sources(found))).catch(error => toast(error.message, true));
wizard.refresh().catch(error => toast(error.message, true));
