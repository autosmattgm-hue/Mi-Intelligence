'use strict';
// MI Web Push engine — zero-dependency (uses only Node crypto).
// Implements VAPID (RFC 8292) + message encryption (RFC 8291 aes128gcm) so the
// app can send REAL push notifications to the user's device/browser even when
// the app is closed. Works on localhost AND Vercel (env-overridable keys) and
// persists a generated keypair to data/vapid.json locally.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const CONTACT = process.env.MI_CONTACT_EMAIL || 'mi@localhost';
const TTL = 86400;

function ensureDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* read-only fs (serverless) is fine */ } }

let vapid = null;
function getVapidKeys() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKeyPem: process.env.VAPID_PRIVATE_KEY, contact: 'mailto:' + CONTACT };
    return vapid;
  }
  ensureDir();
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (parsed.publicKey && parsed.privateKeyPem) { vapid = parsed; return vapid; }
    }
  } catch { /* fall through to generate */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pubRaw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  vapid = {
    publicKey: pubRaw.toString('base64url'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    contact: 'mailto:' + CONTACT,
    createdAt: Date.now(),
  };
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2)); } catch { /* fine */ }
  return vapid;
}

function getPublicKey() { return getVapidKeys().publicKey; }

// Convert a DER ECDSA signature to the raw r||s form expected by Web Crypto.
function derToRawSig(der) {
  if (!der || der[0] !== 0x30) throw new Error('bad signature');
  let pos = 2;
  const readInt = () => {
    if (der[pos] !== 0x02) throw new Error('bad signature int');
    const len = der[pos + 1];
    let v = der.subarray(pos + 2, pos + 2 + len);
    pos += 2 + len;
    if (v[0] === 0) v = v.subarray(1);
    if (v.length <= 32) return Buffer.concat([Buffer.alloc(32 - v.length), v]);
    return v.subarray(v.length - 32);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

// Build the VAPID ES256 JWT for a given audience (push endpoint origin).
function buildVapidJwt(aud) {
  const keys = getVapidKeys();
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ aud, exp: now + 12 * 60 * 60, sub: keys.contact })).toString('base64url');
  const signingInput = header + '.' + payload;
  const sig = derToRawSig(crypto.sign('sha256', Buffer.from(signingInput), crypto.createPrivateKey(keys.privateKeyPem)));
  return signingInput + '.' + sig.toString('base64url');
}

// Encrypt a payload for a PushSubscription (RFC 8291 aes128gcm single record).
function encryptPayload(message, sub) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');              // 65 bytes
  const uaAuth = Buffer.from(sub.keys.auth, 'base64url');                  // 16 bytes
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();                                    // 65 bytes
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4: subject key
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = crypto.hkdfSync('sha256', ecdhSecret, uaAuth, authInfo, 32);

  // RFC 8188 aes128gcm record
  const salt = crypto.randomBytes(16);
  const rs = 4096;
  const keyid = asPublic;
  const header = Buffer.concat([
    salt,
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(rs, 0); return b; })(),
    Buffer.from([keyid.length]),
    keyid,
  ]);

  const prk = crypto.hkdfSync('sha256', ikm, salt, Buffer.alloc(0), 32);
  const cek = crypto.hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', prk, Buffer.alloc(0), Buffer.from('Content-Encoding: nonce\0'), 12);

  const plaintext = Buffer.concat([Buffer.from([2]), Buffer.from(message, 'utf8')]); // 0x02 final-record delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  cipher.setAAD(header);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, enc, cipher.getAuthTag()]);
}

// Deliver a push message to a single subscription endpoint.
async function sendPush(sub, message) {
  const endpoint = sub && sub.endpoint;
  if (!endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('invalid subscription');
  const aud = new URL(endpoint).origin;
  const jwt = buildVapidJwt(aud);
  const body = encryptPayload(JSON.stringify(message || {}), sub);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'vapid t=' + jwt + ', k=' + getPublicKey(),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(TTL),
        'Urgency': 'high',
      },
      body,
    });
  } catch (e) {
    throw new Error('push network: ' + e.message);
  }
  if (res.status === 404 || res.status === 410) throw new Error('GONE:' + endpoint); // subscription no longer valid
  if (!res.ok && res.status !== 201 && res.status !== 202 && res.status !== 200) {
    const txt = await res.text().catch(() => '');
    throw new Error('push ' + res.status + ' ' + txt.slice(0, 140));
  }
  return res.status;
}

// Send a message to every stored subscription; returns dead endpoints.
async function notifyAll(subscriptions, message) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  let delivered = 0;
  const dead = [];
  await Promise.all(subs.map(async (sub) => {
    try { await sendPush(sub, message); delivered += 1; }
    catch (e) { if (String(e.message || '').indexOf('GONE') === 0) dead.push(sub.endpoint); }
  }));
  return { delivered, dead };
}

module.exports = { getVapidKeys, getPublicKey, buildVapidJwt, encryptPayload, sendPush, notifyAll };