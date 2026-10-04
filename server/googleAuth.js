'use strict';

// MI Google Sign-In verifier — zero dependencies (Node crypto only).
// Verifies Google ID tokens (RS256) against Google's public certs:
//   https://www.googleapis.com/oauth2/v3/certs
// Checks: signature, iss, aud (our GOOGLE_CLIENT_ID), exp.

const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

let cache = { keys: null, ts: 0 };
const CACHE_MS = 60 * 60 * 1000;

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

async function getKeys() {
  if (cache.keys && Date.now() - cache.ts < CACHE_MS) return cache.keys;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Google certs HTTP ' + res.status);
  const j = await res.json();
  if (!j || !Array.isArray(j.keys) || !j.keys.length) throw new Error('No Google certs');
  cache = { keys: j.keys, ts: Date.now() };
  return cache.keys;
}

async function verifyIdToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) {
    const e = new Error('Google sign-in is not configured on this server (GOOGLE_CLIENT_ID missing).');
    e.status = 501; e.code = 'google_not_configured';
    throw e;
  }
  if (!idToken || String(idToken).split('.').length !== 3) {
    const e = new Error('Invalid Google credential.');
    e.status = 401; throw e;
  }
  const [hB64, pB64, sB64] = String(idToken).split('.');
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(hB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(pB64).toString('utf8'));
  } catch {
    const e = new Error('Invalid Google credential.');
    e.status = 401; throw e;
  }
  if (header.alg !== 'RS256' || !header.kid) {
    const e = new Error('Unsupported Google credential.');
    e.status = 401; throw e;
  }
  const keys = await getKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    cache = { keys: null, ts: 0 }; // force refresh next time (key rotation)
    const e = new Error('Google key not found — try again.');
    e.status = 401; throw e;
  }
  let keyObj;
  try { keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' }); }
  catch { const e = new Error('Could not verify Google credential.'); e.status = 401; throw e; }
  const signingInput = hB64 + '.' + pB64;
  const sig = b64urlDecode(sB64);
  let ok = false;
  try { ok = crypto.verify('sha256', Buffer.from(signingInput), keyObj, sig); } catch { ok = false; }
  if (!ok) { const e = new Error('Google signature invalid.'); e.status = 401; throw e; }

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.includes(payload.iss)) { const e = new Error('Google issuer invalid.'); e.status = 401; throw e; }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) { const e = new Error('Google credential was issued for a different app.'); e.status = 401; throw e; }
  if (!payload.exp || payload.exp < now - 30) { const e = new Error('Google credential expired — try again.'); e.status = 401; throw e; }
  if (!payload.email) { const e = new Error('Google account has no email.'); e.status = 401; throw e; }

  return {
    googleId: payload.sub,
    email: String(payload.email).toLowerCase(),
    emailVerified: payload.email_verified !== false,
    name: payload.name || payload.given_name || String(payload.email).split('@')[0],
    avatar: payload.picture || null,
  };
}

module.exports = { verifyIdToken };
