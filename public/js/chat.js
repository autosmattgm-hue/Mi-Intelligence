/* ============ MI Assistant — real AI chat via OpenRouter (streaming)
 * - text + IMAGE input (vision models scan chart screenshots)
 * - beginner / balanced / pro audience levels
 * - real trade-timing widget (best hours & days from market data)
 * ==================================================================== */
(function () {
  'use strict';

  const history = [];
  const pendingImages = []; // { dataUrl, name }
  let streaming = false;
  let level = localStorage.getItem('mi.ai.level') || 'beginner';
  let timingData = null;
  let pulseChips = [];

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* ---- lightweight, XSS-safe Markdown renderer for AI replies ----
     Input is HTML-escaped first, then transformed into safe tags, so user/AI
     text can never inject markup. Supports headings, bold/italic/strike,
     inline code, fenced code, bullet & numbered lists, blockquotes, hr,
     links and paragraphs. */
  function inlineMd(s) {
    return s
      .replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function renderMarkdown(src) {
    const text = String(src || '');
    const esc = text.replace(/\r\n/g, '\n')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const codeBlocks = [];
    let md = esc.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push('<pre><code>' + code.trim() + '</code></pre>');
      return '\u0000mcode' + (codeBlocks.length - 1) + '\u0000';
    });
    const lines = md.split('\n');
    const out = [];
    let list = null;
    const flushList = () => {
      if (!list) return;
      out.push('<' + list.type + '>' + list.items.map(i => '<li>' + i + '</li>').join('') + '</' + list.type + '>');
      list = null;
    };
    const isBlockStart = (l) => {
      const t = l.trim();
      return !t || /^(#{1,5})\s/.test(t) || /^[-*]\s/.test(t) || /^\d+[.)]\s/.test(t) || /^&gt;/.test(t) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(t) || /^\u0000mcode\d+\u0000$/.test(t);
    };
    let i = 0;
    const n = lines.length;
    while (i < n) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { flushList(); i++; continue; }
      const codeMatch = line.match(/^\u0000mcode(\d+)\u0000$/);
      if (codeMatch) { flushList(); out.push(codeBlocks[+codeMatch[1]]); i++; continue; }
      const h = trimmed.match(/^(#{1,5})\s+(.*)$/);
      if (h) { flushList(); const lv = h[1].length; out.push('<h' + lv + '>' + inlineMd(h[2]) + '</h' + lv + '>'); i++; continue; }
      const bq = trimmed.match(/^&gt;\s?(.*)$/);
      if (bq) { flushList(); out.push('<blockquote>' + inlineMd(bq[1]) + '</blockquote>'); i++; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) && trimmed.length <= 80) { flushList(); out.push('<hr>'); i++; continue; }
      const ul = trimmed.match(/^[-*]\s+(.*)$/);
      const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ul) { if (list && list.type !== 'ul') flushList(); if (!list) list = { type: 'ul', items: [] }; list.items.push(inlineMd(ul[1])); i++; continue; }
      if (ol) { if (list && list.type !== 'ol') flushList(); if (!list) list = { type: 'ol', items: [] }; list.items.push(inlineMd(ol[1])); i++; continue; }
      flushList();
      const para = [inlineMd(trimmed)];
      i++;
      while (i < n && !isBlockStart(lines[i])) { para.push(inlineMd(lines[i].trim())); i++; }
      out.push('<p>' + para.join('<br>') + '</p>');
    }
    flushList();
    return out.join('');
  }

  function renderContext() {
    const el = $id('aiContext');
    if (!el) return;
    const prices = (window.MINotify && MINotify.getPrices()) || {};
    const sum = (window.MINotify && MINotify.getSummary()) || {};
    const count = Object.keys(prices).length;
    const chips = [
      '<span class="ctx-chip">📶 ' + count + ' pairs live</span>',
      '<span class="ctx-chip">🎯 ' + (sum.sentiment || '…') + ' · ' + (sum.buys || 0) + 'B / ' + (sum.sells || 0) + 'S</span>',
      '<span class="ctx-chip">🟢 level: ' + esc(level) + '</span>',
      (pendingImages.length ? '<span class="ctx-chip">🖼️ ' + pendingImages.length + ' image ready</span>' : ''),
      '<span class="ctx-chip">🧠 AI has live context + sees your chart</span>',
    ].concat(pulseChips.map(p => '<span class="ctx-chip">' + p + '</span>'));
    el.innerHTML = chips.join('');
  }

  function loadPulseChips() {
    try {
      Promise.all([MI.api.get('/api/sentiment'), MI.api.get('/api/calendar')]).then(([s, c]) => {
        const next = [];
        if (s && s.fearGreed) next.push('🧠 ' + s.fearGreed.value + ' · ' + s.fearGreed.classification);
        const imp = (c && c.imminentHigh) || [];
        if (imp.length) next.push('🕐 ' + imp.slice(0, 2).map(e => e.title).join(' · '));
        pulseChips = next;
        renderContext();
      }).catch(() => {});
    } catch { /* optional */ }
  }

  function addBubble(role, text, cls) {
    const thread = $id('chatThread');
    if (!thread) return null;
    const el = document.createElement('div');
    el.className = 'msg ' + role + (cls ? ' ' + cls : '');
    if (role === 'ai') el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function threadAutoScroll() {
    const thread = $id('chatThread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  // ------------------------------------------------------------- timing widget
  function renderTiming() {
    const body = $id('timingBody');
    const sym = $id('timingSymbol');
    if (!body) return;
    if (!timingData) {
      body.innerHTML = '<div class="timing-item muted">Loading best trade windows…</div>';
      return;
    }
    if (sym) sym.textContent = String(timingData.symbol || 'BTCUSDT').replace(/USDT$/, '/USDT');
    const best = timingData.bestHours || [];
    const days = timingData.bestDays || [];
    const quiet = timingData.quietHours || [];
    const bestList = best.slice(0, 4).map(h =>
      '<div class="timing-item"><span class="timing-t">' + esc(h.label || h.hour + ':00') + '</span>' +
      '<span class="timing-v">volatility ' + h.utcRangePct.toFixed(2) + '%</span></div>').join('');
    const dayList = days.slice(0, 3).map(d =>
      '<span class="timing-day">' + esc(d.label) + '</span>').join('');
    body.innerHTML =
      '<div class="timing-row"><span class="timing-k">Best hours (real data)</span></div>' +
      '<div class="timing-list">' + (bestList || '<div class="timing-item muted">—</div>') + '</div>' +
      '<div class="timing-row"><span class="timing-k">Best days</span> <span class="timing-days">' + dayList + '</span></div>' +
      '<div class="timing-row"><span class="timing-k">Quiet (avoid)</span> <span class="timing-days muted">' + quiet.map(esc).join(' · ') + '</span></div>' +
      '<div class="timing-foot">' + (timingData.sampleDays || '?') + ' days · ' + (timingData.candleCount || '?') + ' candles · ' +
      '<a class="link-btn" id="timingAsk">ask AI to plan my day</a></div>';
    const ask = $id('timingAsk');
    if (ask) ask.addEventListener('click', () => {
      send('Given the "when to trade" timing data above, make me a concrete trading schedule for today (best hours to enter, when to avoid).');
    });
  }

  async function fetchTiming() {
    const body = $id('timingBody');
    const symbol = (window.MIChart && MIChart.getSymbol()) || 'BTCUSDT';
    if (body) body.innerHTML = '<div class="timing-item muted">Refreshing…</div>';
    try {
      const res = await MI.api.get('/api/timing?symbol=' + symbol);
      timingData = res;
    } catch (err) {
      timingData = null;
      if (body) body.innerHTML = '<div class="timing-item muted">Timing unavailable: ' + esc(err.message) + '</div>';
    }
    renderTiming();
  }
// ------------------------------------------------------------- image upload
  // Read + downscale an image client-side so payloads stay small.
  async function fileToDataUrl(file) {
    if (!file || !file.type.startsWith('image/')) return null;
    const MAX = 1280;
    const blobUrl = URL.createObjectURL(file);
    return new Promise((resolve) => {
      const img = document.createElement('img');
      img.onload = () => {
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ct = cv.getContext('2d');
        ct.drawImage(img, 0, 0, w, h);
        const out = cv.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(blobUrl);
        resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(blobUrl); resolve(null); };
      img.src = blobUrl;
    });
  }

  function renderPreviews() {
    const wrap = $id('uploadPreviews');
    if (!wrap) return;
    wrap.innerHTML = '';
    pendingImages.forEach((im, i) => {
      const box = document.createElement('div');
      box.className = 'upload-preview';
      const el = document.createElement('img');
      el.src = im.dataUrl;
      el.alt = im.name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'row-btn';
      rm.textContent = '✕';
      rm.addEventListener('click', () => { pendingImages.splice(i, 1); renderPreviews(); renderContext(); });
      box.appendChild(el);
      box.appendChild(rm);
      wrap.appendChild(box);
    });
    renderContext();
  }

  function attachFiles(files) {
    if (!files) return;
    for (const f of Array.from(files || [])) {
      if (pendingImages.length >= 3) { if (window.MI && MI.toast) MI.toast('info', 'Max 3 images', 'Attach up to 3 screenshots at a time.'); break; }
      const res = fileToDataUrl(f);
      if (res) res.then(d => { if (d) { pendingImages.push({ dataUrl: d, name: f.name || 'image' }); renderPreviews(); } });
    }
  }

  // ------------------------------------------------------------- send
  async function send(overrideText) {
    if (streaming) return;
    const input = $id('chatInput');
    const text = (overrideText !== undefined ? overrideText : input.value).trim();
    if (!text && !pendingImages.length) {
      if (window.MI && MI.toast) MI.toast('info', 'Ask something or attach an image', 'Type a question or attach a chart screenshot.');
      return;
    }
    if (input) input.value = '';
    const images = pendingImages.splice(0, pendingImages.length);
    renderPreviews();

    history.push({ role: 'user', content: text || '(attached image — scan it)' });

    const thread = $id('chatThread');
    const userEl = document.createElement('div');
    userEl.className = 'msg user';
    userEl.textContent = text;
    images.forEach(im => {
      const el = document.createElement('img');
      el.className = 'msg-img';
      el.src = im.dataUrl;
      userEl.appendChild(el);
    });
    thread.appendChild(userEl);
    thread.scrollTop = thread.scrollHeight;

    const aiBubble = addBubble('ai', '…');
    streaming = true;
    $id('chatSend').disabled = true;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.slice(-12),
          images: images.map(im => ({ dataUrl: im.dataUrl, name: im.name })),
          level,
          timingSymbol: (window.MIChart && MIChart.getSymbol()) || 'BTCUSDT',
          profile: (function () {
            try {
              const g = JSON.parse(localStorage.getItem('mi.guard') || 'null');
              const j = JSON.parse(localStorage.getItem('mi.journal') || '[]');
              return g ? { guardrails: { riskPct: g.risk, dailyLossPct: g.day }, recentJournal: (j || []).slice(-2).map(x => x.note) } : null;
            } catch { return null; }
          })(),
        }),
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      if (!res.body) throw new Error('Empty response from server');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '', answer = '', error = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          try {
            const json = JSON.parse(data);
            if (json.error) { error = json.error; break; }
            if (json.delta) { answer += json.delta; aiBubble.innerHTML = renderMarkdown(answer); }
          } catch { /* partial */ }
        }
        threadAutoScroll();
      }

      if (error) throw new Error(error);
      if (!answer) throw new Error('The assistant returned no content. Check model availability on OpenRouter.');

      aiBubble.innerHTML = renderMarkdown(answer);
      history.push({ role: 'assistant', content: answer });
    } catch (err) {
      aiBubble.textContent = '';
      aiBubble.className = 'msg error';
      aiBubble.textContent = '⚠️ ' + err.message;
    } finally {
      streaming = false;
      $id('chatSend').disabled = false;
      if (input) input.focus();
      renderContext();
    }
  }
