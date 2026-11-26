// RokBot 官网交互：视频按需加载播放、截图分组切换与大图预览、补丁命令切换、代码复制、滚动淡入。零外部依赖。
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;
  var lang = function () { return root.dataset.lang === 'en' ? 'en' : 'zh'; };

  // ---------- 1. 宣传视频：点击封面后按需加载 MP4 ----------
  var promoBox = $('#promoBox');
  var promoPlay = $('#promoPlay');
  if (promoBox && promoPlay) {
    promoPlay.addEventListener('click', function () {
      var src = promoBox.dataset.video;
      var poster = promoBox.dataset.poster;
      if (!src) return;
      var video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      if (poster) video.poster = poster;
      var source = document.createElement('source');
      source.src = src;
      source.type = 'video/mp4';
      video.appendChild(source);
      promoBox.innerHTML = '';
      promoBox.classList.add('is-playing');
      promoBox.appendChild(video);
      video.focus();
    });
  }

  // ---------- 2. 通用 Tab 切换（截图区 & 补丁命令区） ----------
  function bindTabs(tablistSelector, panelAttr) {
    var list = $(tablistSelector);
    if (!list) return;
    var tabs = $$('[role="tab"]', list);
    var panels = $$('[' + panelAttr + ']');

    function activate(tab, focus) {
      var target = tab.dataset.tab;
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (p) {
        p.hidden = p.getAttribute(panelAttr) !== target;
      });
      if (focus) tab.focus();
    }

    tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () { activate(tab, false); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          activate(tabs[next], true);
        }
      });
    });
  }
  bindTabs('#screenTabs', 'data-screen-panel');
  bindTabs('#patchTabs', 'data-patch-panel');

  // ---------- 3. 截图大图预览（原生 <dialog>） ----------
  var dlg = $('#lightbox');
  var dlgImg = $('#lbImg');
  var dlgCap = $('#lbCap');
  var dlgClose = $('#lbClose');
  var dlgPrev = $('#lbPrev');
  var dlgNext = $('#lbNext');
  var activeList = [];
  var activeIdx = 0;

  function captionOf(fig) {
    var cap = fig.querySelector('figcaption');
    if (!cap) return '';
    var span = cap.querySelector('[lang="' + lang() + '"]');
    return span ? span.textContent.trim() : cap.textContent.trim();
  }

  function showLightboxItem(idx) {
    if (!activeList.length || !dlgImg) return;
    activeIdx = (idx + activeList.length) % activeList.length;
    var fig = activeList[activeIdx];
    var img = fig.querySelector('img');
    if (!img) return;
    dlgImg.src = img.currentSrc || img.src;
    dlgImg.alt = img.alt || '';
    dlgImg.className = fig.classList.contains('shot-phone') ? 'is-phone' : 'is-wide';
    if (dlgCap) dlgCap.textContent = captionOf(fig);
  }

  if (dlg && typeof dlg.showModal === 'function') {
    $$('.shot-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panel = btn.closest('[data-screen-panel]');
        activeList = panel ? $$('figure', panel) : [btn.closest('figure')];
        var fig = btn.closest('figure');
        activeIdx = Math.max(0, activeList.indexOf(fig));
        showLightboxItem(activeIdx);
        dlg.showModal();
      });
    });
    if (dlgClose) dlgClose.addEventListener('click', function () { dlg.close(); });
    if (dlgPrev) dlgPrev.addEventListener('click', function () { showLightboxItem(activeIdx - 1); });
    if (dlgNext) dlgNext.addEventListener('click', function () { showLightboxItem(activeIdx + 1); });
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); showLightboxItem(activeIdx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); showLightboxItem(activeIdx + 1); }
    });
    document.addEventListener('rokbot:lang', function () {
      if (dlg.open) showLightboxItem(activeIdx);
    });
  }

  // ---------- 4. 代码块复制按钮 ----------
  $$('.copy-btn').forEach(function (btn) {
    var timer = null;
    btn.addEventListener('click', function () {
      var pre = btn.closest('.code-wrap') && btn.closest('.code-wrap').querySelector('pre');
      if (!pre) return;
      var text = pre.textContent.trim();
      var done = function () {
        btn.classList.add('is-copied');
        clearTimeout(timer);
        timer = setTimeout(function () { btn.classList.remove('is-copied'); }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      }
    });
  });

  // ---------- 5. 滚动淡入（尊重 prefers-reduced-motion） ----------
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && window.IntersectionObserver) {
    root.classList.add('motion');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.02 });
    $$('.reveal').forEach(function (el) { io.observe(el); });
  }
})();
