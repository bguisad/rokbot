// RokBot Site Engine: Hero Canvas + Parallax, Scroll Reveal, Counters, Sticky Walkthrough,
// Draggable Marquee Gallery + Lightbox, Lazy Promo Video, Patch Tabs, Copy, Mobile Drawer.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var motionOK = function () { return !reduceMQ.matches; };

  // ---------- 1. Mobile Navigation Drawer ----------
  var menuBtn = $('#mobileMenuBtn');
  var drawer = $('#mobileDrawer');
  if (menuBtn && drawer) {
    menuBtn.addEventListener('click', function () {
      var open = drawer.classList.toggle('is-open');
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    $$('a', drawer).forEach(function (a) {
      a.addEventListener('click', function () {
        drawer.classList.remove('is-open');
        menuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ---------- 2. Hero Dynamic Constellation Canvas & Pointer Parallax ----------
  var heroSection = $('#hero');
  var canvas = $('#heroCanvas');
  var heroStack = $('#heroStack');

  if (heroSection && canvas && canvas.getContext && motionOK()) {
    var ctx = canvas.getContext('2d');
    var nodes = [];
    var cw = 0, ch = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var heroVisible = true;
    var rafId = null;
    var pointerX = -999, pointerY = -999;

    function resizeCanvas() {
      var rect = heroSection.getBoundingClientRect();
      cw = Math.max(320, Math.floor(rect.width));
      ch = Math.max(320, Math.floor(rect.height));
      canvas.width = Math.floor(cw * dpr);
      canvas.height = Math.floor(ch * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var count = cw < 640 ? 18 : 34;
      if (nodes.length !== count) {
        nodes = [];
        for (var i = 0; i < count; i++) {
          nodes.push({
            x: Math.random() * cw,
            y: Math.random() * ch,
            vx: (Math.random() - 0.5) * 0.36,
            vy: (Math.random() - 0.5) * 0.36,
            r: 1.4 + Math.random() * 1.8
          });
        }
      }
    }

    function drawFrame() {
      if (!heroVisible || document.hidden || !motionOK()) {
        rafId = null;
        return;
      }
      ctx.clearRect(0, 0, cw, ch);
      var isDark = root.dataset.theme === 'dark';
      var dotColor = isDark ? 'rgba(236, 236, 238, 0.42)' : 'rgba(28, 28, 30, 0.28)';
      var lineRgb = isDark ? '236, 236, 238' : '28, 28, 30';

      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > cw) n.vx *= -1;
        if (n.y < 0 || n.y > ch) n.vy *= -1;

        for (var j = i + 1; j < nodes.length; j++) {
          var m = nodes[j];
          var dx = n.x - m.x, dy = n.y - m.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 145) {
            var alpha = (1 - dist / 145) * (isDark ? 0.22 : 0.14);
            ctx.strokeStyle = 'rgba(' + lineRgb + ',' + alpha.toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(m.x, m.y);
            ctx.stroke();
          }
        }
        if (pointerX > 0) {
          var pdx = n.x - pointerX, pdy = n.y - pointerY;
          var pdist = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pdist < 170) {
            ctx.strokeStyle = 'rgba(' + lineRgb + ',' + ((1 - pdist / 170) * 0.3).toFixed(3) + ')';
            ctx.beginPath();
            ctx.moveTo(n.x, n.y);
            ctx.lineTo(pointerX, pointerY);
            ctx.stroke();
          }
        }
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      rafId = requestAnimationFrame(drawFrame);
    }

    function startCanvas() {
      if (!rafId && heroVisible && !document.hidden && motionOK()) {
        rafId = requestAnimationFrame(drawFrame);
      }
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        heroVisible = entries[0].isIntersecting;
        if (heroVisible) startCanvas();
      }, { threshold: 0.05 }).observe(heroSection);
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) startCanvas();
    });
    heroSection.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var r = heroSection.getBoundingClientRect();
      pointerX = e.clientX - r.left;
      pointerY = e.clientY - r.top;
      if (heroStack && window.innerWidth > 960) {
        var nx = (pointerX / r.width - 0.5) * 2;
        var ny = (pointerY / r.height - 0.5) * 2;
        heroStack.style.transform = 'rotateY(' + (nx * 4.5).toFixed(2) + 'deg) rotateX(' + (-ny * 3.5).toFixed(2) + 'deg)';
      }
    });
    heroSection.addEventListener('pointerleave', function () {
      pointerX = -999;
      pointerY = -999;
      if (heroStack) heroStack.style.transform = '';
    });
    startCanvas();
  }

  // ---------- 3. Scroll Reveal & Animated Number Counters ----------
  var reveals = $$('.reveal');
  if (motionOK() && 'IntersectionObserver' in window) {
    root.classList.add('motion');
    var revIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.01, rootMargin: '0px 0px 80px 0px' });
    reveals.forEach(function (el) { revIO.observe(el); });
    var checkVisible = function () {
      var vh = window.innerHeight || 800;
      reveals.forEach(function (el) {
        if (el.classList.contains('is-visible')) return;
        var r = el.getBoundingClientRect();
        if (r.top < vh + 60) {
          el.classList.add('is-visible');
          revIO.unobserve(el);
        }
      });
    };
    window.addEventListener('scroll', checkVisible, { passive: true });
    checkVisible();
  }

  var counters = $$('[data-count-to]');
  function animateCounter(el) {
    var target = Number(el.dataset.countTo || 0);
    if (!motionOK() || target === 0) {
      el.textContent = String(target);
      return;
    }
    var dur = 1100;
    var start = performance.now();
    function step(now) {
      var p = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(eased * target));
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = String(target);
    }
    requestAnimationFrame(step);
  }
  if (counters.length) {
    if ('IntersectionObserver' in window && motionOK()) {
      var cntIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            cntIO.unobserve(entry.target);
          }
        });
      }, { threshold: 0.35 });
      counters.forEach(function (c) { cntIO.observe(c); });
    } else {
      counters.forEach(function (c) { c.textContent = c.dataset.countTo; });
    }
  }

  // ---------- 4. Sticky Feature Walkthrough ----------
  var stickySteps = $$('.sticky-step[data-step]');
  var stickySlides = $$('.sticky-slide[data-slide]');
  function setStickyStep(idx) {
    stickySteps.forEach(function (s) {
      var on = s.dataset.step === idx;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-current', on ? 'step' : 'false');
    });
    stickySlides.forEach(function (sl) {
      sl.classList.toggle('is-active', sl.dataset.slide === idx);
    });
  }
  if (stickySteps.length && stickySlides.length) {
    stickySteps.forEach(function (step) {
      step.addEventListener('click', function () { setStickyStep(step.dataset.step); });
    });
    if ('IntersectionObserver' in window) {
      var stickyIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && window.innerWidth > 1080) {
            setStickyStep(entry.target.dataset.step);
          }
        });
      }, { rootMargin: '-32% 0px -48% 0px', threshold: 0.05 });
      stickySteps.forEach(function (s) { stickyIO.observe(s); });
    }
  }

  // ---------- 5. Android Phone Gallery: Auto-Marquee + Drag + Grid Toggle ----------
  var phoneTrack = $('#phoneTrack');
  var phonePrev = $('#phonePrev');
  var phoneNext = $('#phoneNext');
  var phoneGridBtn = $('#phoneGridToggle');
  var marqueeHover = false;
  var marqueeDragging = false;
  var marqueeInView = false;
  var dragMoved = false;

  if (phoneTrack) {
    var dragStartX = 0, scrollStart = 0;
    phoneTrack.addEventListener('pointerdown', function (e) {
      if (phoneTrack.classList.contains('is-grid') || e.button !== 0) return;
      marqueeDragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      scrollStart = phoneTrack.scrollLeft;
      phoneTrack.classList.add('is-dragging');
    });
    window.addEventListener('pointermove', function (e) {
      if (!marqueeDragging) return;
      var dx = e.clientX - dragStartX;
      if (Math.abs(dx) > 5) dragMoved = true;
      phoneTrack.scrollLeft = scrollStart - dx;
    });
    window.addEventListener('pointerup', function () {
      if (!marqueeDragging) return;
      marqueeDragging = false;
      phoneTrack.classList.remove('is-dragging');
      setTimeout(function () { dragMoved = false; }, 60);
    });
    phoneTrack.addEventListener('pointerenter', function () { marqueeHover = true; });
    phoneTrack.addEventListener('pointerleave', function () { marqueeHover = false; });

    if (phonePrev) phonePrev.addEventListener('click', function () {
      phoneTrack.scrollBy({ left: -260, behavior: motionOK() ? 'smooth' : 'auto' });
    });
    if (phoneNext) phoneNext.addEventListener('click', function () {
      phoneTrack.scrollBy({ left: 260, behavior: motionOK() ? 'smooth' : 'auto' });
    });
    if (phoneGridBtn) {
      phoneGridBtn.addEventListener('click', function () {
        var gridOn = phoneTrack.classList.toggle('is-grid');
        phoneGridBtn.setAttribute('aria-pressed', String(gridOn));
      });
    }

    if (motionOK() && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        marqueeInView = entries[0].isIntersecting;
      }, { threshold: 0.15 }).observe(phoneTrack);

      var dir = 1;
      setInterval(function () {
        if (!marqueeInView || marqueeHover || marqueeDragging || document.hidden || phoneTrack.classList.contains('is-grid')) return;
        var maxScroll = phoneTrack.scrollWidth - phoneTrack.clientWidth;
        if (maxScroll <= 10) return;
        phoneTrack.scrollLeft += dir * 0.9;
        if (phoneTrack.scrollLeft >= maxScroll - 2) dir = -1;
        else if (phoneTrack.scrollLeft <= 1) dir = 1;
      }, 24);
    }
  }

  // Desktop & Admin Filter Pills
  var deskFilters = $$('#desktopFilters .filter-pill');
  var deskCards = $$('#desktopGrid .desktop-card');
  if (deskFilters.length) {
    deskFilters.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cat = btn.dataset.filter;
        deskFilters.forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        deskCards.forEach(function (card) {
          card.hidden = cat !== 'all' && card.dataset.cat !== cat;
        });
      });
    });
  }

  // ---------- 6. Full-Screen Lightbox Modal ----------
  var lightbox = $('#lightbox');
  var lbImg = $('#lightboxImg');
  var lbCap = $('#lightboxCaption');
  var lbCount = $('#lightboxCounter');
  var lbClose = $('#lightboxClose');
  var lbPrev = $('#lightboxPrev');
  var lbNext = $('#lightboxNext');
  var lbItems = $$('[data-lightbox-src]');
  var lbIndex = 0;

  function showLightbox(i) {
    if (!lightbox || !lbItems.length) return;
    lbIndex = (i + lbItems.length) % lbItems.length;
    var trigger = lbItems[lbIndex];
    var img = trigger.querySelector('img');
    var lang = root.dataset.lang === 'en' ? 'en' : 'zh';
    lbImg.src = trigger.dataset.lightboxSrc || (img ? img.src : '');
    lbImg.alt = img ? img.alt : '';
    lbCap.textContent = (lang === 'en' ? trigger.dataset.capEn : trigger.dataset.capZh) || (img ? img.alt : '');
    lbCount.textContent = (lbIndex + 1) + ' / ' + lbItems.length;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    if (!lightbox) return;
    lightbox.hidden = true;
    document.body.style.overflow = '';
  }
  if (lightbox && lbItems.length) {
    lbItems.forEach(function (btn, idx) {
      btn.addEventListener('click', function (e) {
        if (dragMoved) { e.preventDefault(); return; }
        showLightbox(idx);
      });
    });
    lbClose && lbClose.addEventListener('click', closeLightbox);
    lbPrev && lbPrev.addEventListener('click', function () { showLightbox(lbIndex - 1); });
    lbNext && lbNext.addEventListener('click', function () { showLightbox(lbIndex + 1); });
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function (e) {
      if (lightbox.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') showLightbox(lbIndex - 1);
      else if (e.key === 'ArrowRight') showLightbox(lbIndex + 1);
    });
  }

  // ---------- 7. Promo Video: Lazy Animated Teaser + Click-to-Load MP4 ----------
  var videoStage = $('#videoStage');
  var videoCoverImg = $('#videoCoverImg');
  var videoPlayBtn = $('#videoPlayBtn');

  if (videoStage && videoCoverImg && motionOK() && 'IntersectionObserver' in window) {
    var teaserSrc = videoStage.dataset.teaser;
    if (teaserSrc) {
      var teaserIO = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          var pre = new Image();
          pre.onload = function () {
            if (!videoStage.dataset.playing) videoCoverImg.src = teaserSrc;
          };
          pre.src = teaserSrc;
          teaserIO.disconnect();
        }
      }, { rootMargin: '200px 0px' });
      teaserIO.observe(videoStage);
    }
  }

  if (videoStage && videoPlayBtn) {
    videoPlayBtn.addEventListener('click', function () {
      var mp4 = videoStage.dataset.mp4;
      if (!mp4) return;
      videoStage.dataset.playing = '1';
      var v = document.createElement('video');
      v.controls = true;
      v.autoplay = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.poster = videoStage.dataset.poster || '';
      v.src = mp4;
      videoStage.innerHTML = '';
      videoStage.appendChild(v);
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
    });
  }

  // ---------- 8. Patch Tool Platform Tabs ----------
  var patchTabs = $$('#patchTabs [role="tab"]');
  var patchPanels = $$('[data-patch-panel]');
  if (patchTabs.length) {
    patchTabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.dataset.tab;
        patchTabs.forEach(function (t) {
          var on = t === tab;
          t.setAttribute('aria-selected', String(on));
          t.tabIndex = on ? 0 : -1;
        });
        patchPanels.forEach(function (p) {
          p.hidden = p.dataset.patchPanel !== target;
        });
      });
    });
  }

  // ---------- 9. Copy Command Buttons ----------
  $$('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var pre = btn.parentElement && btn.parentElement.querySelector('pre');
      if (!pre) return;
      var text = pre.textContent.trim();
      var done = function () {
        btn.classList.add('is-copied');
        setTimeout(function () { btn.classList.remove('is-copied'); }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        done();
      }
    });
  });

  // ---------- 10. Strata-Style Capability Micro-Tiles (pause when offscreen) ----------
  var capGrid = $('#capTiles');
  if (capGrid) {
    var capTiles = $$('.cap-tile', capGrid);
    var ratioChips = $$('.ratio-chip', capGrid);
    var sigSteps = $$('.sig-steps li', capGrid);
    var capVisible = false;
    var capTick = 0;

    function tickCaps() {
      if (!capVisible || document.hidden || !motionOK()) return;
      capTick++;
      if (ratioChips.length) {
        var rIdx = capTick % ratioChips.length;
        ratioChips.forEach(function (c, i) { c.classList.toggle('is-on', i === rIdx); });
      }
      if (sigSteps.length) {
        var sStep = capTick % (sigSteps.length + 2);
        sigSteps.forEach(function (li, i) { li.classList.toggle('is-on', i < sStep); });
      }
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        capVisible = entries[0].isIntersecting;
        capTiles.forEach(function (t) { t.classList.toggle('is-playing', capVisible && motionOK()); });
      }, { threshold: 0.2 }).observe(capGrid);
    } else {
      capVisible = true;
    }
    setInterval(tickCaps, 1400);
  }
})();
