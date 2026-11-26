import { t, html } from './i18n.js';
import { $, node, item, badge, empty, iconButton, confirmAction, date } from './ui.js';
import { icon } from './icons.js';

const MiB = 1024 * 1024;
const platforms = [
  ['android', 'Android'],
  ['ios', 'iOS'],
  ['macos', 'macOS'],
  ['windows', 'Windows'],
  ['linux', 'Linux'],
];
const tracks = [
  ['stable', '稳定版'],
  ['nightly', '每夜版'],
  ['dogfood', '内测版'],
];
const macTargets = [
  ['darwin-arm64', 'Apple Silicon (arm64)'],
  ['darwin-x64', 'Intel (x64)'],
];
const linuxTargets = [
  ['linux-x64', 'Linux (x64 / amd64)'],
  ['linux-arm64', 'Linux (arm64)'],
];

function uploadBinary({ platform, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const query = new URLSearchParams({ platform, filename: file.name });
    request.open('POST', `/admin/api/updates/upload?${query}`);
    request.setRequestHeader('content-type', 'application/octet-stream');
    request.setRequestHeader('x-rokbot-csrf', '1');
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let value = null;
      try { value = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300 && value) resolve(value);
      else reject(new Error(typeof value?.error === 'string' ? t(value.error) : t('请求失败 ({0})', request.status)));
    };
    request.onerror = () => reject(new Error(t('无法连接管理服务。')));
    request.send(file);
  });
}

