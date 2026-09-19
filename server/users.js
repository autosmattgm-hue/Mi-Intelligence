'use strict';

// MI User Accounts + Coin Ledger
// -----------------------------------------------------------------------------
// - Owner login stays the single password gate (/api/login).
// - Users register/sign-in here; each new user gets FREE_COINS coins.
// - 1 coin = 1 signal analysis reveal OR 1 AI question (COIN_PER_ITEM).
// - When coins run out the client shows the upgrade/pay screen and the server
//   returns HTTP 402 { code:'insufficient_coins' } on spend attempts.
// - Passwords are hashed with scrypt (node:crypto) — never stored in plain text.
// - Users persist to data/users.json when the filesystem is writable (local);
//   on serverless the store falls back to in-memory (consistent with the rest
//   of the app's per-instance state).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'users.json');

const FREE_COINS = 5;            // free coins granted on registration
const COIN_PER_ITEM = 1;         // cost of 1 signal or 1 AI question
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30-day session

const PLANS = {
  basic: { id: 'basic', name: 'Starter', coins: 50, price: 19 },
  pro: { id: 'pro', name: 'Trader Pro', coins: 200, price: 49 },
  elite: { id: 'elite', name: 'Elite Desk', coins: 500, price: 99 },
};

let users = [];
let loaded = false;

function ensureDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* read-only fs */ }
}

function load() {
  if (loaded) return;
  loaded = true;
  ensureDir();
  try {
    if (fs.existsSync(FILE)) users = JSON.parse(fs.readFileSync(FILE, 'utf8')) || [];
  } catch { users = []; }
}

function save() {
  loaded = true;
  ensureDir();
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, FILE);
  } catch { /* serverless read-only — keep in memory */ }
}

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function err(message, status, code) {
  const e = new Error(message);
  e.status = status || 400;
  if (code) e.code = code;
  return e;
}

function findByToken(token) {
  if (!token) return null;
  return users.find(u => u.token && u.token === token && (!u.expiresAt || u.expiresAt > Date.now())) || null;
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email,
    coins: u.coins, spent: u.spent || 0,
    createdAt: u.createdAt, orders: (u.orders || []).length,
  };
}

// ------------------------------------------------------------- auth
function register(body) {
  load();
  const email = String((body && body.email) || '').trim().toLowerCase();
  const name = String((body && body.name) || '').trim() || email.split('@')[0] || 'Trader';
  const password = String((body && body.password) || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err('Enter a valid email address.');
  if (password.length < 6) throw err('Password must be at least 6 characters.');
  if (users.some(u => u.email === email)) throw err('That email is already registered — sign in instead.', 409);
  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    id: crypto.randomBytes(8).toString('hex'),
    name, email, salt, hash: hash(password, salt),
    token: crypto.randomBytes(24).toString('hex'),
    createdAt: Date.now(), expiresAt: Date.now() + SESSION_MS,
    coins: FREE_COINS, spent: 0, orders: [], ledger: [],
  };
  users.push(u);
  save();
  return { token: u.token, user: publicUser(u), freeCoins: FREE_COINS };
}
function login(body) {
  load();
  const email = String((body && body.email) || '').trim().toLowerCase();
  const u = users.find(x => x.email === email);
  if (!u || u.hash !== hash(String((body && body.password) || ''), u.salt)) throw err('Incorrect email or password.', 401);
  u.token = crypto.randomBytes(24).toString('hex');
  u.expiresAt = Date.now() + SESSION_MS;
  save();
  return { token: u.token, user: publicUser(u) };
}

function logout(token) {
  load();
  const i = users.findIndex(u => u.token === token);
  if (i >= 0) { users[i].token = null; save(); }
  return { ok: true };
}

function me(token) {
  load();
  const u = findByToken(token);
  if (!u) throw err('Session expired — sign in again.', 401);
  return publicUser(u);
}

// ------------------------------------------------------------- coins
function spend(token, item) {
  load();
  const u = findByToken(token);
  if (!u) throw err('Session expired — sign in again.', 401);
  item = String(item || 'signal');
  if (u.coins < COIN_PER_ITEM) throw err('Not enough coins — upgrade to keep trading.', 402, 'insufficient_coins');
  u.coins -= COIN_PER_ITEM;
  u.spent = (u.spent || 0) + COIN_PER_ITEM;
  u.ledger = u.ledger || [];
  u.ledger.push({ ts: Date.now(), item, cost: -COIN_PER_ITEM });
  save();
  return { ok: true, coins: u.coins, item, cost: COIN_PER_ITEM, user: publicUser(u) };
}

function refund(token, item) {
  load();
  const u = findByToken(token);
  if (!u) return { ok: false, coins: 0 };
  u.coins += COIN_PER_ITEM;
  u.ledger = u.ledger || [];
  u.ledger.push({ ts: Date.now(), item: String(item || 'signal') + '_refund', cost: COIN_PER_ITEM });
  save();
  return { ok: true, coins: u.coins };
}

function wallet(token) {
  const u = me(token);
  return { coins: u.coins, spent: u.spent, user: u };
}

function buy(token, planId) {
  load();
  const u = findByToken(token);
  if (!u) throw err('Session expired — sign in again.', 401);
  const plan = PLANS[String(planId || '').toLowerCase()];
  if (!plan) throw err('Choose a valid plan.');
  u.coins += plan.coins;
  u.orders = u.orders || [];
  const order = {
    ref: 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1e3),
    plan: plan.id, planName: plan.name, coins: plan.coins, price: plan.price,
    ts: Date.now(), paid: true, // NOTE: payment gateway (Stripe/PayPal) goes here when keys are configured
  };
  u.orders.push(order);
  save();
  return { ok: true, coins: u.coins, before: u.coins - plan.coins, order };
}

module.exports = {
  register, login, logout, me, spend, refund, wallet, buy,
  PLANS, FREE_COINS, COIN_PER_ITEM,
};
