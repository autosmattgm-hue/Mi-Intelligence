'use strict';

// Minimal .env loader (no external dependency).
// Reads KEY=VALUE lines from the .env file in the project root and applies
// them to process.env (only for keys not already set).
const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
  let abs = filePath || path.join(__dirname, '..', '.env');
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return; // no .env file — rely on real environment variables
  }
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

module.exports = { loadEnv };