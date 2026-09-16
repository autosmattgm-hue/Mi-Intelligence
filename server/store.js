'use strict';

// Tiny JSON persistence layer for alerts, notifications and paper-trading state.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    // Read-only filesystems (e.g. serverless) are fine — state stays in memory.
  }
}

class Store {
  constructor() {
    this.data = {
      alerts: [],
      notifications: [],
      pushSubscriptions: [],
      signalHistory: [],
      signalAccuracy: [],
      paperPositions: [],
      paperHistory: [],
      settings: {},
    };
    this._loaded = false;
    this._saveTimer = null;
  }

  load() {
    ensureDir();
    try {
      if (fs.existsSync(DB_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        this.data = Object.assign(this.data, parsed);
      }
    } catch (err) {
      console.error('[store] load error:', err.message);
    }
    this._loaded = true;
    return this;
  }

  save(immediate = false) {
    if (!this._loaded) return this;
    if (immediate) {
      clearTimeout(this._saveTimer);
      this._write();
      return this;
    }
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._write(), 300);
    return this;
  }

  _write() {
    ensureDir();
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[store] write error:', err.message);
    }
  }
}

module.exports = Store;