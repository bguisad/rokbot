// Bilingual switcher (zh / en): supports ?lang=zh|en, localStorage, and browser locale fallback.
// Placeholder domain: SITE_URL = 'https://rokbot.cosfoc.com'
(function () {
  'use strict';
  var root = document.documentElement;
  var KEY = 'rokbot-lang';
  var is404 = root.dataset.page === '404';
  var metaDesc = document.querySelector('meta[name="description"]');

  function set(l) {
    var lang = l === 'en' ? 'en' : 'zh';
    root.dataset.lang = lang;
    root.lang = lang === 'en' ? 'en' : 'zh-CN';
    if (is404) {
      document.title = '404 · RokBot';
    } else {
      document.title = lang === 'en'
        ? 'RokBot · Self-Hosted Bot Host, Cloud Desktop & Native Clients'
        : 'RokBot · 自托管 Bot Host、云电脑与多端原生客户端';
      if (metaDesc) {
        metaDesc.setAttribute('content', lang === 'en'
          ? 'RokBot is a private self-hosted deployment for Grok Bot: Docker Bot Host, shared Linux cloud desktop with live VNC takeover, bring-your-own models with fallback chains, and native clients for Android, iOS, macOS, Windows, and Web.'
          : 'RokBot 是 Grok Bot 的私有部署方案：Docker 自托管 Bot Host 与云电脑实时接管，自选 OpenAI / Anthropic 兼容模型与备用链，数据留在本地，配套 Android、iOS、macOS、Windows 和网页客户端。');
      }
    }
    document.dispatchEvent(new CustomEvent('rokbot:lang', { detail: lang }));
  }

  var q = new URLSearchParams(location.search).get('lang');
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  set(q === 'en' || q === 'zh' ? q : saved || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en'));

  window.rokbotLang = {
    get: function () { return root.dataset.lang === 'en' ? 'en' : 'zh'; },
    set: function (l) {
      set(l);
      try { localStorage.setItem(KEY, l === 'en' ? 'en' : 'zh'); } catch (e) {}
    }
  };

  var btn = document.getElementById('langBtn');
  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.dataset.lang === 'en' ? 'zh' : 'en';
      window.rokbotLang.set(next);
    });
  }
})();
