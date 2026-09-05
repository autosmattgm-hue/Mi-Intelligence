'use strict';

// MI Alert & Notification Engine.
// - User price alerts (above / below a target) checked against live prices.
// - Automatic notifications for fresh high-confidence signals.
// - Notification history persisted and streamed to the UI over SSE.
// Notifications are delivered inside the app (its own permission system) —
// no reliance on the browser Notification API.

const crypto = require('crypto');

function fmtPrice(p) {
  if (p === null || p === undefined || isNaN(p)) return '—';
  return p >= 1000 ? '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : p >= 1 ? '$' + p.toFixed(2)
    : '$' + p.toFixed(4);
}

class Alerts {
  constructor(store, broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.notifiedSignalKeys = new Set(); // remembers signal notifications to debounce
  }

  list() {
    return this.store.data.alerts.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  add({ symbol, condition, target, note }) {
    const targetNum = Number(target);
    if (!symbol || !condition || isNaN(targetNum) || targetNum <= 0) {
      throw new Error('Invalid alert parameters');
    }
    const alert = {
      id: crypto.randomBytes(6).toString('hex'),
      symbol: String(symbol).toUpperCase(),
      condition: condition === 'below' ? 'below' : 'above',
      target: targetNum,
      note: note || '',
      source: 'manual',
      triggerPrice: null,
      triggered: false,
      createdAt: Date.now(),
      triggeredAt: null,
    };
    this.store.data.alerts.push(alert);
    this.store.save(true);
    return alert;
  }

  remove(id) {
    const idx = this.store.data.alerts.findIndex(a => a.id === id);
    if (idx === -1) return false;
    this.store.data.alerts.splice(idx, 1);
    this.store.save(true);
    return true;
  }

  notifications() {
    return this.store.data.notifications.slice().sort((a, b) => b.ts - a.ts);
  }

  markAllRead() {
    for (const n of this.store.data.notifications) n.read = true;
    this.store.save();
  }

  clearAll() {
    this.store.data.notifications = [];
    this.store.save(true);
  }

  addNotification(type, title, body, meta) {
    const n = {
      id: crypto.randomBytes(6).toString('hex'),
      type,
      title,
      body,
      meta: meta || null,
      ts: Date.now(),
      read: false,
    };
    this.store.data.notifications.push(n);
    if (this.store.data.notifications.length > 200) {
      this.store.data.notifications.splice(0, this.store.data.notifications.length - 200);
    }
    this.broadcast('notification', n);
    this.store.save();
  }

  // Called periodically with the latest price map and signal analyses.
  check(prices, signals) {
    // 1) Price alerts
    for (const alert of this.store.data.alerts) {
      if (alert.triggered) continue;
      const px = prices[alert.symbol];
      if (px === undefined) continue;
      const hit = alert.condition === 'above' ? px >= alert.target : px <= alert.target;
      if (hit) {
        alert.triggered = true;
        alert.triggerPrice = px;
        alert.triggeredAt = Date.now();
        this.addNotification(
          'alert',
          `${alert.symbol} ${alert.condition === 'above' ? 'jumped to' : 'dropped to'} ${fmtPrice(px)}`,
          `Your price alert (${alert.condition} ${fmtPrice(alert.target)}) was triggered.${alert.note ? ' — ' + alert.note : ''}`,
          { symbol: alert.symbol, price: px, id: alert.id }
        );
        this.broadcast('alert', { id: alert.id, symbol: alert.symbol, price: px, condition: alert.condition, target: alert.target });
      }
    }
    if (this.store.data.alerts.some(a => a.triggered)) this.store.save(true);

    // 2) High-confidence signal alerts (debounced per signal key)
    if (Array.isArray(signals)) {
      for (const sig of signals) {
        if (!sig || sig.action === 'HOLD' || sig.confidence < 85) continue;
        const key = sig.symbol + '|' + sig.action;
        if (!this.notifiedSignalKeys.has(key)) {
          this.notifiedSignalKeys.add(key);
          const sideWord = sig.action === 'BUY' ? 'Buy' : 'Sell';
          this.addNotification(
            'signal',
            `New ${sig.action} signal — ${sig.asset} (${sig.confidence}%)`,
            `${sideWord} entry near ${fmtPrice(sig.entry)}, TP ${fmtPrice(sig.takeProfit)}, SL ${fmtPrice(sig.stopLoss)}, R/R ${sig.riskReward}`,
            { symbol: sig.symbol, action: sig.action, confidence: sig.confidence }
          );
        }
      }
      // keep set bounded
      if (this.notifiedSignalKeys.size > 60) {
        this.notifiedSignalKeys = new Set([...this.notifiedSignalKeys].slice(-40));
      }
    }
  }
}

module.exports = Alerts;