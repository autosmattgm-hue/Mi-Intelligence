'use strict';
// MI Market Sentiment — Fear & Greed index (alternative.me) and BTC perpetual
// funding rate (Binance futures). Both are real, free and keyless.

let cache = { data: null, ts: 0 };

async function getSentiment() {
  if (cache.data && Date.now() - cache.ts < 120000) return cache.data;
  const out = { fearGreed: null, funding: null, source: 'alternative.me + Binance USDⓈ-M futures', ts: Date.now() };
  try {
    const j = await (await fetch('https://api.alternative.me/fng/?limit=1&format=json')).json();
    const d = j && j.data && j.data[0];
    if (d && d.value != null) {
      out.fearGreed = { value: Number(d.value), classification: String(d.classification || d.value_classification || ''), updated: d.timestamp ? Number(d.timestamp) * 1000 : null };
    }
  } catch { /* optional */ }
  try {
    const f = await (await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })).json();
    if (f && f.lastFundingRate != null) out.funding = Number(f.lastFundingRate);
  } catch { /* optional */ }
  cache = { data: out, ts: Date.now() };
  return out;
}

module.exports = { getSentiment };