'use strict';

// OpenRouter AI integration — powers the MI assistant.
// A lightweight streaming proxy: the client never sees the API key.

const { Readable } = require('node:stream');

function buildSystemPrompt(context) {
  const snapshot = context
    ? `\nLIVE MARKET CONTEXT (captured ${new Date().toISOString()}):\n${JSON.stringify(context, null, 2)}`
    : '';
  return `You are MI — Master Intelligence, a world-class professional AI trading assistant and market analyst powering the MI Trading Suite.

Your expertise covers technical analysis, risk management, position sizing, portfolio construction, volatility analysis and clear trade planning. You have access to real-time market data through the LIVE MARKET CONTEXT below — always ground your answers in it when it is relevant.

Rules:
1. Be precise, structured and professional. Use short paragraphs, bullet lists and specific price levels.
2. Every trade idea MUST include: entry, stop-loss, take-profit, position-sizing guidance and a clear risk/reward note.
3. Never promise guaranteed profits. Include a short disclaimer that this is not financial advice.
4. If the live context lacks a symbol you need, say so and give an analytical framework instead of inventing data.
5. Keep answers focused. Do not be sycophantic.
6. For questions unrelated to finance / trading / crypto, politely steer the conversation back to trading assistance.
7. The signal data shown comes from the MI confluence engine (EMA, RSI, MACD, Bollinger, ATR, volume). Reference it as "the MI engine".${snapshot}`;
}

// Returns a Node.js readable stream of OpenAI-compatible SSE events.
async function streamChat({ messages, context, model, apiKey, title }) {
  const body = {
    model,
    stream: true,
    temperature: 0.4,
    messages: [
      { role: 'system', content: buildSystemPrompt(context) },
      ...messages.slice(-12),
    ],
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
    signal: AbortSignal.timeout(90000),
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

module.exports = { streamChat };