const formatSize = bytes => bytes >= MiB
  ? `${(bytes / MiB).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function createUpdatesPage({ api, toast, busy, act, copy }) {
  const panel = $('[data-panel=updates]');
  panel.innerHTML = html(`<header class="page-header"><h1>客户端更新</h1><div class="page-actions"><button id="updates-refresh" class="icon-btn" type="button" aria-label="刷新">${icon('refresh')}</button></div></header>
    <div id="updates-platform-tabs" class="chips" role="tablist" aria-label="客户端平台">${platforms.map(([id, label], index) =>
      `<label class="chip"><input type="radio" name="updates-view-platform" value="${id}" ${index === 0 ? 'checked' : ''} /><span>${label}</span></label>`).join('')}</div>
    <form id="updates-publish-form" class="sections">
      <section class="section">
        <div class="section-head"><h2 class="section-title">上传并发布新版本</h2></div>
        <div class="card">
          <label class="row"><span class="row-copy"><span class="row-title">目标平台</span></span><select id="updates-platform" name="platform">${platforms.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
          <label class="row" id="updates-arch-row" hidden><span class="row-copy"><span id="updates-arch-label" class="row-title">目标架构</span></span><select id="updates-arch" name="targetPlatform">${macTargets.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
          <label class="row"><span class="row-copy"><span class="row-title">发布通道</span></span><select id="updates-track" name="track">${tracks.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>
          <div class="row"><span class="row-copy"><span class="row-title">安装包文件</span><span id="updates-artifact-hint" class="row-hint">支持上传已签名的 .apk、.ipa、.dmg、.zip、.exe、.deb、.AppImage 或 .tar.gz 文件</span></span>
            <span class="row-control auto"><input id="updates-artifact-file" type="file" accept=".apk,.ipa,.dmg,.zip,.exe,.deb,.AppImage,.tar.gz,.gz" hidden /><button id="updates-artifact-upload" class="btn" type="button">选择安装包</button></span></div>
          <div class="row" id="updates-asar-row" hidden><span class="row-copy"><span class="row-title">桌面端 app.asar（可选）</span><span id="updates-asar-hint" class="row-hint">上传后可为桌面客户端生成轻量级 ASAR 增量更新</span></span>
            <span class="row-control auto"><input id="updates-asar-file" type="file" accept=".asar" hidden /><button id="updates-asar-upload" class="btn" type="button">选择 ASAR</button></span></div>
          <label class="row"><span class="row-copy"><span class="row-title">版本号</span></span><input id="updates-version" name="version" type="text" placeholder="1.16.0" required /></label>
          <label class="row" id="updates-code-row"><span class="row-copy"><span id="updates-code-label" class="row-title">数字版本号 (versionCode)</span></span><input id="updates-version-code" name="versionCode" type="text" placeholder="100" /></label>
          <label class="row" id="updates-pkg-row"><span class="row-copy"><span id="updates-pkg-label" class="row-title">应用包名 (packageName)</span></span><input id="updates-package-name" name="packageName" type="text" placeholder="dev.rokbot.nativeapp" /></label>
          <label class="row" id="updates-cert-row"><span class="row-copy"><span class="row-title">签名证书 SHA-256</span><span class="row-hint">上传 APK 时自动提取，也可手动填写 64 位十六进制指纹</span></span><input id="updates-cert-sha" name="certificateSha256" type="text" spellcheck="false" placeholder="可选，自动识别" /></label>
          <label class="row" id="updates-delta-row"><span class="row-copy"><span class="row-title">生成增量补丁（基于旧版本）</span><span class="row-hint">自动生成二进制增量补丁，大幅减小客户端更新下载体积</span></span><select id="updates-delta-from" name="generateDeltaFrom"><option value="">不生成增量补丁</option></select></label>
          <label class="row stack"><span class="row-copy"><span class="row-title">更新说明</span></span><textarea id="updates-notes" name="releaseNotes" rows="3" placeholder="修复问题与功能更新说明"></textarea></label>
        </div>
        <div class="actions"><span id="updates-upload-status" class="status-text" role="status"></span><button id="updates-publish-btn" type="submit" class="btn btn-primary" disabled>发布更新</button></div>
      </section>
    </form>
    <section class="section"><div class="section-head"><h2 class="section-title">已发布版本</h2></div><div id="updates-releases" class="card"></div></section>
    <section class="section" id="updates-ios-section" hidden>
      <div class="section-head"><h2 class="section-title">iOS OTA 安装与订阅</h2></div>
      <div class="card">
        <label class="row"><span class="row-copy"><span class="row-title">开放 iOS 公开更新订阅</span><span class="row-hint">关闭时仅允许通过带独立能力令牌的 OTA 链接下载</span></span><input id="updates-public-ios" type="checkbox" role="switch" aria-label="开放 iOS 公开更新订阅" /></label>
        <div id="updates-ios-links"></div>
        <p id="updates-ios-http-warn" class="hint" hidden>当前使用 http 地址。Apple itms-services 在真机上要求受信任的 https 证书；AltStore 或本地测试可直接使用。</p>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2 class="section-title">桌面端清单签名公钥 (ECDSA P-256)</h2></div>
      <div class="card">
        <div id="updates-key-fingerprint"></div>
        <div class="row stack">
          <div class="row-copy"><span class="row-title">SPKI Base64 公钥</span><span class="row-hint">内置于客户端的更新校验公钥</span></div>
          <div class="row-control auto"><code id="updates-key-spki" class="row-value"></code><button id="updates-copy-spki" class="icon-btn" type="button" aria-label="复制 Base64 公钥">${icon('copy')}</button></div>
        </div>
        <div class="row stack">
          <div class="row-copy"><span class="row-title">SPKI PEM 公钥</span></div>
          <pre id="updates-key-pem" class="code-block"></pre>
          <div class="actions"><button id="updates-copy-pem" class="btn btn-sm" type="button">复制 PEM 公钥</button></div>
        </div>
      </div>
    </section>`);

  let activePlatform = 'android';
  let overview = null;
  let uploadedArtifact = null;
  let uploadedAsar = null;

  const platformSelect = $('#updates-platform');
  const trackSelect = $('#updates-track');
  const publishBtn = $('#updates-publish-btn');
  const uploadStatus = $('#updates-upload-status');

  function syncFormFields() {
    const p = platformSelect.value;
    const isDesktop = p === 'macos' || p === 'windows' || p === 'linux';
    const hasArch = p === 'macos' || p === 'linux';
    $('#updates-arch-row').hidden = !hasArch;
    if (hasArch) {
      const archSelect = $('#updates-arch');
      const targets = p === 'linux' ? linuxTargets : macTargets;
      if (archSelect.dataset.platform !== p) {
        archSelect.dataset.platform = p;
        archSelect.replaceChildren(...targets.map(([id, label]) => new Option(label, id)));
      }
      $('#updates-arch-label').textContent = p === 'linux' ? t('Linux 架构') : t('macOS 架构');
    }
    $('#updates-asar-row').hidden = !isDesktop;
    $('#updates-code-row').hidden = isDesktop;
    $('#updates-pkg-row').hidden = isDesktop;
    $('#updates-cert-row').hidden = p !== 'android';
    $('#updates-delta-row').hidden = p === 'ios';
    $('#updates-code-label').textContent = p === 'ios' ? t('构建号 (build)') : t('数字版本号 (versionCode)');
    $('#updates-pkg-label').textContent = p === 'ios' ? t('Bundle ID') : t('应用包名 (packageName)');
    $('#updates-package-name').placeholder = p === 'ios' ? 'dev.rokbot.local' : 'dev.rokbot.nativeapp';
    $('#updates-version-code').placeholder = p === 'ios' ? '1' : '100';
    refreshDeltaCandidates();
  }

  function refreshDeltaCandidates() {
    const select = $('#updates-delta-from');
    const p = platformSelect.value;
    const arch = $('#updates-arch').value;
    const hasArch = p === 'macos' || p === 'linux';
    const prior = (overview?.releases ?? []).filter(
      r => r.platform === p && (!hasArch || !r.targetPlatform || r.targetPlatform === arch),
    );
    select.replaceChildren(new Option(t('不生成增量补丁'), ''));
    for (const rel of prior) {
      const label = rel.platform === 'android'
        ? `${rel.versionName} (${rel.versionCode}) · ${rel.filename}`
        : (rel.platform === 'macos' || rel.platform === 'linux') && rel.targetPlatform
          ? `${rel.version} (${rel.targetPlatform}) · ${rel.filename}`
          : `${rel.version} · ${rel.filename}`;
      select.add(new Option(label, rel.id));
    }
  }

  function linkRow(title, value) {
    const row = node('div', 'row');
    const copyCol = node('span', 'row-copy');
    copyCol.append(node('span', 'row-title', title));
    const ctrl = node('span', 'row-control auto');
    const code = node('code', 'row-value', value);
    code.dataset.private = '';
    ctrl.append(code, iconButton('copy', t('复制链接'), () => copy(value)));
    row.append(copyCol, ctrl);
    return row;
  }

  function renderReleases() {
    const root = $('#updates-releases');
    root.replaceChildren();
    const list = (overview?.releases ?? []).filter(r => r.platform === activePlatform);
    if (!list.length) {
      root.append(empty(t('暂无已发布版本'), t('在上方上传签名安装包后即可发布更新。')));
      return;
    }
    for (const rel of list) {
      const deltasCount = (rel.deltas?.length ?? 0) + (rel.asarDeltas?.length ?? 0);
      const versionTitle = rel.platform === 'android'
        ? `${rel.versionName} (${rel.versionCode})`
        : rel.platform === 'ios'
          ? `${rel.version} (${rel.build})`
          : rel.version;
      const badges = [
        badge(t(tracks.find(([id]) => id === rel.track)?.[1] ?? rel.track), rel.track === 'stable' ? 'success' : 'accent'),
        badge(formatSize(rel.size)),
      ];
      if (rel.targetPlatform && (rel.platform === 'macos' || rel.platform === 'linux')) badges.push(badge(rel.targetPlatform));
      if (deltasCount > 0) badges.push(badge(t('{0} 个增量补丁', deltasCount), 'accent'));
      const meta = [
        `${rel.filename} · SHA-256 ${rel.sha256.slice(0, 12)}`,
        `${t('发布时间')} · ${date(rel.publishedAt)}`,
        rel.releaseNotes || '',
      ];
      const delBtn = iconButton('close', t('删除此版本'), () => busy(delBtn, async () => {
        if (!await confirmAction({
          title: t('删除版本“{0}”？', versionTitle),
          message: t('删除后客户端将无法再从此 Host 拉取该版本及关联增量补丁。'),
          action: t('删除'),
        })) return;
        await api(`/admin/api/updates/${encodeURIComponent(rel.platform)}/${encodeURIComponent(rel.id)}`, { method: 'DELETE' });
        toast(t('更新版本已删除'));
        await load();
      }).catch(error => toast(error.message, true)));
      root.append(item({ icon: 'package', title: versionTitle, badges, meta, actions: [delBtn] }));
    }
  }

  function renderIosSection() {
    const section = $('#updates-ios-section');
    const iosReleases = (overview?.releases ?? []).filter(r => r.platform === 'ios');
    section.hidden = activePlatform !== 'ios' && iosReleases.length === 0;
    $('#updates-public-ios').checked = overview?.publicIosFeed === true;
    const linksRoot = $('#updates-ios-links');
    linksRoot.replaceChildren();
    const latest = iosReleases[0];
    if (!latest?.installMethods) {
      linksRoot.append(node('p', 'hint', t('发布 iOS 版本后，将在此生成 Safari itms-services 与 AltStore 订阅链接。')));
    } else {
      linksRoot.append(
        linkRow(t('Safari 一键安装 (itms-services)'), latest.installMethods.itmsServicesUrl),
        linkRow(t('iOS Manifest Plist'), latest.installMethods.manifestPlistUrl),
        linkRow(t('AltStore / SideStore 源'), latest.installMethods.altStoreSourceUrl),
        linkRow(t('IPA 直链'), latest.installMethods.ipaDownloadUrl),
      );
    }
    $('#updates-ios-http-warn').hidden = location.protocol !== 'http:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  }

  function renderSigningKey() {
    const key = overview?.signingKey;
    if (!key) return;
    const fpRoot = $('#updates-key-fingerprint');
    fpRoot.replaceChildren();
    const fpRow = node('div', 'fingerprint');
    const copyCol = node('div', 'row-copy');
    const formattedFp = String(key.fingerprintSha256 ?? '').match(/.{1,8}/g)?.join(' ') ?? '';
    copyCol.append(node('span', 'row-hint', t('公钥指纹 · SHA-256')), node('code', '', formattedFp));
    fpRow.append(copyCol, iconButton('copy', t('复制指纹'), () => copy(key.fingerprintSha256)));
    fpRoot.append(fpRow);
    $('#updates-key-spki').textContent = key.publicKeySpkiBase64;
    $('#updates-key-pem').textContent = key.publicKeyPem;
  }

  function renderAll() {
    refreshDeltaCandidates();
    renderReleases();
    renderIosSection();
    renderSigningKey();
  }

  async function load() {
    overview = await api('/admin/api/updates');
    renderAll();
  }

  for (const radio of panel.querySelectorAll('input[name="updates-view-platform"]')) {
    radio.onchange = () => {
      activePlatform = radio.value;
      platformSelect.value = activePlatform;
      uploadedArtifact = null;
      uploadedAsar = null;
      publishBtn.disabled = true;
      uploadStatus.textContent = '';
      syncFormFields();
      renderAll();
    };
  }

  platformSelect.onchange = () => {
    uploadedArtifact = null;
    uploadedAsar = null;
    publishBtn.disabled = true;
    uploadStatus.textContent = '';
    syncFormFields();
  };
  $('#updates-arch').onchange = () => refreshDeltaCandidates();

  $('#updates-artifact-upload').onclick = () => $('#updates-artifact-file').click();
  $('#updates-artifact-file').onchange = () => {
    const file = $('#updates-artifact-file').files[0];
    $('#updates-artifact-file').value = '';
    if (!file) return;
    const btn = $('#updates-artifact-upload');
    busy(btn, async () => {
      try {
        const res = await uploadBinary({
          platform: platformSelect.value,
          file,
          onProgress: fraction => {
            const pct = Math.round(fraction * 100);
            btn.textContent = t('正在上传 {0}%', pct);
            uploadStatus.textContent = t('正在上传 {0}%', pct);
          },
        });
        uploadedArtifact = res;
        publishBtn.disabled = false;
        uploadStatus.textContent = t('已上传 {0} ({1})', res.filename, formatSize(res.size));
        if (res.apkInfo) {
          if (res.apkInfo.versionName && !$('#updates-version').value) $('#updates-version').value = res.apkInfo.versionName;
          if (res.apkInfo.versionCode && !$('#updates-version-code').value) $('#updates-version-code').value = String(res.apkInfo.versionCode);
          if (res.apkInfo.packageName && !$('#updates-package-name').value) $('#updates-package-name').value = res.apkInfo.packageName;
          if (res.apkInfo.certificateSha256 && !$('#updates-cert-sha').value) $('#updates-cert-sha').value = res.apkInfo.certificateSha256;
        }
        toast(t('安装包已上传'));
      } catch (error) {
        uploadStatus.textContent = error.message;
        toast(error.message, true);
      }
    });
  };

  $('#updates-asar-upload').onclick = () => $('#updates-asar-file').click();
  $('#updates-asar-file').onchange = () => {
    const file = $('#updates-asar-file').files[0];
    $('#updates-asar-file').value = '';
    if (!file) return;
    const btn = $('#updates-asar-upload');
    busy(btn, async () => {
      try {
        const res = await uploadBinary({
          platform: platformSelect.value,
          file,
          onProgress: fraction => {
            btn.textContent = t('正在上传 {0}%', Math.round(fraction * 100));
          },
        });
        uploadedAsar = res;
        $('#updates-asar-hint').textContent = t('已上传 ASAR：{0} ({1})', res.filename, formatSize(res.size));
        toast(t('ASAR 文件已上传'));
      } catch (error) { toast(error.message, true); }
    });
  };

  $('#updates-publish-form').onsubmit = event => {
    event.preventDefault();
    if (!uploadedArtifact) { toast(t('请先上传该安装包文件'), true); return; }
    act(publishBtn, async () => {
      const p = platformSelect.value;
      const body = {
        platform: p,
        track: trackSelect.value,
        filename: uploadedArtifact.filename,
        version: $('#updates-version').value.trim(),
        releaseNotes: $('#updates-notes').value.trim(),
      };
      if (p === 'macos' || p === 'linux') body.targetPlatform = $('#updates-arch').value;
      if (p === 'android') {
        if ($('#updates-version-code').value.trim()) body.versionCode = Number($('#updates-version-code').value.trim());
        if ($('#updates-package-name').value.trim()) body.packageName = $('#updates-package-name').value.trim();
        if ($('#updates-cert-sha').value.trim()) body.certificateSha256 = $('#updates-cert-sha').value.trim();
      }
      if (p === 'ios') {
        if ($('#updates-version-code').value.trim()) body.build = $('#updates-version-code').value.trim();
        if ($('#updates-package-name').value.trim()) body.bundleId = $('#updates-package-name').value.trim();
      }
      if (uploadedAsar) {
        body.asarFilename = uploadedAsar.filename;
        if (uploadedAsar.asarHeaderSha256) body.asarHeaderSha256 = uploadedAsar.asarHeaderSha256;
      }
      const deltaFrom = $('#updates-delta-from').value;
      if (deltaFrom) body.generateDeltaFrom = deltaFrom;

      await api('/admin/api/updates/publish', { method: 'POST', body });
      activePlatform = p;
      const tabRadio = panel.querySelector(`input[name="updates-view-platform"][value="${p}"]`);
      if (tabRadio) tabRadio.checked = true;
      uploadedArtifact = null;
      uploadedAsar = null;
      publishBtn.disabled = true;
      uploadStatus.textContent = '';
      $('#updates-notes').value = '';
      toast(t('更新版本已发布'));
      await load();
    });
  };

  $('#updates-public-ios').onchange = event => {
    const enabled = event.target.checked;
    busy(event.target, async () => {
      try {
        await api('/admin/api/updates/settings', { method: 'PATCH', body: { publicIosFeed: enabled } });
        toast(enabled ? t('已开放 iOS 公开订阅') : t('已关闭 iOS 公开订阅'));
        await load();
      } catch (error) {
        event.target.checked = !enabled;
        toast(error.message, true);
      }
    });
  };

  $('#updates-refresh').onclick = () => act($('#updates-refresh'), load);
  $('#updates-copy-spki').onclick = () => overview?.signingKey && copy(overview.signingKey.publicKeySpkiBase64);
  $('#updates-copy-pem').onclick = () => overview?.signingKey && copy(overview.signingKey.publicKeyPem);

  syncFormFields();

  return {
    load,
    reset() {
      overview = null;
      uploadedArtifact = null;
      uploadedAsar = null;
      publishBtn.disabled = true;
      uploadStatus.textContent = '';
    },
  };
}
