// Theme controller: system / light / dark. Executes synchronously in <head> to prevent FOUC.
(function () {
  'use strict';
  var root = document.documentElement;
  var KEY = 'rokbot-theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var pref = 'system';
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') pref = saved;
  } catch (e) {}

  function apply() {
    var dark = pref === 'dark' || (pref === 'system' && mq && mq.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePref = pref;
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', dark ? '#090B10' : '#F8FAFC');
    document.dispatchEvent(new CustomEvent('rokbot:theme', { detail: root.dataset.theme }));
  }

  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);

  window.rokbotTheme = {
    get: function () { return pref; },
    resolved: function () { return root.dataset.theme || 'light'; },
    set: function (next) {
      pref = next === 'light' || next === 'dark' ? next : 'system';
      try {
        if (pref === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch (e) {}
      apply();
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    var seg = document.getElementById('themeSeg');
    if (!seg) return;
    var btns = seg.querySelectorAll('button[data-theme-pref]');
    function paint() {
      for (var i = 0; i < btns.length; i++) {
        btns[i].setAttribute('aria-checked', String(btns[i].dataset.themePref === pref));
      }
    }
    paint();
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-theme-pref]');
      if (!b) return;
      window.rokbotTheme.set(b.dataset.themePref);
      paint();
    });
  });
})();
