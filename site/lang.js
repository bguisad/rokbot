// 双语切换：支持 ?lang=zh|en、localStorage 与浏览器语言默认回退。
// 站点占位域名配置：SITE_URL = 'https://rokbot.cosfoc.com'（最终域名确定后统一替换）
(function () {
  var root = document.documentElement, KEY = 'rokbot-lang';
  var is404 = root.dataset.page === '404';
  var metaDesc = document.querySelector('meta[name="description"]');
  function set(l) {
    root.dataset.lang = l;
    root.lang = l === 'en' ? 'en' : 'zh-CN';
    if (is404) {
      document.title = l === 'en' ? '404 · RokBot' : '404 · RokBot';
    } else {
      document.title = l === 'en'
        ? 'RokBot · Self-hosted Bot Host & Native Clients'
        : 'RokBot · 自托管 Bot Host 与多端原生客户端';
      if (metaDesc) {
        metaDesc.setAttribute('content', l === 'en'
          ? 'RokBot is a third-party self-hosted deployment for Grok Bot: Docker Bot Host, shared Linux execution desktop, bring-your-own models, and native clients for macOS, Windows, iOS, Android, and Web.'
          : 'RokBot 是 Grok Bot 的第三方私有部署方案：Docker 自托管 Bot Host 与共享云电脑，自选模型与备用链，数据留在本地，支持 Android、iOS、macOS、Windows 和网页版。');
      }
    }
    document.dispatchEvent(new CustomEvent('rokbot:lang', { detail: l }));
  }
  var q = new URLSearchParams(location.search).get('lang');
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  set(q === 'en' || q === 'zh' ? q : saved || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en'));
  var btn = document.getElementById('langBtn');
  if (btn) {
    btn.addEventListener('click', function () {
      var l = root.dataset.lang === 'en' ? 'zh' : 'en';
      set(l);
      try { localStorage.setItem(KEY, l); } catch (e) {}
    });
  }
})();
