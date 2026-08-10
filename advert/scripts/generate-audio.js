#!/usr/bin/env node
/**
 * Generate procedural audio for the WhatExam advert.
 * Outputs WAV files into advert/public/audio/
 *
 * Sounds generated:
 *   bgm.wav         — 30s ambient pad + rhythmic pulse
 *   whoosh.wav      — transition whoosh (0.6s)
 *   tick.wav        — WhatsApp typing tick (0.15s)
 *   chime.wav       — success chime (0.8s)
 *   ding.wav        — notification ding (0.3s)
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'audio');
fs.mkdirSync(OUT, { recursive: true });

/* ── WAV writer ────────────────────────────────────────────── */
function writeWav(filePath, samples, sampleRate = 44100) {
  const numSamples = samples.length;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);

  const buf = Buffer.alloc(44 + dataSize);
  // RIFF header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  // fmt chunk
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  // data chunk
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const val = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(val * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
  console.log(`  ✓ ${path.basename(filePath)} (${(buf.length / 1024).toFixed(1)} KB)`);
}

/* ── Helpers ───────────────────────────────────────────────── */
const TAU = Math.PI * 2;
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function envAttackRelease(len, attack, hold, release) {
  const env = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    if (i < attack) env[i] = i / attack;
    else if (i < attack + hold) env[i] = 1;
    else if (i < attack + hold + release) env[i] = 1 - (i - attack - hold) / release;
    else env[i] = 0;
  }
  return env;
}

/* ── 1. Background music (30s) ─────────────────────────────── */
function generateBGM(sr = 44100) {
  const dur = 31; // slightly longer for safety
  const n = sr * dur;
  const out = new Float64Array(n);

  // Pad: layered detuned sine waves with slow filter sweep
  const freqs = [110, 164.81, 220, 329.63]; // Am chord
  const padVol = 0.12;

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;

    // Slow LFO for movement
    const lfo = Math.sin(t * 0.3) * 0.5 + 0.5;
    const lfo2 = Math.sin(t * 0.17 + 1.2) * 0.5 + 0.5;

    for (let f = 0; f < freqs.length; f++) {
      const detune = Math.sin(t * (0.1 + f * 0.05)) * 2; // subtle detune
      const freq = freqs[f] + detune;
      // Fundamental + soft overtone
      v += Math.sin(TAU * freq * t) * 0.6;
      v += Math.sin(TAU * freq * 2 * t) * 0.15 * lfo;
      v += Math.sin(TAU * freq * 3 * t) * 0.05 * lfo2;
    }
    v *= padVol;

    // Subtle rhythmic pulse (every ~0.5s = 120bpm)
    const beatPhase = (t * 2) % 1;
    const pulse = Math.exp(-beatPhase * 6) * 0.06;
    v += Math.sin(TAU * 55 * t) * pulse; // sub bass pulse

    // Hi-hat-like noise on offbeats (every 0.25s)
    const hhPhase = (t * 4) % 1;
    if (hhPhase < 0.05) {
      v += (Math.random() * 2 - 1) * 0.015 * Math.exp(-hhPhase * 40);
    }

    // Fade in (first 2s) and fade out (last 2s)
    let fade = 1;
    if (t < 2) fade = t / 2;
    if (t > dur - 2) fade = (dur - t) / 2;
    v *= clamp(fade, 0, 1);

    out[i] = clamp(v, -1, 1);
  }
  return out;
}

/* ── 2. Whoosh transition (0.6s) ───────────────────────────── */
function generateWhoosh(sr = 44100) {
  const dur = 0.6;
  const n = sr * dur;
  const out = new Float64Array(n);
  const env = envAttackRelease(n, n * 0.15, n * 0.2, n * 0.65);

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Swept noise
    const sweep = Math.sin(t * 40 * TAU) * 0.3 + Math.sin(t * 80 * TAU) * 0.15;
    const noise = (Math.random() * 2 - 1) * 0.4;
    // Low-pass approximation: mix noise with sine sweep
    out[i] = clamp((noise * 0.3 + sweep * 0.7) * env[i] * 0.35, -1, 1);
  }
  return out;
}

/* ── 3. Typing tick (0.15s) ────────────────────────────────── */
function generateTick(sr = 44100) {
  const dur = 0.15;
  const n = sr * dur;
  const out = new Float64Array(n);
  const env = envAttackRelease(n, 2, n * 0.1, n * 0.8);

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = Math.sin(TAU * 2400 * t) * 0.3 + Math.sin(TAU * 4800 * t) * 0.1;
    out[i] = clamp(v * env[i] * 0.25, -1, 1);
  }
  return out;
}

/* ── 4. Success chime (0.8s) ───────────────────────────────── */
function generateChime(sr = 44100) {
  const dur = 0.8;
  const n = sr * dur;
  const out = new Float64Array(n);

  const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
  const noteLen = n / notes.length;

  for (let i = 0; i < n; i++) {
    const noteIdx = Math.min(Math.floor(i / noteLen), notes.length - 1);
    const localI = i - noteIdx * noteLen;
    const env = envAttackRelease(noteLen, 4, noteLen * 0.3, noteLen * 0.7);
    const t = i / sr;
    const v = Math.sin(TAU * notes[noteIdx] * t) * 0.3;
    out[i] = clamp(v * env[localI] * 0.4, -1, 1);
  }
  return out;
}

/* ── 5. Notification ding (0.3s) ───────────────────────────── */
function generateDing(sr = 44100) {
  const dur = 0.3;
  const n = sr * dur;
  const out = new Float64Array(n);
  const env = envAttackRelease(n, 3, n * 0.1, n * 0.85);

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = Math.sin(TAU * 880 * t) * 0.4 + Math.sin(TAU * 1760 * t) * 0.15;
    out[i] = clamp(v * env[i] * 0.35, -1, 1);
  }
  return out;
}

/* ── Generate all ──────────────────────────────────────────── */
console.log('Generating audio files...');
writeWav(path.join(OUT, 'bgm.wav'), generateBGM());
writeWav(path.join(OUT, 'whoosh.wav'), generateWhoosh());
writeWav(path.join(OUT, 'tick.wav'), generateTick());
writeWav(path.join(OUT, 'chime.wav'), generateChime());
writeWav(path.join(OUT, 'ding.wav'), generateDing());
console.log('Done!');
