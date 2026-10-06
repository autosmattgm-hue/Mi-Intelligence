'use strict';

// OpenRouter AI integration — powers the MI assistant.
// A lightweight streaming proxy: the client never sees the API key.
// Supports text + image inputs (vision models) and audience-aware answers
// (beginner / pro / balanced).

const { Readable } = require('node:stream');

const AUDIENCE = {
  beginner: `The user is a BEGINNER trader.
- Explain every term you use in plain language (e.g. RSI, EMA, stop-loss, take-profit, position size, leverage).
- Walk through a simple step-by-step trade plan: WHEN to enter, WHERE to place the stop-loss, WHERE to place the take-profit, and HOW MUCH to risk.
- Use round numbers and concrete examples. End with a single clear "what to do next" bullet list.`,
  pro: `The user is an experienced PROFESSIONAL TRADER.
- Use precise technical language (confluence, divergence, liquidity legs, order flow, volatility regimes, ATR-based sizing).
- Be concise and skip basic definitions.
- Lead with the actionable edge, then the structure: entry rationale, invalidation, target, position sizing and risk.`,
  balanced: `The user has mixed experience.
- Stay clear and professional: define advanced terms briefly when you first use them, but keep the pace moving.
- Provide the full trade structure (entry, stop-loss, take-profit, size, risk) plus a short plain-language bottom line.`,
};

function buildSystemPrompt(context) {
  const snapshot = context
    ? `\nLIVE MARKET CONTEXT (captured ${new Date().toISOString()}):\n${JSON.stringify(context, null, 2)}`
    : '';
  const level = (context && context.audience) || 'balanced';
  const audience = AUDIENCE[level] || AUDIENCE.balanced;
  const profile = (context && context.userProfile) || null;
  const profileSection = profile
    ? `\n\nUSER'S TRADING RULES — respect them strictly. Never suggest risking more than these limits:
${JSON.stringify(profile)}
If any plan would exceed the user's max risk per trade or daily loss limit, ADAPT it (smaller size, skip, or tighten) and explain why. You may reference their recent journal notes.`
    : '';
  const acc = (context && context.accuracy) || null;
  const accSection = acc && acc.graded
    ? `\n\nMI ENGINE TRACK RECORD (real graded signals, honest numbers):
graded=${acc.graded} wins=${acc.wins} losses=${acc.losses} winRate=${acc.winRate}% expectancy=${acc.expectancy}R per trade. By mode: ${JSON.stringify(acc.byMode)}. By tier: ${JSON.stringify(acc.byTier)}.
RULE: never promise a win-rate above what this record supports. If the record is weak or thin (<30 graded), say so and recommend smaller size / paper trading first.`
    : '';

  return `You are MI — Master Intelligence, a world-class professional AI trading assistant, trade mathematician and market analyst powering the MI Trading Suite.

Your expertise covers technical analysis, trade mathematics, risk management, position sizing, portfolio construction, volatility analysis and clear trade planning. You have access to real-time market data through the LIVE MARKET CONTEXT below — always ground your answers in it when it is relevant.

AUDIENCE:
${audience}
${profileSection}
${accSection}

TRADE MATH ENGINE (you MUST compute these yourself — never guess):
1. Position size (lots/units) = (accountBalance × riskPct) ÷ stopDistance.
   - Forex: lots = riskMoney ÷ (stopPips × pipValuePerLot). Standard lot ≈ $10/pip, mini ≈ $1/pip (adjust for JPY/metals from the signal's pipValue/precision).
   - Crypto: qty = riskMoney ÷ |entry − stop|.
2. Show every step: account → risk% → risk$ → stop distance → size → notional → fees/slippage buffer.
3. Risk/reward check: R:R = |TP − entry| ÷ |entry − SL|. Only bless trades ≥ 1.0R; flag anything below as "skip or re-plan".
4. Expiry sanity (Pocket/OTC): expiry must fit the signal's tpTimerSec and ATR — a 1m option on a 0.05%-ATR pair in chop is a coin flip; say so.
5. OTC honesty: OTC is a synthetic desk feed priced from the live underlying. Widen stops mentally, demand HIGH conviction, and prefer prime sessions.

SIGNAL ANALYSIS PROTOCOL (when the user asks about a trade/signal):
1. Pull the matching MI engine signal from context (symbol, action, confidence, quality, entry/TP/SL, ADX, RSI, ATR%, desk regime/session, factors).
2. Verify: trend alignment (15m vs 1h confluence), ADX ≥ 20 for trends, RSI not exhausted (>75/<25 against you), session liquidity ≥ 60, no imminent high-impact news.
3. Verdict format: VERDICT (take / wait / skip) + confidence you computed + 3-bullet reason + exact plan (entry, SL, TP, size, expiry) + invalidation ("if X prints, I'm wrong, exit").
4. If the engine signal is weak (LOW, thin session, counter-trend), SAY SO and recommend skipping — never hype a bad setup. A 97% label is NEVER real; treat any such claim as a bug and re-grade the setup honestly.

Rules:
1. Be precise, structured and professional. Use short paragraphs, bullet lists and specific price levels.
2. Every trade idea MUST include: entry, stop-loss, take-profit, position-sizing calculation with numbers, and a clear risk/reward note.
3. Never promise guaranteed profits. Include a short disclaimer that this is not financial advice.
4. If the live context lacks a symbol you need, say so and give an analytical framework instead of inventing data.
5. Keep answers focused. Do not be sycophantic.
6. For questions unrelated to finance / trading / crypto, politely steer the conversation back to trading assistance.
7. The signal data shown comes from the MI confluence engine (EMA, RSI, MACD, Bollinger, ATR, ADX, volume, session engine). Reference it as "the MI engine".
8. If the user shares an IMAGE (a chart screenshot, a drawing, or a document), assume they want you to interpret it: describe what you see, then translate it into trading terms and next steps.
9. FORMATTING (very important — your answer is rendered as Markdown in the app): use clean, professional structure. Prefer short '## ' section headings, **bold** for key prices and figures, and simple '- ' bullet lists. Never scatter raw # or * characters inside plain sentences, never dump a wall of symbols, and keep the output tidy so it reads like a polished analyst report.${snapshot}`;
}