// ------------------------------------------------------------- level toggles
  function initLevel() {
    const seg = $id('aiLevel');
    if (!seg) return;
    [...seg.querySelectorAll('button')].forEach(b => {
      if (b.dataset.level === level) b.classList.add('active');
      b.addEventListener('click', () => {
        [...seg.querySelectorAll('button')].forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        level = b.dataset.level;
        localStorage.setItem('mi.ai.level', level);
        renderContext();
      });
    });
  }

  // ------------------------------------------------------------- init
  function init() {
    const form = $id('chatForm');
    const input = $id('chatInput');
    const clearBtn = $id('chatClear');
    const chips = document.querySelectorAll('#chatChips .chip');
    const modelTag = $id('aiModelTag');
    const attachBtn = $id('attachBtn');
    const fileInput = $id('fileInput');
    const refresh = $id('timingRefresh');

    if (modelTag) modelTag.textContent = 'Model: ' + ((MI.config && MI.config.aiModel) || '—') +
      (MI.config && MI.config.aiEnabled ? '' : ' · AI not configured');

    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      history.length = 0;
      pendingImages.length = 0;
      renderPreviews();
      const thread = $id('chatThread');
      if (thread) thread.innerHTML = '';
      addBubble('ai', 'Conversation cleared. Ask me anything, attach a chart screenshot, or ask when to trade — I have live data + a timing engine.');
    });
    [...chips].forEach(c => c.addEventListener('click', () => { if (streaming) return; send(c.textContent.trim()); }));

    // image attach (button + file input)
    if (attachBtn) attachBtn.addEventListener('click', () => { if (fileInput) fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', () => { attachFiles(fileInput.files); fileInput.value = ''; });

    // drag & drop anywhere over the chat panel
    const panel = document.querySelector('.ai-panel');
    if (panel) {
      panel.addEventListener('dragover', (e) => { e.preventDefault(); });
      panel.addEventListener('drop', (e) => { e.preventDefault(); attachFiles(e.dataTransfer.files); });
    }

    if (refresh) refresh.addEventListener('click', fetchTiming);
    initLevel();
    fetchTiming();
    loadPulseChips();

    addBubble('ai', '👋 I’m MI — your AI market analyst with VISION.\n\n🖼️ Upload a chart / screenshot above and I’ll scan it.\n🙂 Beginner / 🎓 Pro switcher adjusts every answer.\n🕒 Tap “When should I trade today?” for a real timing plan.\n\nEverything I say is grounded in live CoinMarketCap + Binance data.');
    renderContext();
    if (window.MINotify) {
      MINotify.onEvent('market', renderContext);
      MINotify.onEvent('signals', renderContext);
    }
  }

  window.MIChat = { init, send, fetchTiming, getLevel: () => level };
})();
