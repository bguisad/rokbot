// RokBot Interactive Product Demos Engine
// 5 real HTML/CSS/JS interactive simulations with fake pointer autoplay,
// instant visitor takeover, IntersectionObserver viewport pause/resume,
// bilingual zh/en reactivity, and prefers-reduced-motion support.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var root = document.documentElement;
  var stage = $('#demoStage');
  if (!stage) return;

  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var motionOK = function () { return !reduceMQ.matches; };
  var lang = function () { return root.dataset.lang === 'en' ? 'en' : 'zh'; };

  // ---------- Copy Dictionary ----------
  var COPY = {
    zh: {
      pause: '暂停演示',
      resume: '继续演示',
      captions: {
        android: 'Android 原生会话列表按「待处理、进行中、未读、已读」四组折叠。点击分组可折叠/展开，点击任意 Bot 查看状态或标记已读，新消息会自动置顶弹入。',
        chat: 'Bot 边打字流式回复，遇到风险操作自动弹出原生审批卡片。你可以直接点击「本次允许」看它执行并生成 16:9 图片，或点「拒绝」取消操作。',
        vnc: 'Host 内置 Linux 执行桌面（rokbot-box）。观察 Bot 自主移动鼠标和输入命令，点击「接管操作」即可亲自在沙盒终端里敲命令或点击浏览器。',
        models: '切换主模型与思考强度，点击「模拟 429 限流」体验主模型在首字输出前无感切换至备用链，已输出内容后绝不重复调用工具。',
        auto: 'Host 内置本地 cron 计时器按时间轴触发例行巡检，同时支持 HMAC-SHA256 签名校验（±5 分钟）的 Webhook 外部触发入口。'
      },
      groups: { pending: '待处理', working: '进行中', unread: '未读', read: '已读' },
      bots: {
        deploy: { name: '部署助手', msg: '要现在把 host 部署到 mini 吗？', detail: '等待你在选项卡片中确认发布目标节点。' },
        review: { name: '代码审查', msg: '需要你允许运行 git push', detail: '自动审查已拦截 git push origin fix/list，等待批准。' },
        data: { name: '数据整理', msg: '正在整理 11 月的报表...', detail: '正在沙盒中运行 pandas 汇总脚本（第 3/4 步）。' },
        crawl: { name: '网页抓取', msg: '抓取第 7/10 页', detail: '正在提取价格变动并写入 /workspace/prices.csv。' },
        daily: { name: '日报', msg: '今天的日报已经写好了', detail: '已整理 10 条技术动态与 3 项跟进事项。' },
        travel: { name: '旅行规划', msg: '东京 5 日行程已更新', detail: '已按预算更新交通换乘与酒店清单。' },
        ops: { name: '运维助手', msg: 'NAS 磁盘占用 61%，备份正常', detail: '最近一次巡检 03:00 完成，无异常告警。' }
      },
      evDone: '已完成并移入「未读」',
      evRead: '已阅读并移入「已读」',
      evNew: '新审批请求弹入「待处理」',
      evReset: '已重置四组初始状态',
      chatUser: '把 fix/list 分支推到远端，再帮我画一张 16:9 的海边日落发布海报。',
      chatThink: '好的，我先检查当前分支并准备推送到远端仓库 origin/fix/list。',
      chatApproved: '✓ 已允许执行 · Exit code: 0 (pushed 3 commits to fix/list)',
      chatDenied: '✕ 已拒绝 git push · 已取消远端推送，保留本地改动。',
      chatImgText: '推送已完成！接下来为你生成 16:9 海边日落主题海报：',
      chatDenyFollow: '已按你的要求取消推送。需要我先生成海报，还是先查看 diff？',
      allowBtn: '本次允许',
      denyBtn: '拒绝',
      vncBotMode: 'Bot 自主操作中',
      vncHumanMode: '你正在接管桌面',
      vncTakeBtn: '接管操作',
      vncHandBtn: '交还给 Bot',
      vncReady: '人工接管已开启：可以直接在下方终端输入命令（如 ls、uptime、uname -a）按回车，或点击浏览器刷新图表。',
      vncBack: '已交还控制权：Bot 光标恢复自动巡检。',
      modelIdle: '就绪',
      modelTrying: '请求中...',
      modelErr: '429 限流 (0 tok)',
      modelOk: '200 OK · 流式输出',
      modelStreamOk: '✓ 主模型首字前 429，12ms 内无感切换至备用模型 #1，已锁定本轮输出防止重复工具调用。',
      cronWait: '等待',
      cronRun: '运行中',
      cronDone: '已完成',
      whReady: '等待触发',
      whPass: '通过'
    },
    en: {
      pause: 'Pause demo',
      resume: 'Resume demo',
      captions: {
        android: 'Native Android bot list collapses into 4 live groups: Needs attention, In progress, Unread, and Read. Click headers to fold, click any Bot to inspect or mark read.',
        chat: 'Watch the Bot stream a reply, trigger a native Approval Card for a risky shell command (try clicking Allow once or Deny!), and return a generated 16:9 image attachment.',
        vnc: 'Live view of the Linux execution desktop (rokbot-box). Watch the Bot move its cursor and type shell commands — click Take Over to type in the terminal yourself.',
        models: 'Pick a primary model and reasoning effort, then click Simulate 429 to watch zero-token pre-stream failover cascade cleanly to Fallback #1 without duplicate tool calls.',
        auto: 'Built-in local cron scheduler fires Bot routines on time with single-flight locking, paired with HMAC-SHA256 (±5 min) signed Webhook triggers.'
      },
      groups: { pending: 'Needs attention', working: 'In progress', unread: 'Unread', read: 'Read' },
      bots: {
        deploy: { name: 'Deploy Bot', msg: 'Deploy host to mini now?', detail: 'Waiting for your confirmation on target deployment node.' },
        review: { name: 'Code Review', msg: 'Needs approval for git push', detail: 'Auto-review paused git push origin fix/list for your decision.' },
        data: { name: 'Data Prep', msg: 'Compiling November report...', detail: 'Running pandas aggregation inside /workspace (step 3/4).' },
        crawl: { name: 'Price Watch', msg: 'Fetching page 7/10...', detail: 'Extracting pricing deltas into /workspace/prices.csv.' },
        daily: { name: 'Daily Brief', msg: 'Today’s digest is ready', detail: 'Summarized 10 engineering updates and 3 action items.' },
        travel: { name: 'Trip Planner', msg: 'Tokyo 5-day itinerary updated', detail: 'Transit passes and hotel comparisons refreshed.' },
        ops: { name: 'Ops Monitor', msg: 'NAS disk 61%, backup OK', detail: 'Latest routine check finished at 03:00 with zero alerts.' }
      },
      evDone: 'finished → moved to Unread',
      evRead: 'opened → moved to Read',
      evNew: 'new alert popped into Needs attention',
      evReset: 'reset all 4 groups',
      chatUser: 'Push fix/list to origin, then generate a 16:9 seaside sunset poster.',
      chatThink: 'Sure — checking local commits and preparing to push branch fix/list to origin.',
      chatApproved: '✓ Allowed once · Exit code: 0 (pushed 3 commits to fix/list)',
      chatDenied: '✕ Denied · Cancelled git push, local branch untouched.',
      chatImgText: 'Push succeeded! Here is your generated 16:9 seaside sunset visual:',
      chatDenyFollow: 'Push cancelled as requested. Want me to generate the poster anyway or inspect the diff?',
      allowBtn: 'Allow once',
      denyBtn: 'Deny',
      vncBotMode: 'Bot autonomous',
      vncHumanMode: 'Human takeover active',
      vncTakeBtn: 'Take over',
      vncHandBtn: 'Hand back to Bot',
      vncReady: 'Takeover active: type a command in the terminal below (try ls, uptime, uname -a) or click Refresh in the browser.',
      vncBack: 'Control returned: Bot cursor resumed autonomous run.',
      modelIdle: 'Standby',
      modelTrying: 'Calling...',
      modelErr: '429 Rate Limit (0 tok)',
      modelOk: '200 OK · Streaming',
      modelStreamOk: '✓ Primary hit 429 before first token; switched to Fallback #1 in 12ms and locked mid-stream.',
      cronWait: 'Scheduled',
      cronRun: 'Running',
      cronDone: 'Done',
      whReady: 'Waiting',
      whPass: 'OK'
    }
  };
  var t = function (k) { return COPY[lang()][k]; };

  // ---------- Stage Tabs & Runner ----------
  var activeTab = 'android';
  var tabs = $$('#demoTabs [role="tab"]');
  var panes = $$('.demo-pane[data-demo-pane]');
  var captionEl = $('#demoCaption');
  var toggleBtn = $('#demoToggle');
  var toggleTxt = $('#demoToggleTxt');
  var pointerEl = $('#demoPointer');

  var STOP = {};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var stageVisible = false;
  var runner = (function () {
    var gen = 0, running = false, hovered = false, held = false, resumeTimer = null;
    var r = {
      paused: false,
      active: function () { return stageVisible && !hovered && !held && !r.paused && !document.hidden && motionOK(); },
      wait: function (ms, g) {
        return (async function () {
          var left = ms, last = performance.now();
          while (left > 0) {
            if (g !== gen) throw STOP;
            await sleep(Math.min(50, left));
            var now = performance.now();
            if (r.active()) left -= (now - last);
            last = now;
          }
          if (g !== gen) throw STOP;
        })();
      },
      start: function () {
        if (running || !r.active()) return;
        running = true;
        var g = ++gen;
        (async function () {
          try {
            for (;;) await playCurrentTab(g);
          } catch (err) {
            if (err !== STOP) console.error(err);
          } finally {
            if (g === gen) running = false;
            pointer.hide();
          }
        })();
      },
      stop: function () { gen += 1; running = false; pointer.hide(); },
      interrupt: function () {
        if (!motionOK()) return;
        r.stop();
        held = true;
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(function () { held = false; r.start(); }, 14000);
      },
      setHover: function (h) { hovered = h; if (!h) setTimeout(r.start, 600); },
      toggle: function () {
        r.paused = !r.paused;
        if (r.paused) r.stop();
        else { held = false; r.start(); }
        paintToggle();
      }
    };
    return r;
  })();

  var pointer = {
    hide: function () { if (pointerEl) pointerEl.classList.remove('is-on'); },
    move: async function (el, g, ms) {
      if (!pointerEl || !el || !el.getClientRects().length) return;
      var sb = stage.getBoundingClientRect();
      var rc = el.getBoundingClientRect();
      var x = rc.left - sb.left + rc.width * 0.5;
      var y = rc.top - sb.top + rc.height * 0.55;
      pointerEl.classList.add('is-on');
      pointerEl.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      await runner.wait(ms || 720, g);
    },
    click: async function (el, g) {
      if (!el || !el.getClientRects().length) return;
      await pointer.move(el, g);
      pointerEl.classList.remove('is-click');
      void pointerEl.offsetWidth;
      pointerEl.classList.add('is-click');
      el.classList.add('is-pressed');
      await runner.wait(170, g);
      el.classList.remove('is-pressed');
      el.click();
      await runner.wait(260, g);
    }
  };

  function paintToggle() {
    if (!toggleBtn || !toggleTxt) return;
    toggleBtn.hidden = !motionOK();
    toggleBtn.setAttribute('aria-pressed', String(runner.paused));
    toggleTxt.textContent = t(runner.paused ? 'resume' : 'pause');
  }

  function selectTab(id, fromUser) {
    activeTab = id;
    tabs.forEach(function (btn) {
      var on = btn.dataset.demoTab === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    panes.forEach(function (pane) {
      pane.classList.toggle('is-active', pane.dataset.demoPane === id);
    });
    if (captionEl) captionEl.textContent = COPY[lang()].captions[id];
    if (fromUser) {
      runner.stop();
      setTimeout(function () { if (!runner.paused) runner.start(); }, 1800);
    }
  }

  tabs.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      selectTab(btn.dataset.demoTab, e.isTrusted);
    });
  });

  // ==========================================================
  // DEMO 1: Android Native 4-Group Bot List
  // ==========================================================
  var A_INIT = [
    { id: 'deploy', group: 'pending', color: 'c-blue', time: '5:08 PM' },
    { id: 'review', group: 'pending', color: 'c-green', time: '4:31 PM' },
    { id: 'data', group: 'working', color: 'c-amber', time: '5:10 PM' },
    { id: 'crawl', group: 'working', color: 'c-orange', time: '4:46 PM' },
    { id: 'daily', group: 'unread', color: 'c-coral', time: '5:03 PM' },
    { id: 'travel', group: 'read', color: 'c-teal', time: '3:11 PM' },
    { id: 'ops', group: 'read', color: 'c-indigo', time: '1:20 PM' }
  ];
  var aBots = A_INIT.map(function (b) { return Object.assign({}, b); });
  var aCollapsed = { pending: false, working: false, unread: false, read: false };
  var aSelected = 'review';
  var aEvents = [];
  var aLastNewId = null;

  function nowClock() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function pushAndroidEvent(text) {
    aEvents.unshift({ t: nowClock(), text: text });
    if (aEvents.length > 5) aEvents.pop();
  }

  function renderAndroid() {
    var scroll = $('#androidBotScroll');
    if (!scroll) return;
    var G = ['pending', 'working', 'unread', 'read'];
    var L = COPY[lang()];
    scroll.innerHTML = '';

    var pendingCount = aBots.filter(function (b) { return b.group === 'pending'; }).length;
    var badge = $('#androidBellBadge');
    if (badge) {
      badge.textContent = String(pendingCount);
      badge.hidden = pendingCount === 0;
    }

    G.forEach(function (gk) {
      var list = aBots.filter(function (b) { return b.group === gk; });
      var wrap = document.createElement('div');
      wrap.className = 'bot-group' + (aCollapsed[gk] ? ' is-collapsed' : '');
      wrap.dataset.group = gk;

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'bot-group-head';
      head.dataset.groupToggle = gk;
      head.innerHTML = '<span>' + L.groups[gk] + '</span><span class="bot-group-chev">▾</span><span class="bot-group-cnt">' + list.length + '</span>';
      wrap.appendChild(head);

      var ul = document.createElement('div');
      ul.className = 'bot-group-list';
      list.forEach(function (b) {
        var meta = L.bots[b.id];
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'bot-item' + (aSelected === b.id ? ' is-selected' : '') + (aLastNewId === b.id ? ' is-entering' : '');
        item.dataset.botId = b.id;

        var statusDot = '';
        if (gk === 'working') statusDot = '<i class="bot-status-badge is-working"></i>';
        else if (gk === 'pending') statusDot = '<i class="bot-status-badge is-pending"></i>';

        var rightDot = '';
        if (gk === 'unread') rightDot = '<i class="bot-dot is-unread"></i>';
        else if (gk === 'pending') rightDot = '<i class="bot-dot is-pending"></i>';

        item.innerHTML =
          '<span class="bot-blob ' + b.color + '">' + statusDot + '</span>' +
          '<span class="bot-meta"><span class="bot-name">' + meta.name + '</span><span class="bot-msg">' + meta.msg + '</span></span>' +
          '<span class="bot-right"><span class="bot-time">' + b.time + '</span>' + rightDot + '</span>';
        ul.appendChild(item);
      });
      wrap.appendChild(ul);
      scroll.appendChild(wrap);
    });
    aLastNewId = null;

    // Render Inspector Preview
    var cur = aBots.find(function (b) { return b.id === aSelected; }) || aBots[0];
    var curMeta = L.bots[cur.id];
    var pvName = $('#androidPreviewName');
    var pvGroup = $('#androidPreviewGroup');
    var pvMsg = $('#androidPreviewMsg');
    var pvBlob = $('#androidPreviewBlob');
    if (pvName) pvName.textContent = curMeta.name;
    if (pvMsg) pvMsg.textContent = curMeta.detail;
    if (pvGroup) {
      pvGroup.textContent = L.groups[cur.group];
      pvGroup.className = 'sim-group-tag g-' + cur.group;
    }
    if (pvBlob) pvBlob.className = 'bot-blob ' + cur.color;

    var feed = $('#androidEventFeed');
    if (feed) {
      feed.innerHTML = aEvents.map(function (ev) {
        return '<li><span class="ev-t">' + ev.t + '</span><span>' + ev.text + '</span></li>';
      }).join('');
    }
  }

  function advanceAndroidStatus() {
    var L = COPY[lang()];
    var working = aBots.find(function (b) { return b.group === 'working'; });
    if (working) {
      working.group = 'unread';
      working.time = nowClock();
      aSelected = working.id;
      aLastNewId = working.id;
      aCollapsed.unread = false;
      pushAndroidEvent(L.bots[working.id].name + ' ' + L.evDone);
    } else {
      var readOne = aBots.find(function (b) { return b.group === 'read'; });
      if (readOne) {
        readOne.group = 'pending';
        readOne.time = nowClock();
        aSelected = readOne.id;
        aLastNewId = readOne.id;
        aCollapsed.pending = false;
        pushAndroidEvent(L.bots[readOne.id].name + ' ' + L.evNew);
      } else {
        aBots = A_INIT.map(function (b) { return Object.assign({}, b); });
        pushAndroidEvent(L.evReset);
      }
    }
    renderAndroid();
  }

  var aScrollEl = $('#androidBotScroll');
  if (aScrollEl) {
    aScrollEl.addEventListener('click', function (e) {
      var gh = e.target.closest('[data-group-toggle]');
      if (gh) {
        var gk = gh.dataset.groupToggle;
        aCollapsed[gk] = !aCollapsed[gk];
        renderAndroid();
        return;
      }
      var bi = e.target.closest('[data-bot-id]');
      if (bi) {
        var id = bi.dataset.botId;
        var b = aBots.find(function (x) { return x.id === id; });
        if (!b) return;
        aSelected = id;
        if (b.group === 'unread') {
          b.group = 'read';
          aLastNewId = id;
          pushAndroidEvent(COPY[lang()].bots[id].name + ' ' + COPY[lang()].evRead);
        }
        renderAndroid();
      }
    });
  }
  $('#androidSimEventBtn') && $('#androidSimEventBtn').addEventListener('click', advanceAndroidStatus);
  $('#androidResetBtn') && $('#androidResetBtn').addEventListener('click', function () {
    aBots = A_INIT.map(function (b) { return Object.assign({}, b); });
    aCollapsed = { pending: false, working: false, unread: false, read: false };
    aSelected = 'review';
    pushAndroidEvent(COPY[lang()].evReset);
    renderAndroid();
  });

  // ==========================================================
  // DEMO 2: Chat Streaming + Approval Card + Image Generation
  // ==========================================================
  var chatBody = $('#simChatBody');
  var chatSteps = $$('#simChatSteps .sim-step-item');
  var chatState = { stage: 'idle', decision: null };

  function setChatStep(idx) {
    chatSteps.forEach(function (el, i) {
      el.classList.toggle('is-done', i < idx);
      el.classList.toggle('is-now', i === idx);
    });
  }

  function buildApprovalCard() {
    var L = COPY[lang()];
    var card = document.createElement('div');
    card.className = 'approval-card';
    card.id = 'simApprovalCard';
    card.innerHTML =
      '<div class="approval-kicker"><span>🖥</span><span>Computer · Your Desktop</span></div>' +
      '<div class="approval-title">' + (lang() === 'en' ? 'Shell command approval' : '等待确认终端命令') + '</div>' +
      '<div class="approval-sub">' + (lang() === 'en' ? 'Auto-review flagged a remote git push' : '自动审查拦截了远端推送操作，等待你确认') + '</div>' +
      '<div class="approval-cmd">git push origin fix/list</div>' +
      '<div class="approval-btns">' +
        '<button type="button" class="btn-deny" id="simDenyBtn">' + L.denyBtn + '</button>' +
        '<button type="button" class="btn-allow" id="simAllowBtn">' + L.allowBtn + '</button>' +
      '</div>';
    return card;
  }

  function buildSunsetCard() {
    var wrap = document.createElement('div');
    wrap.className = 'gen-img-card';
    wrap.innerHTML =
      '<div class="gen-sunset-canvas">' +
        '<div class="gen-sun"></div>' +
        '<svg class="gen-hills" viewBox="0 0 360 202" preserveAspectRatio="none" aria-hidden="true">' +
          '<path d="M0 150 Q70 118 145 142 T300 132 L360 144 L360 202 L0 202 Z" fill="#312E81" opacity="0.82"/>' +
          '<path d="M0 166 Q95 140 190 158 T360 152 L360 202 L0 202 Z" fill="#1E1B4B"/>' +
          '<path d="M138 176 L222 176 L205 196 L155 196 Z" fill="rgba(253,230,138,0.28)"/>' +
        '</svg>' +
        '<span class="gen-badge">16:9 · 1536×1024</span>' +
      '</div>' +
      '<div class="gen-img-meta"><span>sunset-release-poster.webp</span><span>GenerateImage · 3.4s</span></div>';
    return wrap;
  }

  function handleApprovalDecision(approved) {
    if (chatState.decision) return;
    chatState.decision = approved ? 'allow' : 'deny';
    var card = $('#simApprovalCard');
    var L = COPY[lang()];
    if (card) {
      card.classList.add(approved ? 'is-approved' : 'is-denied');
      var btns = $('.approval-btns', card);
      if (btns) {
        btns.innerHTML = '<span class="approval-verdict ' + (approved ? 'ok' : 'no') + '">' + (approved ? L.chatApproved : L.chatDenied) + '</span>';
      }
    }
    if (approved) {
      setChatStep(3);
      var b1 = document.createElement('div');
      b1.className = 'chat-bubble-bot';
      b1.textContent = L.chatImgText;
      chatBody.appendChild(b1);
      chatBody.appendChild(buildSunsetCard());
      chatBody.scrollTop = chatBody.scrollHeight;
      setTimeout(function () { setChatStep(4); }, 500);
    } else {
      setChatStep(4);
      var b2 = document.createElement('div');
      b2.className = 'chat-bubble-bot';
      b2.textContent = L.chatDenyFollow;
      chatBody.appendChild(b2);
      chatBody.scrollTop = chatBody.scrollHeight;
    }
  }

  function renderChatStaticFinal() {
    if (!chatBody) return;
    var L = COPY[lang()];
    chatState.decision = null;
    chatBody.innerHTML = '';
    var u = document.createElement('div');
    u.className = 'chat-bubble-user';
    u.textContent = L.chatUser;
    var b = document.createElement('div');
    b.className = 'chat-bubble-bot';
    b.textContent = L.chatThink;
    chatBody.appendChild(u);
    chatBody.appendChild(b);
    chatBody.appendChild(buildApprovalCard());
    wireApprovalButtons();
    setChatStep(2);
  }

  function wireApprovalButtons() {
    var allow = $('#simAllowBtn');
    var deny = $('#simDenyBtn');
    if (allow) allow.addEventListener('click', function () { handleApprovalDecision(true); });
    if (deny) deny.addEventListener('click', function () { handleApprovalDecision(false); });
  }

  async function runChatSequence(g, waitFn) {
    if (!chatBody) return;
    var L = COPY[lang()];
    chatState.decision = null;
    chatBody.innerHTML = '';
    setChatStep(0);

    var u = document.createElement('div');
    u.className = 'chat-bubble-user';
    u.textContent = L.chatUser;
    chatBody.appendChild(u);
    await waitFn(650, g);

    setChatStep(1);
    var b = document.createElement('div');
    b.className = 'chat-bubble-bot';
    chatBody.appendChild(b);
    var chars = Array.from(L.chatThink);
    for (var i = 0; i < chars.length; i += 2) {
      b.innerHTML = chars.slice(0, i + 2).join('') + '<span class="typing-caret"></span>';
      await waitFn(38, g);
    }
    b.textContent = L.chatThink;
    await waitFn(420, g);

    setChatStep(2);
    chatBody.appendChild(buildApprovalCard());
    wireApprovalButtons();
    chatBody.scrollTop = chatBody.scrollHeight;
    await waitFn(1400, g);

    var allowBtn = $('#simAllowBtn');
    if (allowBtn && !chatState.decision) {
      if (g !== null) await pointer.click(allowBtn, g);
      else handleApprovalDecision(true);
    }
    await waitFn(3600, g);
  }

  $('#chatReplayBtn') && $('#chatReplayBtn').addEventListener('click', function () {
    runner.interrupt();
    var localWait = function (ms) { return sleep(motionOK() ? ms : 0); };
    runChatSequence(null, localWait);
  });

  // ==========================================================
  // DEMO 3: Cloud Computer (Live VNC Desktop + Human Takeover)
  // ==========================================================
  var vncMonitor = $('#simVncMonitor');
  var vncBadge = $('#vncModeBadge');
  var vncTakeBtn = $('#vncTakeBtn');
  var vncCursor = $('#vncBotCursor');
  var vncTermBody = $('#vncTermBody');
  var vncTermInput = $('#vncTermInput');
  var vncLogList = $('#vncLogList');
  var vncBars = $$('#vncChartBars span');
  var vncRefreshBtn = $('#vncBrowserRefresh');
  var vncHuman = false;

  function appendVncTerm(cls, text) {
    if (!vncTermBody) return;
    var d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    vncTermBody.appendChild(d);
    while (vncTermBody.children.length > 10) vncTermBody.removeChild(vncTermBody.firstChild);
    vncTermBody.scrollTop = vncTermBody.scrollHeight;
  }

  function appendVncLog(title, desc) {
    if (!vncLogList) return;
    var li = document.createElement('li');
    li.innerHTML = '<strong>' + title + '</strong>' + desc;
    vncLogList.prepend(li);
    while (vncLogList.children.length > 5) vncLogList.lastElementChild.remove();
  }

  function randomizeVncBars() {
    vncBars.forEach(function (bar) {
      bar.style.height = (26 + Math.floor(Math.random() * 68)) + '%';
    });
  }

  function setVncHuman(on) {
    vncHuman = on;
    var L = COPY[lang()];
    if (vncMonitor) vncMonitor.classList.toggle('is-human', on);
    if (vncBadge) {
      vncBadge.classList.toggle('is-human', on);
      vncBadge.innerHTML = '<i></i><span>' + (on ? L.vncHumanMode : L.vncBotMode) + '</span>';
    }
    if (vncTakeBtn) {
      vncTakeBtn.textContent = on ? L.vncHandBtn : L.vncTakeBtn;
      vncTakeBtn.classList.toggle('is-amber', !on);
      vncTakeBtn.classList.toggle('is-primary', on);
    }
    if (vncCursor) vncCursor.classList.toggle('is-hidden', on);
    if (vncTermInput) {
      vncTermInput.disabled = !on;
      if (on) vncTermInput.focus();
    }
    appendVncLog(on ? L.vncHumanMode : L.vncBotMode, on ? L.vncReady : L.vncBack);
  }

  if (vncTakeBtn) {
    vncTakeBtn.addEventListener('click', function () {
      setVncHuman(!vncHuman);
    });
  }
  if (vncRefreshBtn) {
    vncRefreshBtn.addEventListener('click', function () {
      randomizeVncBars();
      appendVncTerm('t-ok', 'GET /report 200 OK — chart refreshed');
    });
  }
  if (vncTermInput) {
    vncTermInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var cmd = vncTermInput.value.trim();
      if (!cmd) return;
      vncTermInput.value = '';
      appendVncTerm('t-cmd', 'box@rokbot:~/workspace$ ' + cmd);
      var out = 'command executed (exit 0)';
      if (cmd === 'ls' || cmd.indexOf('ls ') === 0) out = 'metrics.csv  render_chart.py  report.html  .rokbot-skills/';
      else if (cmd === 'uptime') out = 'up 14 days, 03:22, load average: 0.21, 0.18, 0.14';
      else if (cmd.indexOf('uname') === 0) out = 'Linux rokbot-box 6.8.0-117-generic x86_64 Debian 13';
      else if (cmd === 'pwd') out = '/workspace';
      else if (cmd === 'whoami') out = 'box (isolated container)';
      appendVncTerm('t-ok', out);
    });
  }

  // ==========================================================
  // DEMO 4: Model Routing & 8-Tier Fallback Chain
  // ==========================================================
  var modelSelect = $('#simModelSelect');
  var effortBtns = $$('#simEffortPills .effort-pill');
  var chainNodes = $$('#simFallbackChain .chain-node');
  var streamOut = $('#simModelStream');
  var simFailBtn = $('#simTriggerFailBtn');
  var selectedEffort = 'high';

  var MODEL_LABELS = {
    claude: ['claude-sonnet-4.6 (Anthropic)', 'gpt-5 (OpenAI Responses)', 'deepseek-v4 (OpenAI Chat)'],
    gpt5: ['gpt-5 (OpenAI Responses)', 'claude-sonnet-4.6 (Anthropic)', 'deepseek-v4 (OpenAI Chat)'],
    deepseek: ['deepseek-v4 (OpenAI Chat)', 'claude-sonnet-4.6 (Anthropic)', 'gpt-5 (OpenAI Responses)']
  };

  function resetModelChain() {
    var key = modelSelect ? modelSelect.value : 'claude';
    var order = MODEL_LABELS[key] || MODEL_LABELS.claude;
    var L = COPY[lang()];
    chainNodes.forEach(function (node, i) {
      node.classList.remove('is-err', 'is-ok', 'is-trying');
      var nm = $('.chain-name', node);
      var st = $('.chain-status', node);
      if (nm) nm.textContent = order[i];
      if (st) st.textContent = L.modelIdle;
    });
    if (streamOut) {
      streamOut.innerHTML =
        '<div class="stream-dim">route: default · effort: ' + selectedEffort + ' · fallbacks: up to 8</div>' +
        '<div class="stream-dim">primary: ' + order[0] + '</div>';
    }
  }

  async function runModelFailover(g, waitFn) {
    resetModelChain();
    var L = COPY[lang()];
    if (!chainNodes.length) return;
    chainNodes[0].classList.add('is-trying');
    $('.chain-status', chainNodes[0]).textContent = L.modelTrying;
    await waitFn(650, g);

    chainNodes[0].classList.remove('is-trying');
    chainNodes[0].classList.add('is-err');
    $('.chain-status', chainNodes[0]).textContent = L.modelErr;
    if (streamOut) {
      streamOut.innerHTML += '<div class="stream-err">HTTP 429 Too Many Requests (0 tokens emitted) → failing over...</div>';
    }
    await waitFn(520, g);

    chainNodes[1].classList.add('is-trying');
    $('.chain-status', chainNodes[1]).textContent = L.modelTrying;
    await waitFn(420, g);

    chainNodes[1].classList.remove('is-trying');
    chainNodes[1].classList.add('is-ok');
    $('.chain-status', chainNodes[1]).textContent = L.modelOk;
    if (streamOut) {
      streamOut.innerHTML += '<div class="stream-ok">' + L.modelStreamOk + '</div>';
    }
  }

  if (modelSelect) modelSelect.addEventListener('change', resetModelChain);
  effortBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedEffort = btn.dataset.effort;
      effortBtns.forEach(function (b) { b.classList.toggle('is-on', b === btn); });
      resetModelChain();
    });
  });
  if (simFailBtn) {
    simFailBtn.addEventListener('click', function () {
      runModelFailover(null, function (ms) { return sleep(motionOK() ? ms : 0); });
    });
  }

  // ==========================================================
  // DEMO 5: Cron Routines Timeline & HMAC Webhook Trigger
  // ==========================================================
  var cronClockEl = $('#simCronClock');
  var cronBarEl = $('#simCronBar');
  var cronRows = $$('#simCronList .cron-row');
  var whChecks = $$('#simWhChecks li');
  var whLogEl = $('#simWhDeliveries');
  var whFireBtn = $('#simWhFireBtn');
  var cronMinute = 460; // 07:40

  function paintCron() {
    var h = Math.floor(cronMinute / 60) % 24;
    var m = cronMinute % 60;
    if (cronClockEl) cronClockEl.textContent = ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
    if (cronBarEl) cronBarEl.style.width = ((cronMinute / 1440) * 100).toFixed(1) + '%';
    var L = COPY[lang()];
    cronRows.forEach(function (row) {
      var target = Number(row.dataset.at || 0);
      var firing = Math.abs(cronMinute - target) < 35;
      var done = cronMinute >= target + 35;
      row.classList.toggle('is-firing', firing);
      var pill = $('.cron-pill', row);
      if (pill) pill.textContent = firing ? L.cronRun : (done ? L.cronDone : L.cronWait);
    });
  }

  async function fireWebhook(g, waitFn) {
    var L = COPY[lang()];
    whChecks.forEach(function (li) {
      li.classList.remove('is-pass');
      var ok = $('.wh-ok', li);
      if (ok) ok.textContent = '…';
    });
    for (var i = 0; i < whChecks.length; i++) {
      await waitFn(220, g);
      whChecks[i].classList.add('is-pass');
      var ok = $('.wh-ok', whChecks[i]);
      if (ok) ok.textContent = '✓ ' + L.whPass;
    }
    if (whLogEl) {
      var li = document.createElement('li');
      var evs = ['github.release.published', 'alertmanager.firing', 'ci.build.failed', 'stripe.invoice.paid'];
      var ev = evs[Math.floor(Math.random() * evs.length)];
      li.innerHTML = '<span>' + nowClock() + ' · ' + ev + '</span><span class="stream-ok">202 Accepted</span>';
      whLogEl.prepend(li);
      while (whLogEl.children.length > 4) whLogEl.lastElementChild.remove();
    }
  }

  if (whFireBtn) {
    whFireBtn.addEventListener('click', function () {
      fireWebhook(null, function (ms) { return sleep(motionOK() ? ms : 0); });
    });
  }

  // ==========================================================
  // Autoplay Choreography Per Tab
  // ==========================================================
  async function playCurrentTab(g) {
    var w = function (ms) { return runner.wait(ms, g); };
    if (activeTab === 'android') {
      await w(900);
      var foldBtn = $('[data-group-toggle="read"]', stage);
      if (foldBtn) await pointer.click(foldBtn, g);
      await w(1100);
      if (foldBtn) await pointer.click(foldBtn, g);
      await w(900);
      var evBtn = $('#androidSimEventBtn');
      if (evBtn) await pointer.click(evBtn, g);
      await w(1600);
      var unreadItem = $('[data-group="unread"] .bot-item', stage);
      if (unreadItem) await pointer.click(unreadItem, g);
      await w(1800);
      if (evBtn) await pointer.click(evBtn, g);
      await w(2000);
    } else if (activeTab === 'chat') {
      await runChatSequence(g, runner.wait);
    } else if (activeTab === 'vnc') {
      if (vncHuman) { await w(1500); return; }
      var cmds = [
        { cmd: 'uname -sr && nproc', out: 'Linux 6.8.0-117-generic · 8 cores' },
        { cmd: 'python3 render_chart.py --out /workspace', out: '✓ wrote report.html (142 ms)' },
        { cmd: 'curl -s localhost:8080/health', out: '{"status":"healthy","box":"debian-13"}' }
      ];
      for (var c = 0; c < cmds.length; c++) {
        if (vncHuman) break;
        if (vncCursor) vncCursor.style.transform = 'translate(140px, 130px)';
        await w(850);
        appendVncTerm('t-cmd', 'box@rokbot:~/workspace$ ' + cmds[c].cmd);
        await w(650);
        appendVncTerm('t-ok', cmds[c].out);
        await w(500);
        if (vncCursor) vncCursor.style.transform = 'translate(460px, 210px)';
        await w(750);
        randomizeVncBars();
        await w(1100);
      }
    } else if (activeTab === 'models') {
      await w(800);
      await pointer.click(simFailBtn, g);
      await runModelFailover(g, runner.wait);
      await w(2800);
    } else if (activeTab === 'auto') {
      for (var step = 0; step < 26; step++) {
        cronMinute = (cronMinute + 45) % 1440;
        paintCron();
        if (step === 6 || step === 18) {
          await fireWebhook(g, runner.wait);
        }
        await w(240);
      }
      await w(1200);
    }
  }

  // ---------- Wire Global Stage Listeners & Viewport Pause ----------
  stage.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') runner.setHover(true); });
  stage.addEventListener('pointerleave', function () { runner.setHover(false); });
  stage.addEventListener('pointerdown', function (e) { if (e.isTrusted) runner.interrupt(); }, true);
  if (toggleBtn) toggleBtn.addEventListener('click', runner.toggle);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      stageVisible = entries[0].isIntersecting;
      if (stageVisible) runner.start();
      else runner.stop();
    }, { threshold: 0.2 }).observe(stage);
  } else {
    stageVisible = true;
    runner.start();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) runner.stop();
    else runner.start();
  });

  function refreshAllLanguage() {
    selectTab(activeTab, false);
    paintToggle();
    renderAndroid();
    renderChatStaticFinal();
    setVncHuman(vncHuman);
    resetModelChain();
    paintCron();
  }

  document.addEventListener('rokbot:lang', refreshAllLanguage);
  if (reduceMQ.addEventListener) {
    reduceMQ.addEventListener('change', function () {
      paintToggle();
      if (motionOK()) runner.start();
      else runner.stop();
    });
  }

  // Initial Hydrate
  pushAndroidEvent(COPY[lang()].bots.deploy.name + ' · ' + COPY[lang()].groups.pending);
  refreshAllLanguage();
  randomizeVncBars();
})();
