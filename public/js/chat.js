/* ============ MI Assistant — real AI chat via OpenRouter (streaming) ============ */
(function () {
  'use strict';

  const history = [];
  let streaming = false;

  function $id(id) { return document.getElementById(id); }
  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function addBubble(role, text, cls) {
    const thread = $id('chatThread');
    if (!thread) return null;
    const el = document.createElement('div');
    el.className = 'msg ' + role + (cls ? ' ' + cls : '');
    el.textContent = text;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function renderContext() {
    const el = $id('aiContext');
    if (!el) return;
    const prices = (window.MINotify && MINotify.getPrices()) || {};
    const sum = (window.MINotify && MINotify.getSummary()) || {};
    const count = Object.keys(prices).length;
    const chips = [
      '<span class="ctx-chip">📶 ' + count + ' pairs live</span>',
      '<span class="ctx-chip">🎯 sentiment: ' + (sum.sentiment || '…') + '</span>',
      '<span class="ctx-chip">⚡ signals: ' + (sum.buys || 0) + 'B / ' + (sum.sells || 0) + 'S</span>',
      '<span class="ctx-chip">🧠 AI sees live market context every message</span>',
    ];
    el.innerHTML = chips.join('');
  }

  async function send(overrideText) {
    if (streaming) return;
    const input = $id('chatInput');
    const text = (overrideText !== undefined ? overrideText : input.value).trim();
    if (!text) return;
    if (input) input.value = '';

    history.push({ role: 'user', content: text });
    addBubble('user', text);

    const aiBubble = addBubble('ai', '…');
    streaming = true;
    $id('chatSend').disabled = true;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-10) }),
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
            if (json.delta) { answer += json.delta; aiBubble.textContent = answer; }
          } catch { /* partial */ }
        }
        threadAutoScroll();
      }

      if (error) throw new Error(error);
      if (!answer) throw new Error('The assistant returned no content. Check the model availability on OpenRouter.');

      aiBubble.textContent = answer;
      history.push({ role: 'assistant', content: answer });
      renderContext();
    } catch (err) {
      aiBubble.textContent = '';
      aiBubble.className = 'msg error';
      aiBubble.textContent = '⚠️ ' + err.message + (err.message.includes('OpenRouter') ? ' — check the OPENROUTER_API_KEY in .env' : '');
    } finally {
      streaming = false;
      $id('chatSend').disabled = false;
      if (input) input.focus();
    }
  }

  function threadAutoScroll() {
    const thread = $id('chatThread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  function init() {
    const form = $id('chatForm');
    const input = $id('chatInput');
    const clearBtn = $id('chatClear');
    const chips = document.querySelectorAll('#chatChips .chip');
    const modelTag = $id('aiModelTag');

    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    clearBtn.addEventListener('click', () => {
      history.length = 0;
      const thread = $id('chatThread');
      if (thread) thread.innerHTML = '';
      addBubble('ai', 'Conversation cleared. Ask me anything about the markets — I have live data right now.');
    });
    chips.forEach(c => c.addEventListener('click', () => {
      if (streaming) return;
      send(c.textContent.trim());
    }));

    if (MI.config && MI.config.aiModel) {
      modelTag.textContent = 'Model: ' + MI.config.aiModel + (MI.config.aiEnabled ? '' : ' · AI not configured on server');
    }

    addBubble('ai', '👋 Welcome. I\'m MI — your professional AI market analyst, powered by OpenRouter.\n\nI have ' + 'live' + ' market context: prices, the MI engine signals, and paper-trading stats. Ask me to analyze a pair, plan a trade with entry/stop/target, or explain risk.');
    renderContext();
    MINotify.onEvent('market', renderContext);
  }

  window.MIChat = { init, send };
})();