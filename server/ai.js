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

  return `You are MI — Master Intelligence, a world-class professional AI trading assistant and market analyst powering the MI Trading Suite.

Your expertise covers technical analysis, risk management, position sizing, portfolio construction, volatility analysis and clear trade planning. You have access to real-time market data through the LIVE MARKET CONTEXT below — always ground your answers in it when it is relevant.

AUDIENCE:
${audience}
${profileSection}

Rules:
1. Be precise, structured and professional. Use short paragraphs, bullet lists and specific price levels.
2. Every trade idea MUST include: entry, stop-loss, take-profit, position-sizing guidance and a clear risk/reward note.
3. Never promise guaranteed profits. Include a short disclaimer that this is not financial advice.
4. If the live context lacks a symbol you need, say so and give an analytical framework instead of inventing data.
5. Keep answers focused. Do not be sycophantic.
6. For questions unrelated to finance / trading / crypto, politely steer the conversation back to trading assistance.
7. The signal data shown comes from the MI confluence engine (EMA, RSI, MACD, Bollinger, ATR, volume). Reference it as "the MI engine".
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
async function streamChat({ messages, context, model, apiKey, title, images }) {
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