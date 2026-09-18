'use strict';

// MI Paper Trading Engine.
// Opens simulated positions on real signals and tracks their outcome against
// REAL market prices (TP / SL / time-stop). Win rate and PnL are therefore
// measured performance, not invented numbers.

function makeId() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36); }

const POSITION_MAX_HOURS = 12; // time-stop window
const MAX_POSITIONS = 4;
const NOTIONAL = 1000; // USD per paper position
const MIN_CONFIDENCE = 80;
const COOLDOWN_LOSSES = 2;    // consecutive losses that trigger protection
const COOLDOWN_MS = 30 * 60 * 1000; // 30-minute cooldown after the pattern

class PaperEngine {
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.lastSignalState = {}; // { symbol: { action, confidence, at } }
    this.cooldownUntil = 0;
  }

  get positions() { return this.store.data.paperPositions; }
  get history() { return this.store.data.paperHistory; }

  // Consecutive losses from the most recent paper trade backwards.
  lossStreak() {
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if ((this.history[i].pnl || 0) <= 0) streak += 1;
      else break;
    }
    return streak;
  }

  // Called on each signal refresh and ticker cycle.
  integrate(signals, prices) {
    if (!Array.isArray(signals) || signals.length === 0) return;
    const now = Date.now();

    // 1) Close time-expired positions.
    for (const pos of this.positions.slice()) {
      if (now - pos.openedAt > POSITION_MAX_HOURS * 3600 * 1000) {
        this.closePosition(pos, prices[pos.symbol] || pos.entry, 'TIME', now);
      }
    }

    // 2) Monitor TP / SL against live prices.
    for (const pos of this.positions.slice()) {
      const px = prices[pos.symbol];
      if (!px) continue;
      if (pos.side === 'BUY') {
        if (px >= pos.takeProfit) this.closePosition(pos, pos.takeProfit, 'TP', now);
        else if (px <= pos.stopLoss) this.closePosition(pos, pos.stopLoss, 'SL', now);
      } else {
        if (px <= pos.takeProfit) this.closePosition(pos, pos.takeProfit, 'TP', now);
        else if (px >= pos.stopLoss) this.closePosition(pos, pos.stopLoss, 'SL', now);
      }
    }

    // 3) Open positions when a strong NEW signal appears.
    for (const sig of signals) {
      if (!sig || sig.action === 'HOLD' || sig.action === 'NEUTRAL' || sig.confidence < MIN_CONFIDENCE) continue;
      if (this.positions.some(p => p.symbol === sig.symbol)) continue;
      // Behavioural protection: after 2 straight losses, take a 30-min pause.
      if (now < this.cooldownUntil) continue;
      const prev = this.lastSignalState[sig.symbol];
      if (prev && sig.action === prev.action && sig.confidence <= prev.confidence) continue;
      this.lastSignalState[sig.symbol] = { action: sig.action, confidence: sig.confidence, at: now };
      this.openPosition(sig, now);
    }
  }

  // Manual paper trade (one-click from the signal panel) — no confidence gate.
  openManual(sig, now) {
    if (!sig || !sig.symbol || !sig.entry) return false;
    if (this.positions.some(p => p.symbol === sig.symbol)) return false;
    this.openPosition(sig, now);
    return true;
  }

  openPosition(sig, now) {
    if (this.positions.length >= MAX_POSITIONS) return;
    const pos = {
      id: makeId(),
      symbol: sig.symbol,
      side: sig.action,
      entry: sig.entry,
      takeProfit: sig.takeProfit,
      stopLoss: sig.stopLoss,
      qty: NOTIONAL / sig.entry,
      openedAt: now,
      confidence: sig.confidence,
      rr: sig.riskReward,
    };
    this.positions.push(pos);
    this.broadcast('paper', { type: 'open', symbol: sig.symbol, side: sig.action, entry: sig.entry });
    this.store.save();
  }

  closePosition(pos, exitPrice, reason, now) {
    const idx = this.positions.findIndex(p => p.id === pos.id);
    if (idx === -1) return;
    const [removed] = this.positions.splice(idx, 1);
    const exit = exitPrice || removed.entry;
    const fee = removed.qty * exit * 0.001 * 2; // 0.2% round-trip
    const grossPnl = removed.side === 'BUY'
      ? (exit - removed.entry) * removed.qty
      : (removed.entry - exit) * removed.qty;
    const netPnl = grossPnl - fee;
    this.history.push({
      id: removed.id,
      symbol: removed.symbol,
      side: removed.side,
      entry: removed.entry,
      exit: round2(exit),
      qty: round6(removed.qty),
      pnl: round2(netPnl),
      pnlPct: round2((netPnl / (removed.entry * removed.qty)) * 100),
      reason,
      rr: removed.rr,
      openedAt: removed.openedAt,
      closedAt: now,
    });
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    this.broadcast('paper', { type: 'close', symbol: pos.symbol, reason, pnl: round2(netPnl) });
    // Behavioural protection: two straight losses → 30-minute cool-down.
    if (netPnl <= 0 && this.lossStreak() >= COOLDOWN_LOSSES) {
      this.cooldownUntil = now + COOLDOWN_MS;
      this.broadcast('protection', { type: 'cooldown', streak: this.lossStreak(), until: this.cooldownUntil });
    }
    this.store.save(true);
  }

  stats(prices) {
    const closed = this.history;
    const now = Date.now();
    const wins = closed.filter(h => h.pnl > 0).length;
    const losses = closed.filter(h => h.pnl <= 0).length;
    const realizedPnl = closed.reduce((s, h) => s + h.pnl, 0);
    const floatingPnl = this.positions.reduce((s, p) => {
      const px = prices[p.symbol];
      if (!px) return s;
      const gross = p.side === 'BUY' ? (px - p.entry) * p.qty : (p.entry - px) * p.qty;
      return s + gross;
    }, 0);
    const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 1000) / 10 : 0;
    return {
      openPositions: this.positions.length,
      closedTrades: closed.length,
      wins,
      losses,
      winRate,
      realizedPnl: round2(realizedPnl),
      floatingPnl: round2(floatingPnl),
      totalPnl: round2(realizedPnl + floatingPnl),
      direction: realizedPnl + floatingPnl >= 0 ? 'positive' : 'negative',
      lastTrade: closed.length ? closed[closed.length - 1] : null,
      protection: {
        active: now < this.cooldownUntil,
        until: this.cooldownUntil,
        streak: this.lossStreak(),
        leftMs: Math.max(0, this.cooldownUntil - now),
      },
    };
  }
}

function round2(v) { return Math.round(v * 100) / 100; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }

module.exports = PaperEngine;