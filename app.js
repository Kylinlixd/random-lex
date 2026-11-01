/* random-lex —— 词条轮盘 + 专注计时 + TTS 朗读 */
(function () {
  'use strict';

  var LS_TERMS = 'randomlex.terms.v1';
  var LS_BAG = 'randomlex.bag.v1';
  var LS_SLIDERS = 'randomlex.sliders.v3';
  var LS_SLIDERS_V2 = 'randomlex.sliders.v2'; // 番茄钟个数制，迁移源
  var LS_SLIDERS_V1 = 'randomlex.sliders.v1'; // 旧版分钟制，迁移源
  var LS_COUNT = 'randomlex.count.v1';

  var SPIN_MS = 2700; // 抽取动画总时长（2~3 秒）

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  /* ================= 词库数据（localStorage） ================= */

  function loadTerms() {
    try {
      var raw = localStorage.getItem(LS_TERMS);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr = arr.filter(function (t) { return t && t.term; });
          if (arr.length) return arr;
        }
      }
    } catch (e) { /* 损坏则重新播种 */ }
    var seeded = BUILTIN_TERMS.map(function (t) {
      return { term: t.term, def: t.def, cat: t.cat || '' };
    });
    localStorage.setItem(LS_TERMS, JSON.stringify(seeded));
    return seeded;
  }

  function saveTerms() {
    localStorage.setItem(LS_TERMS, JSON.stringify(terms));
    rebuildBag();
    renderMeta();
  }

  function loadBag() {
    try {
      var b = JSON.parse(localStorage.getItem(LS_BAG));
      if (b && Array.isArray(b.order) &&
          b.order.length === terms.length &&
          b.order.every(function (i) { return i >= 0 && i < terms.length; })) {
        return b;
      }
    } catch (e) {}
    return { order: shuffle(terms.map(function (_, i) { return i; })), pos: 0 };
  }

  function rebuildBag() {
    bag = { order: shuffle(terms.map(function (_, i) { return i; })), pos: 0 };
    saveBag();
  }
  function saveBag() { localStorage.setItem(LS_BAG, JSON.stringify(bag)); }

  /* 循环随机：洗牌袋抽空后自动重新洗牌 */
  function nextTerm() {
    if (!terms.length) return null;
    if (bag.pos >= bag.order.length) {
      bag.order = shuffle(terms.map(function (_, i) { return i; }));
      bag.pos = 0;
    }
    var t = terms[bag.order[bag.pos++]];
    saveBag();
    return t;
  }

  /* ================= 音效（Web Audio 合成，无外部资源） ================= */

  var AC = null;
  function audio() {
    if (!AC) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      AC = new Ctx();
    }
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  function beep(freq, delay, dur, vol, type) {
    try {
      var c = audio(); if (!c) return;
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      o.connect(g); g.connect(c.destination);
      var t = c.currentTime + (delay || 0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) { /* 音频不可用不影响功能 */ }
  }

  // 预生成噪声 buffer，用于机械咔嗒声
  var noiseBuf = null;
  function getNoiseBuf(c) {
    if (noiseBuf) return noiseBuf;
    var len = Math.max(1, Math.floor(c.sampleRate * 0.06));
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }
  function noiseBurst(delay, dur, vol, freq) {
    try {
      var c = audio(); if (!c) return;
      var src = c.createBufferSource();
      src.buffer = getNoiseBuf(c);
      var f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq || 2400;
      f.Q.value = 1;
      var g = c.createGain();
      var t = c.currentTime + (delay || 0);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(c.destination);
      src.start(t);
      src.stop(t + dur + 0.05);
    } catch (e) {}
  }

  // 滚动滴答：高频清脆咔 + 低频闷响，音量随进度减弱（前段密集响亮，尾段稀疏）
  function tickSound(p) {
    var v = 0.05 * (1 - (p || 0) * 0.5);
    beep(1500 + Math.random() * 1000, 0, 0.022, v, 'square');
    beep(90 + Math.random() * 60, 0.015, 0.05, v * 0.8, 'triangle');
  }

  // 落定：停轮咔声 + E 大三和弦上行叮
  function landSound() {
    noiseBurst(0, 0.03, 0.1, 2400);
    beep(659.25, 0.04, 0.4, 0.15);
    beep(830.61, 0.11, 0.45, 0.13);
    beep(987.77, 0.18, 0.55, 0.12);
  }

  // 计时开始：C 大三和弦上行
  function startSound() {
    [523.25, 659.25, 783.99].forEach(function (f, i) { beep(f, i * 0.07, 0.2, 0.13); });
  }

  // 阶段切换：双音提示
  function phaseSound() {
    beep(659.25, 0, 0.1, 0.1);
    beep(987.77, 0.09, 0.18, 0.09);
  }

  // 完成：上行三连 + 高音收尾
  function doneSound() {
    [523.25, 659.25, 783.99].forEach(function (f, i) { beep(f, i * 0.12, 0.22, 0.14); });
    beep(1046.5, 0.36, 0.6, 0.15);
  }

  /* ================= 词条轮盘 ================= */

  var card = $('termCard'), termEl = $('termTitle'), defEl = $('termDef'),
      catEl = $('termCat'), metaEl = $('metaInfo'),
      drawBtn = $('drawBtn'), ttsBtn = $('ttsBtn');

  var terms = loadTerms();
  var drawnCount = parseInt(localStorage.getItem(LS_COUNT) || '0', 10) || 0;
  var bag = loadBag();
  var current = null;
  var spinning = false;
  var lastShown = null;

  function render(t, dim) {
    termEl.textContent = t.term;
    defEl.textContent = t.def || '（暂无释义，可在词库管理中补充）';
    catEl.textContent = t.cat || '词条';
    defEl.classList.toggle('dim', !!dim);
  }
  function renderMeta() {
    metaEl.textContent = '词库 ' + terms.length + ' 条 · 已抽 ' + drawnCount + ' 次';
  }
  function showRandomTerm() {
    var t = terms[Math.floor(Math.random() * terms.length)];
    if (terms.length > 1 && t === lastShown) {
      t = terms[(terms.indexOf(t) + 1 + Math.floor(Math.random() * (terms.length - 1))) % terms.length];
    }
    lastShown = t;
    render(t, true);
  }

  function draw() {
    if (spinning) return;
    if (!terms.length) { toast('词库为空，请先在「词库管理」中添加词条'); return; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();

    spinning = true;
    drawBtn.disabled = true;
    drawBtn.textContent = '抽取中…';
    card.classList.add('spinning');

    var start = performance.now();
    var nextAt = 0; // 下一次词条切换的绝对时刻
    var timer = null;

    function step() {
      var now = performance.now();
      if (now - start >= SPIN_MS) { land(); return; }
      if (now >= nextAt) {
        var p = (now - start) / SPIN_MS;
        showRandomTerm();
        tickSound(p);
        // 间隔随进度从 45ms 缓慢拉长到 320ms，形成减速落定感
        nextAt = now + 45 + 275 * p * p * p;
      }
      // 用 setTimeout 自调度而非 rAF：后台标签页/低帧率环境下也能保证按时落定
      timer = setTimeout(step, Math.max(0, nextAt - performance.now()));
    }
    step();
  }

  function land() {
    current = nextTerm();
    drawnCount++;
    localStorage.setItem(LS_COUNT, String(drawnCount));
    render(current, false);
    card.classList.remove('spinning');
    card.classList.remove('land');
    void card.offsetWidth; // 重新触发动画
    card.classList.add('land');
    landSound();
    spinning = false;
    drawBtn.disabled = false;
    drawBtn.textContent = '再抽一次';
    renderMeta();
  }

  /* ================= TTS 朗读（Web Speech） ================= */

  var speaking = false;
  function setSpeakUI() { ttsBtn.textContent = speaking ? '停止' : '朗读'; }

  function isZh(s) { return /[\u4e00-\u9fff]/.test(s); }
  function pickVoice(lang) {
    var vs = speechSynthesis.getVoices().filter(function (v) {
      return v.lang.replace('_', '-').toLowerCase().indexOf(lang.slice(0, 2)) === 0;
    });
    return vs.find(function (v) { return v.localService; }) || vs[0] || null;
  }
  function utter(text) {
    var u = new SpeechSynthesisUtterance(text);
    u.lang = isZh(text) ? 'zh-CN' : 'en-US';
    var v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.rate = 0.95;
    return u;
  }

  function toggleSpeak() {
    if (!('speechSynthesis' in window)) { toast('当前浏览器不支持语音朗读'); return; }
    if (speaking) {
      speechSynthesis.cancel();
      speaking = false; setSpeakUI();
      return;
    }
    if (!current) { toast('先抽取一个词条吧'); return; }
    speechSynthesis.cancel();
    var u1 = utter(current.term), u2 = utter(current.def || current.term);
    var stop = function () { speaking = false; setSpeakUI(); };
    u1.onend = function () { if (speaking) speechSynthesis.speak(u2); };
    u1.onerror = stop;
    u2.onend = stop;
    u2.onerror = stop;
    speaking = true; setSpeakUI();
    speechSynthesis.speak(u1);
  }

  /* ================= 专注计时 ================= */

  var PHASE_META = [
    { key: 'study', label: '学习' },
    { key: 'memory', label: '记忆' },
    { key: 'recite', label: '复述' }
  ];
  var sliders = { study: $('s-study'), memory: $('s-memory'), recite: $('s-recite') };
  var sliderTabs = document.querySelectorAll('.slider-tab');
  var sliderRows = document.querySelectorAll('.slider-row');

  // 各阶段默认时长（分钟），点击 tab 时滑块回到该阶段的默认值
  var SLIDE_DEFAULTS = { study: 15, memory: 5, recite: 1 };

  // 顶部标签切换：点击哪个阶段，就只展示那个阶段的滑块，并回到该阶段默认值
  function showSlider(key, reset) {
    // 计时进行中不允许切换 tab，避免干扰正在倒计时的阶段
    if (tState.running) return;
    sliderTabs.forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-key') === key);
    });
    sliderRows.forEach(function (r) {
      r.classList.toggle('hidden', r.getAttribute('data-row') !== key);
    });
    if (reset) {
      // 行显示后再赋值：display:none 时浏览器会忽略 range 的 value 设置
      mins[key] = SLIDE_DEFAULTS[key];
      sliders[key].value = SLIDE_DEFAULTS[key];
      localStorage.setItem(LS_SLIDERS, JSON.stringify(mins));
    }
    // 未运行时，时钟跟随当前 tab 显示该阶段时长
    if (!tState.running && !tState.finished) {
      var idx = PHASE_META.findIndex(function (p) { return p.key === key; });
      tState.phase = idx;
      tState.remain = phaseSecs(idx);
      tState.endAt = Date.now() + tState.remain * 1000;
    }
    renderTimer();
  }
  sliderTabs.forEach(function (t) {
    t.addEventListener('click', function () { showSlider(t.getAttribute('data-key'), true); });
  });
  // 初始化切换在文件末尾执行（需等 mins 加载完成后再调 renderTimer）

  var clockEl = $('timerClock'), barEl = $('timerBar'), totalEl = $('timerTotal');
  var timerBtn = $('timerBtn'), resetBtn = $('resetBtn');

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // 三档迁移：v3 分钟制 → v2 番茄钟个数制（×25 换算）→ v1 分钟制
  function loadSliders() {
    var valid = function (s) {
      return s && PHASE_META.every(function (p) { return typeof s[p.key] === 'number'; });
    };
    try {
      var raw = localStorage.getItem(LS_SLIDERS);
      if (raw) {
        var s = JSON.parse(raw);
        if (valid(s)) {
          return {
            study: clamp(Math.round(s.study), 10, 60),
            memory: clamp(Math.round(s.memory), 5, 30),
            recite: clamp(Math.round(s.recite), 1, 5)
          };
        }
      }
    } catch (e) {}
    // v2（番茄钟个数制）：学习个数 × 25 换算成分钟
    try {
      var old2 = JSON.parse(localStorage.getItem(LS_SLIDERS_V2));
      if (valid(old2)) {
        var mig2 = {
          study: clamp(Math.round(old2.study * 25), 10, 60),
          memory: clamp(Math.round(old2.memory), 5, 30),
          recite: clamp(Math.round(old2.recite), 1, 5)
        };
        localStorage.setItem(LS_SLIDERS, JSON.stringify(mig2));
        localStorage.removeItem(LS_SLIDERS_V2);
        return mig2;
      }
    } catch (e) {}
    // v1（分钟制）：直接钳制到新范围
    try {
      var old1 = JSON.parse(localStorage.getItem(LS_SLIDERS_V1));
      if (valid(old1)) {
        var mig1 = {
          study: clamp(Math.round(old1.study), 10, 60),
          memory: clamp(Math.round(old1.memory), 5, 30),
          recite: clamp(Math.round(old1.recite), 1, 5)
        };
        localStorage.setItem(LS_SLIDERS, JSON.stringify(mig1));
        localStorage.removeItem(LS_SLIDERS_V1);
        return mig1;
      }
    } catch (e) {}
    return { study: 15, memory: 5, recite: 1 };
  }
  var mins = loadSliders();

  var tState = { running: false, finished: false, phase: 0, remain: 0, endAt: 0, tick: null };

  function phaseSecs(i) { return mins[PHASE_META[i].key] * 60; }
  function totalSecs() {
    return PHASE_META.reduce(function (s, p, i) { return s + phaseSecs(i); }, 0);
  }
  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }

  function renderTimer() {
    PHASE_META.forEach(function (p) {
      $('v-' + p.key).textContent = mins[p.key] + ' 分钟';
    });
    totalEl.textContent = '共 ' + Math.round(totalSecs() / 60) + ' 分钟';

    clockEl.textContent = fmt(tState.remain);
    clockEl.classList.toggle('running', tState.running);

    // 进度条量程只算当前阶段及之后的剩余阶段：在哪个 tab 开始专注，就从 0 起算
    var base = 0;
    for (var j = 0; j < tState.phase; j++) base += phaseSecs(j);
    var total = totalSecs() - base;
    var elapsed = 0;
    if (tState.finished) {
      elapsed = total;
    } else if (tState.running) {
      elapsed = phaseSecs(tState.phase) - Math.max(0, tState.remain);
    }
    // 未开始专注时进度条留空，避免切换 tab 时出现无意义的进度
    barEl.style.width = (tState.running || tState.finished ? Math.min(100, elapsed / total * 100) : 0) + '%';
  }

  function setRunningUI() {
    timerBtn.textContent = tState.running ? '暂停' : (tState.finished ? '再来一轮' : '开始专注');
    PHASE_META.forEach(function (p) { sliders[p.key].disabled = tState.running; });
  }

  /* 跳过 0 分钟的阶段，进入下一个有效阶段；全部无剩余则收尾 */
  function advance() {
    while (tState.phase < PHASE_META.length && phaseSecs(tState.phase) === 0) tState.phase++;
    if (tState.phase >= PHASE_META.length) return false;
    tState.remain = phaseSecs(tState.phase);
    tState.endAt = Date.now() + tState.remain * 1000;
    return true;
  }

  function timerTick() {
    tState.remain = (tState.endAt - Date.now()) / 1000;
    if (tState.remain <= 0) {
      tState.phase++;
      if (!advance()) { finishTimer(); return; }
      phaseSound();
      toast('进入「' + PHASE_META[tState.phase].label + '」阶段');
    }
    renderTimer();
  }

  function toggleTimer() {
    if (tState.running) { // 暂停
      clearInterval(tState.tick);
      tState.running = false;
      setRunningUI(); renderTimer();
      return;
    }
    if (tState.finished) resetTimer();
    if (totalSecs() === 0) { toast('三个阶段都还是 0 分钟，先调一下时间吧'); return; }
    if (tState.remain <= 0 && !advance()) return;

    startSound(); // 点击开始的音效
    tState.running = true;
    tState.endAt = Date.now() + tState.remain * 1000;
    tState.tick = setInterval(timerTick, 200);
    setRunningUI(); renderTimer();
  }

  function finishTimer() {
    clearInterval(tState.tick);
    tState.running = false;
    tState.finished = true;
    tState.remain = 0;
    doneSound();
    toast('三段专注全部完成，干得漂亮');
    setRunningUI(); renderTimer();
  }

  function resetTimer() {
    clearInterval(tState.tick);
    tState.running = false;
    tState.finished = false;
    tState.phase = 0;
    tState.remain = phaseSecs(0);
    if (tState.remain === 0 && totalSecs() > 0) advance();
    setRunningUI(); renderTimer();
  }

  /* ================= 词库管理 ================= */

  var modal = $('manageModal');
  var termListBox = $('termList'), listSearch = $('listSearch');
  var addTermInput = $('addTermInput'), addCatInput = $('addCatInput'), addDefInput = $('addDefInput');
  var importText = $('importText'), importFile = $('importFile');
  var wikiInput = $('wikiInput'), wikiBtn = $('wikiBtn');

  function renderList(query) {
    var q = (query || '').trim().toLowerCase();
    var items = [];
    terms.forEach(function (t, i) {
      if (!q || (t.term + ' ' + (t.def || '')).toLowerCase().indexOf(q) >= 0) items.push({ t: t, i: i });
    });
    termListBox.innerHTML = items.length
      ? items.map(function (o) {
          return '<div class="row">' +
            '<div class="row-main"><b>' + esc(o.t.term) + '</b>' +
            (o.t.cat ? '<span class="row-cat">' + esc(o.t.cat) + '</span>' : '') +
            '<span class="row-def">' + esc(o.t.def || '') + '</span></div>' +
            '<button class="row-del" data-i="' + o.i + '" title="删除">×</button>' +
          '</div>';
        }).join('')
      : '<p class="empty">没有匹配的词条</p>';
  }

  /* 返回 true=新增，false=更新已有词条 */
  function addTermSilent(term, def, cat) {
    term = String(term || '').trim();
    def = String(def || '').trim();
    cat = String(cat || '').trim();
    if (!term) return null;
    var idx = terms.findIndex(function (t) { return t.term.toLowerCase() === term.toLowerCase(); });
    if (idx >= 0) {
      terms[idx] = { term: terms[idx].term, def: def || terms[idx].def, cat: cat || terms[idx].cat };
      return false;
    }
    terms.push({ term: term, def: def, cat: cat });
    return true;
  }

  function addTerm() {
    var term = addTermInput.value.trim();
    if (!term) { toast('词条名不能为空'); return; }
    var added = addTermSilent(term, addDefInput.value, addCatInput.value);
    if (added === null) { toast('词条名不能为空'); return; }
    saveTerms();
    renderList(listSearch.value);
    addTermInput.value = ''; addDefInput.value = '';
    toast(added ? '已添加「' + term + '」' : '已更新「' + term + '」');
  }

  /* 每行一条：优先 Tab，其次 ｜ | ： : —— – ，最后 " - " */
  function splitLine(line) {
    var seps = [/\t+/, /\s*[｜|]\s*/, /\s*[：:]\s*/, /\s*[—–]{1,2}\s*/, /\s+-\s+/];
    for (var k = 0; k < seps.length; k++) {
      var i = line.search(seps[k]);
      if (i > 0) {
        var parts = line.split(seps[k]);
        var term = parts[0].trim(), def = parts.slice(1).join(' ').trim();
        if (term && def) return [term, def];
      }
    }
    return [line.trim(), ''];
  }

  function parseImport(text) {
    text = String(text || '').trim();
    if (!text) return [];
    var out = [];
    try {
      var j = JSON.parse(text);
      if (Array.isArray(j)) {
        j.forEach(function (it) {
          if (typeof it === 'string') {
            var p = splitLine(it);
            if (p[0]) out.push({ term: p[0], def: p[1], cat: '' });
          } else if (it && typeof it === 'object') {
            var term = it.term || it.t || it.name || it.word || it['词条'];
            var def = it.def || it.d || it.definition || it.description || it['释义'] || it['解释'] || '';
            var cat = it.cat || it.c || it.category || it['分类'] || '';
            if (term) out.push({ term: String(term), def: String(def), cat: String(cat) });
          }
        });
        return out;
      }
    } catch (e) { /* 非 JSON，按行解析 */ }
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var p = splitLine(line);
      if (p[0]) out.push({ term: p[0], def: p[1], cat: '' });
    });
    return out;
  }

  /* ---------- 表格解析：csv / tsv / xlsx 通用 ---------- */

  // 解析 CSV/TSV 文本为二维数组（支持引号包裹字段）
  function parseCSV(text, delimiter) {
    var rows = [], row = [], field = '', inQuotes = false;
    var len = text.length;
    for (var i = 0; i < len; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === delimiter || c === '\n' || c === '\r') {
          row.push(field); field = '';
          if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            rows.push(row); row = [];
          }
        } else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) {
      return r.some(function (f) { return String(f).trim() !== ''; });
    });
  }

  function indexOfHeader(header, keys) {
    for (var i = 0; i < keys.length; i++) {
      var idx = header.indexOf(keys[i]);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  // 二维数组 → 词条数组：自动识别表头（词条/释义/分类列），无表头按列序
  function rowsToTerms(rows) {
    var out = [];
    if (!rows || !rows.length) return out;
    var start = 0;
    var termCol = 0, defCol = 1, catCol = 2;
    var first = rows[0].map(function (v) {
      return String(v == null ? '' : v).trim().toLowerCase();
    });
    if (first.some(function (h) {
      return ['term', '词条', 'name', '标题', '名称', 'word'].indexOf(h) >= 0;
    })) {
      start = 1;
      termCol = indexOfHeader(first, ['term', '词条', 'name', '标题', '名称', 'word']);
      defCol = indexOfHeader(first, ['def', 'definition', '释义', '解释', '描述', 'description', 'meaning', '定义']);
      catCol = indexOfHeader(first, ['cat', 'category', '分类', '类别']);
      if (termCol < 0) termCol = 0;
      if (defCol < 0) defCol = termCol === 0 ? 1 : 0;
      if (catCol < 0) catCol = 2;
    }
    function cell(r, idx) {
      var v = r[idx];
      return v == null ? '' : String(v).trim();
    }
    for (var i = start; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.length) continue;
      var term = cell(r, termCol);
      if (!term) continue;
      out.push({ term: term, def: cell(r, defCol), cat: cell(r, catCol) });
    }
    return out;
  }

  // 解析 xlsx/xls：动态加载 SheetJS（仅在使用时加载，失败则提示降级格式）
  function importXLSX(file) {
    return new Promise(function (resolve, reject) {
      if (typeof XLSX === 'undefined') {
        var s = document.createElement('script');
        s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
        s.onload = function () { doRead(); };
        s.onerror = function () { reject(new Error('SheetJS 加载失败')); };
        document.head.appendChild(s);
      } else {
        doRead();
      }
      function doRead() {
        try {
          file.arrayBuffer().then(function (ab) {
            var wb = XLSX.read(ab, { type: 'array' });
            var rows = [];
            wb.SheetNames.forEach(function (name) {
              var ws = wb.Sheets[name];
              if (!ws) return;
              var arr = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
              rows = rows.concat(arr);
            });
            resolve(rows);
          }, reject);
        } catch (e) { reject(e); }
      }
    });
  }

  function applyImport(items) {
    if (!items || !items.length) { toast('没有解析到有效词条，请检查格式'); return; }
    var added = 0, updated = 0;
    items.forEach(function (it) {
      if (addTermSilent(it.term, it.def, it.cat)) added++; else updated++;
    });
    saveTerms();
    renderList(listSearch.value);
    toast('导入完成：新增 ' + added + ' 条，更新 ' + updated + ' 条');
  }

  function exportJSON() {
    var blob = new Blob([JSON.stringify(terms, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'random-lex-terms.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 ' + terms.length + ' 条词条');
  }

  function fetchWiki() {
    var title = wikiInput.value.trim();
    if (!title) { toast('请输入要抓取的词条名'); return; }
    wikiBtn.disabled = true;
    var oldLabel = wikiBtn.textContent;
    wikiBtn.textContent = '抓取中…';
    // 10 秒无响应自动中止，避免按钮永久卡在「抓取中…」
    var aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (aborter) var kill = setTimeout(function () { aborter.abort(); }, 10000);
    fetch('https://zh.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title) + '?redirect=true', {
      signal: aborter ? aborter.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) {
        if (!j.extract) throw new Error('no extract');
        addTermSilent(j.title || title, j.extract, '维基百科');
        saveTerms();
        renderList(listSearch.value);
        wikiInput.value = '';
        toast('已从维基百科添加「' + (j.title || title) + '」');
      })
      .catch(function () {
        toast('抓取失败：未找到该词条，或网络不可用');
      })
      .then(function () {
        if (typeof kill !== 'undefined') clearTimeout(kill);
        wikiBtn.disabled = false;
        wikiBtn.textContent = oldLabel;
      });
  }

  function openModal() { renderList(listSearch.value); modal.classList.remove('hidden'); }
  function closeModal() { modal.classList.add('hidden'); }

  /* ================= 事件绑定 ================= */

  drawBtn.addEventListener('click', draw);
  ttsBtn.addEventListener('click', toggleSpeak);

  timerBtn.addEventListener('click', toggleTimer);
  resetBtn.addEventListener('click', resetTimer);

  PHASE_META.forEach(function (p) {
    sliders[p.key].value = mins[p.key];
    sliders[p.key].addEventListener('input', function (e) {
      var v = parseInt(e.target.value, 10);
      // 各滑块范围：学习 10-60 分钟，记忆 5-30 分钟，复述 1-5 分钟
      if (p.key === 'study') mins.study = clamp(v, 10, 60);
      else if (p.key === 'memory') mins.memory = clamp(v, 5, 30);
      else mins.recite = clamp(v, 1, 5);
      localStorage.setItem(LS_SLIDERS, JSON.stringify(mins));
      if (!tState.running && !tState.finished) {
        // 时钟跟随当前拖动的滑块所属阶段
        tState.phase = PHASE_META.findIndex(function (p2) { return p2.key === p.key; });
        tState.remain = phaseSecs(tState.phase);
        if (tState.remain === 0) advance(); // 当前阶段被调为 0 时跳到下一阶段
        else tState.endAt = Date.now() + tState.remain * 1000;
      }
      renderTimer();
    });
  });

  $('manageBtn').addEventListener('click', openModal);
  $('closeModalBtn').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  $('addBtn').addEventListener('click', addTerm);
  $('importBtn').addEventListener('click', function () {
    applyImport(parseImport(importText.value));
    importText.value = '';
  });
  $('exportBtn').addEventListener('click', exportJSON);
  $('importFileBtn').addEventListener('click', function () { importFile.click(); });
  importFile.addEventListener('change', function () {
    var f = importFile.files && importFile.files[0];
    if (!f) return;
    importFile.value = '';
    var name = (f.name || '').toLowerCase();
    if (/\.xlsx?$/.test(name)) {
      // Excel：动态加载 SheetJS 解析
      importXLSX(f).then(function (rows) {
        applyImport(rowsToTerms(rows));
      }).catch(function () {
        toast('Excel 解析失败：可能无法加载解析库，请改用 csv / tsv / txt 格式');
      });
    } else {
      f.text().then(function (text) {
        var items;
        if (/\.json$/.test(name)) {
          items = parseImport(text); // JSON 数组
        } else if (/\.csv$/.test(name)) {
          items = rowsToTerms(parseCSV(text, ',')); // 逗号表格
        } else if (/\.tsv$/.test(name)) {
          items = rowsToTerms(parseCSV(text, '\t')); // 制表符表格
        } else {
          items = parseImport(text); // txt 等：每行一条
        }
        applyImport(items);
      });
    }
  });
  $('wikiBtn').addEventListener('click', fetchWiki);
  wikiInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') fetchWiki(); });
  listSearch.addEventListener('input', function () { renderList(listSearch.value); });

  termListBox.addEventListener('click', function (e) {
    var btn = e.target.closest('.row-del');
    if (!btn) return;
    var i = parseInt(btn.dataset.i, 10);
    var name = terms[i] && terms[i].term;
    terms.splice(i, 1);
    saveTerms();
    renderList(listSearch.value);
    toast('已删除「' + name + '」');
  });

  $('resetBuiltinBtn').addEventListener('click', function () {
    if (!confirm('将词库重置为内置词条（自定义词条会被清除），继续？')) return;
    terms = BUILTIN_TERMS.map(function (t) {
      return { term: t.term, def: t.def, cat: t.cat || '' };
    });
    saveTerms();
    renderList(listSearch.value);
    toast('已重置为内置词库');
  });

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.code === 'Space' && modal.classList.contains('hidden')) {
      e.preventDefault();
      draw();
    }
  });

  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = function () {}; // 触发语音列表加载
  }

  /* ================= 初始化 ================= */

  current = terms.length ? terms[Math.floor(Math.random() * terms.length)] : null;
  if (current) render(current, false);
  renderMeta();
  resetTimer(); // 初始化计时显示（不启动）
  showSlider('study', false); // 初始化滑块页签（此时 mins 已就绪）
})();
