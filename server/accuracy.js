'use strict';
// MI Signal Accuracy — grades every signal MI emits against REAL prices:
// does price hit take-profit first (win) or stop-loss first (loss)?
// Persisted in data/db.json so performance is honest and auditable.
// This is the trust layer: the app shows its own real win-rate & expectancy.

const GRADE_MS = 24 * 15 * 60 * 1000; // grade for a ~6h window
const DEBOUNCE_MS = 180000;           // at most one open grade per symbol / 3 min
const MAX = 600;

class Accuracy {
  constructor(store) {
    this.store = store;
  }

  list() { return this.store.data.signalAccuracy || []; }

  observe(sig) {
    if (!sig || !sig.takeProfit || !sig.stopLoss) return;
    if (sig.action === 'HOLD' || sig.action === 'NEUTRAL') return;
    const arr = this.list();
    const now = Date.now();
    const recent = arr
      .filter(r => r.symbol === sig.symbol && r.status === 'open')
      .sort((a, b) => b.ts - a.ts)[0];
    if (recent && now - recent.ts < DEBOUNCE_MS) return; // don't spam duplicates
    arr.push({
      id: sig.symbol + '-' + now + '-' + Math.floor(Math.random() * 1e4),
      symbol: sig.symbol,
      action: sig.action,
      mode: sig.mode || 'crypto',
      confidence: sig.confidence,
      quality: sig.quality || 'LOW',
      entry: sig.entry,
      takeProfit: sig.takeProfit,
      stopLoss: sig.stopLoss,
      rr: sig.riskReward || null,
      ts: now,
      expiresAt: now + GRADE_MS,
      status: 'open', // open | closed | expired
      result: null,   // win | loss
      exitPrice: null,
      closedAt: null,
    });
    if (arr.length > MAX) arr.splice(0, arr.length - MAX);
    this.store.save();
  }

  check(prices) {
    const arr = this.list();
    let changed = false;
    for (const r of arr) {
      if (r.status !== 'open') continue;
      const px = prices[r.symbol];
      if (px === undefined) continue;
      const isBuy = r.action === 'BUY' || r.action === 'CALL';
      if (isBuy) {
        if (px >= r.takeProfit) { r.status = 'closed'; r.result = 'win'; r.exitPrice = px; r.closedAt = Date.now(); changed = true; continue; }
        if (px <= r.stopLoss) { r.status = 'closed'; r.result = 'loss'; r.exitPrice = px; r.closedAt = Date.now(); changed = true; continue; }
      } else {
        if (px <= r.takeProfit) { r.status = 'closed'; r.result = 'win'; r.exitPrice = px; r.closedAt = Date.now(); changed = true; continue; }
        if (px >= r.stopLoss) { r.status = 'closed'; r.result = 'loss'; r.exitPrice = px; r.closedAt = Date.now(); changed = true; continue; }
      }
      if (Date.now() > r.expiresAt) { r.status = 'expired'; r.closedAt = Date.now(); changed = true; }
    }
    if (changed) this.store.save();
  }

  stats() {
    const all = this.list();
    const closed = all.filter(r => r.status === 'closed');
    const wins = closed.filter(r => r.result === 'win');
    const losses = closed.filter(r => r.result === 'loss');
    const graded = wins.length + losses.length;
    const winRate = graded ? Math.round((wins.length / graded) * 100) : 0;
    const totalR = wins.reduce((a, r) => a + (r.rr || 1), 0) - losses.length;
    const expectancy = graded ? totalR / graded : 0;
    const avgWin = wins.length ? wins.reduce((a, r) => a + (r.rr || 1), 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, r) => a + (r.rr || 1), 0) / losses.length : 0;

    const byTier = {};
    const byMode = {};
    for (const r of closed) {
      const t = r.quality || 'LOW';
      if (!byTier[t]) byTier[t] = { wins: 0, losses: 0 };
      if (r.result === 'win') byTier[t].wins += 1; else if (r.result === 'loss') byTier[t].losses += 1;
      const m = r.mode || 'crypto';
      if (!byMode[m]) byMode[m] = { wins: 0, losses: 0 };
      if (r.result === 'win') byMode[m].wins += 1; else if (r.result === 'loss') byMode[m].losses += 1;
    }

    return {
      total: all.length,
      open: all.filter(r => r.status === 'open').length,
      expired: all.filter(r => r.status === 'expired').length,
      graded,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      expectancy: +expectancy.toFixed(3), // R per trade
      byTier,
      byMode,
      // 30-day projection at 1R = 2% of account, 2 signals/day
      projected30d: +(expectancy * 0.02 * 2 * 30 * 100).toFixed(0),
      updatedAt: Date.now(),
    };
  }

  history() {
    return this.list().slice().sort((a, b) => b.ts - a.ts).slice(0, 100);
  }

  clear() {
    this.store.data.signalAccuracy = [];
    this.store.save(true);
  }
}

module.exports = Accuracy;