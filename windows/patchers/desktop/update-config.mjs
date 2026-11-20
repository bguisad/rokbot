import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeEcPublicKey,
  patchDesktopUpdateSettingsUi as macPatchDesktopUpdateSettingsUi,
  resolveDesktopUpdateConfig,
  validUpdateUrl,
} from '../../../mac/patchers/desktop/update-config.mjs';

export { normalizeEcPublicKey, resolveDesktopUpdateConfig, validUpdateUrl };

const UPDATE_SETTINGS_ANCHOR_123 =
  'function D(){D.d=2788;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}';
const UPDATE_SETTINGS_REPLACEMENT_123 =
  'function GrokLocalUpdateSettings(){return u().row({loading:(0,x.jsx)(GrokLocalVersion,{}),empty:(0,x.jsx)(GrokLocalVersion,{}),unavailable:(0,x.jsx)(GrokLocalVersion,{}),value:t=>t?.delivery==="in-app"?(0,x.jsx)(T,{}):(0,x.jsx)(GrokLocalVersion,{})})}function D(){D.d=2788;return(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalUpdateSettings,{})})}';

export async function patchDesktopUpdateSettingsUi(unpacked) {
  const assetsDir = path.join(unpacked, 'dist/renderer/assets');
  const entries = (await readdir(assetsDir)).filter(name => /^chunk-view-.*\.js$/.test(name)).sort();
  const candidates = [];
  for (const name of entries) {
    const filename = path.join(assetsDir, name);
    const content = await readFile(filename, 'utf8');
    if (content.includes('function GrokOriginalUpdateSettings(')) {
      candidates.push({ kind: '0.71.2', name, filename, content });
    } else if (content.includes('function GrokLocalVersion(')) {
      const is123 =
        content.includes('D.d=2788') ||
        content.includes('T.d=3033') ||
        content.includes('1.2.3 Updates module') ||
        /'1\.2\.3'|"1\.2\.3"/.test(content) ||
        (content.includes('u()') && content.includes('function T(') && content.includes('function D(){') && content.includes('(0,x.jsx)') && content.includes('v.c'));
      candidates.push({ kind: is123 ? '1.2.3' : '1.1.0', name, filename, content });
    }
  }
  if (candidates.length === 1 && candidates[0].kind === '1.2.3') {
    const { name, filename, content } = candidates[0];
    if (content.includes('function GrokLocalUpdateSettings(')) {
      throw new Error(`更新设置模块已被修改：${name}`);
    }
    if (
      !content.includes('u()') ||
      !content.includes('function T(') ||
      !content.includes('function D(){') ||
      !content.includes('(0,x.jsx)') ||
      !content.includes('v.c')
    ) {
      throw new Error(`更新设置模块缺少必需符号：${name}`);
    }
    const at = content.indexOf(UPDATE_SETTINGS_ANCHOR_123);
    if (at < 0) {
      throw new Error(`更新设置模块缺少预期锚点：${name}`);
    }
    if (content.indexOf(UPDATE_SETTINGS_ANCHOR_123, at + 1) >= 0) {
      throw new Error(`更新设置模块锚点不唯一：${name}`);
    }
    const updated = content.slice(0, at) + UPDATE_SETTINGS_REPLACEMENT_123 + content.slice(at + UPDATE_SETTINGS_ANCHOR_123.length);
    await writeFile(filename, updated, 'utf8');
    return { file: `dist/renderer/assets/${name}` };
  }
  return macPatchDesktopUpdateSettingsUi(unpacked);
}
