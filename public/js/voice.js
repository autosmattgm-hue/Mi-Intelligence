/* ============ MI Voice — spoken guidance + alarm tones ============
   A tiny text-to-speech layer built on the Web Speech API (speechSynthesis)
   plus WebAudio alarm tones. It is used by the Trade Console to *speak*
   when to place a trade, when to exit, and to count down a take-profit alert.
   Has its own ON/OFF switch (stored in this browser) — independent from the
   notification sound toggle. */
(function () {
  'use strict';

  const LS = 'mi.voice';
  let enabled = localStorage.getItem(LS) !== 'off';
  let audioCtx = null;
  let voices = [];
  const listeners = [];

  function supported() {
    return typeof window.speechSynthesis !== 'undefined' &&
      typeof window.SpeechSynthesisUtterance !== 'undefined';
  }

  // Voices load asynchronously in most browsers — cache them when available.
  function loadVoices() {
    try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; }
  }
  if (supported()) {
    loadVoices();
    try { window.speechSynthesis.addEventListener('voiceschanged', loadVoices); } catch { /* older API */ }
  }

  function pickVoice() {
    if (!voices.length) loadVoices();
    if (!voices.length) return null;
    return voices.find(v => /en[-_]US/i.test(v.lang)) ||
      voices.find(v => /^en/i.test(v.lang)) || voices[0] || null;
  }

  // ------------------------------------------------ speech
  function say(text, opts) {
    if (!text) return;
    opts = opts || {};
    if (!enabled && !opts.force) return;
    if (!supported()) return;
    try {
      const synth = window.speechSynthesis;
      if (opts.interrupt) { try { synth.cancel(); } catch { /* ignore */ } }
      const u = new SpeechSynthesisUtterance(String(text));
      u.rate = opts.rate || 1.05;
      u.pitch = opts.pitch || 1;
      u.volume = opts.volume !== undefined ? opts.volume : 1;
      u.lang = 'en-US';
      const v = pickVoice();
      if (v) u.voice = v;
      synth.speak(u);
    } catch { /* voice optional */ }
  }

  function stop() { if (supported()) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } } }

  // ------------------------------------------------ alarm tones (WebAudio)
  function tone(seq) {
    if (!enabled) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      let at = audioCtx.currentTime;
      for (const s of seq) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = s.type || 'square';
        o.frequency.setValueAtTime(s.f, at);
        const dur = s.d || 0.16;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(s.v || 0.14, at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(at); o.stop(at + dur + 0.03);
        at += dur + (s.gap !== undefined ? s.gap : 0.06);
      }
    } catch { /* audio optional */ }
  }

  const PATTERNS = {
    alert:   [{ f: 880, d: .13 }, { f: 1180, d: .13 }, { f: 1480, d: .22, v: .16 }],
    warn:    [{ f: 520, d: .2, type: 'sawtooth' }, { f: 400, d: .28, type: 'sawtooth' }],
    danger:  [{ f: 320, d: .24 }, { f: 210, d: .24 }, { f: 320, d: .24 }, { f: 210, d: .3, v: .18 }],
    success: [{ f: 660, d: .12 }, { f: 880, d: .12 }, { f: 1320, d: .26, v: .16 }],
    tick:    [{ f: 1050, d: .05, v: .07, gap: 0 }],
  };
  function alarm(kind) { const p = PATTERNS[kind] || PATTERNS.alert; tone(p); }

  // ------------------------------------------------ on/off state
  function emit() { listeners.forEach(fn => { try { fn(enabled); } catch { /* ignore */ } }); }
  function setEnabled(on) {
    enabled = !!on;
    localStorage.setItem(LS, enabled ? 'on' : 'off');
    if (!enabled) stop();
    emit();
    return enabled;
  }
  function toggle() { return setEnabled(!enabled); }
  function onEvent(fn) { listeners.push(fn); }

  // One-line convenience: speak + optional tone together.
  function announce(text, toneKind, opts) {
    say(text, opts);
    if (toneKind) alarm(toneKind);
  }

  // ------------------------------------------------ top-bar button
  // The 🎙️ button in the top bar toggles voice guidance from anywhere.
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('voiceBtn');
    if (!b) return;
    const upd = () => {
      b.textContent = enabled ? '🎙️' : '🔇';
      b.title = enabled ? 'Voice guidance ON — click to mute' : 'Voice guidance OFF — click to enable';
      b.classList.toggle('on', enabled);
    };
    upd();
    listeners.push(upd);
    b.addEventListener('click', () => { toggle(); if (enabled) say('Voice guidance on.', { interrupt: true }); });
  });

  window.MIVoice = { say, stop, alarm, tone, toggle, setEnabled, onEvent, supported, announce, isEnabled: () => enabled };
  window.MI = window.MI || {};
  window.MI.voice = window.MIVoice;
  window.MI.say = say;
})();