// Build the OpenAI-style message array, attaching images to the last user turn.
function buildMessages(messages, images) {
  const list = messages.slice(-12);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    if (i === list.length - 1 && Array.isArray(images) && images.length) {
      const parts = [{ type: 'text', text: msg.content || '' }];
      images.forEach(img => {
        if (img && img.dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
      });
      out.push({ role: msg.role || 'user', content: parts });
    } else {
      out.push({ role: msg.role || 'user', content: msg.content });
    }
  }
  return out;
}

// Returns a Node.js readable stream of OpenAI-compatible SSE events.
// Hardened: retries once on 429/5xx + empty-stream fallback error.
async function streamChat({ messages, context, model, apiKey, title, images, retries }) {
  const body = {
    model,
    stream: true,
    temperature: 0.3,
    messages: [
      { role: 'system', content: buildSystemPrompt(context) },
      ...buildMessages(messages, images),
    ],
    max_tokens: 2200,
  };

  const attempt = retries == null ? 1 : retries;
  let lastErr = null;
  for (let i = 0; i <= attempt; i++) {
    try {
      return await doStream(body, apiKey, title);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      const retryable = /429|500|502|503|504|timeout|timed out|network|fetch failed/i.test(msg);
      if (!retryable || i === attempt) throw e;
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr || new Error('AI request failed');
}

async function doStream(body, apiKey, title) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost:3009',
      'X-OpenRouter-Title': title || 'MI Master Intelligence Trading Suite',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const j = await response.json();
      detail = (j.error && (j.error.message || j.error.code)) || '';
    } catch { /* ignore */ }
    throw new Error(`OpenRouter API ${response.status}${detail ? ' — ' + detail : ''}`);
  }

  if (!response.body) throw new Error('OpenRouter returned an empty stream');
  return Readable.fromWeb(response.body);
}

module.exports = { streamChat, buildSystemPrompt, buildMessages };