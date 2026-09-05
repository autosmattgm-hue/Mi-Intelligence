'use strict';

// Minimal zero-dependency HTTP toolkit.
// Provides: route registration (get/post/delete), JSON body parsing, static
// file serving, URL parsing with query params and simple path params.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function createServer(requestHandler) {
  return http.createServer(requestHandler);
}

// Simple router. Routes are checked in registration order. Each route pattern
// is split on '/'; segments starting with ':' become params.
class Router {
  constructor() {
    this.routes = [];
  }

  _register(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean).map(p => (p.startsWith(':') ? { param: p.slice(1) } : { literal: p }));
    this.routes.push({ method, parts, handler });
  }

  get(pattern, handler) { this._register('GET', pattern, handler); return this; }
  post(pattern, handler) { this._register('POST', pattern, handler); return this; }
  delete(pattern, handler) { this._register('DELETE', pattern, handler); return this; }
  any(pattern, handler) { this._register('*', pattern, handler); return this; }

  match(req) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const segs = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== req.method && route.method !== '*') continue;
      if (route.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const rp = route.parts[i];
        if (rp.param) params[rp.param] = decodeURIComponent(segs[i]);
        else if (rp.literal !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params, query: Object.fromEntries(url.searchParams) };
    }
    return null;
  }
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, publicDir) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  const abs = path.normalize(path.join(publicDir, filePath));
  if (!abs.startsWith(publicDir)) return false;
  fs.readFile(abs, (err, data) => {
    if (err) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  return true;
}

// Attach helpers to a response object like express.res.
function decorateRes(res) {
  if (res.__decorated) return res;
  res.sendJson = (status, obj) => sendJson(res, status, obj);
  return res;
}
module.exports = { createServer, Router, readJsonBody, sendJson, serveStatic, decorateRes };