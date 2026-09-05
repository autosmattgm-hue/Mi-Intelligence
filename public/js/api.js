/* ============ MI shared API helper ============ */
window.MI = window.MI || {};

MI.api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: 'DELETE' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },
};

MI.fmt = {
  price(p) {
    if (p === null || p === undefined || isNaN(p)) return '—';
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return '$' + p.toFixed(2);
    return '$' + p.toFixed(4);
  },
  num(n, digits) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits || 2 });
  },
  pct(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  },
  time(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toUTCString().split(' ')[4] + ' UTC';
  },
  shortTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = Date.now();
    const diff = Math.max(0, now - ts);
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },
};