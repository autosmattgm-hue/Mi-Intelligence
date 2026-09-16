'use strict';
// MI Economic Calendar — real upcoming high-impact events from the keyless
// ForexFactory feed (nfs.faireconomy.media/ff_calendar_thisweek.json).
// Used for AI context and for "high-impact news ahead" safety notifications.

let cache = { data: null, ts: 0 };

async function getCalendar() {
  if (cache.data && Date.now() - cache.ts < 10 * 60 * 1000) return cache.data;
  const out = { source: 'ForexFactory', events: [], high: [], upcoming: [], imminentHigh: [], ts: Date.now() };
  try {
    const arr = await (await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')).json();
    if (Array.isArray(arr)) {
      const now = Date.now();
      const evts = arr
        .filter(e => e && e.title)
        .map(e => {
          const t = e.date ? +new Date(e.date) : null;
          const impact = String(e.impact || 'low').toLowerCase();
          return {
            title: String(e.title || ''),
            country: String(e.country || '').toUpperCase(),
            impact,
            isHigh: impact === 'high',
            forecast: e.forecast != null ? e.forecast : null,
            previous: e.previous != null ? e.previous : null,
            actual: e.actual != null ? e.actual : null,
            time: t,
          };
        })
        .filter(e => e.time && e.time >= now - 8 * 3600 * 1000)
        .sort((a, b) => (a.time || 0) - (b.time || 0));
      out.events = evts.slice(0, 40);
      out.upcoming = evts.filter(e => e.time >= now).slice(0, 14);
      out.high = evts.filter(e => e.isHigh).slice(0, 24);
      out.imminentHigh = evts.filter(e => e.time >= now && e.time <= now + 12 * 3600 * 1000 && e.isHigh).slice(0, 6);
    }
  } catch { /* fallback: no events */ }
  cache = { data: out, ts: Date.now() };
  return out;
}

module.exports = { getCalendar };