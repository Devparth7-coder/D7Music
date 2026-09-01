/**
 * Deterministic generator for the SHIPPABLE SAMPLE CATALOG.
 *
 * The repo must run with audio that is legally ours to distribute, so the demo
 * catalog is synthesized here (original audio, no samples, no covers, no covers-of-covers).
 * Given the same seed it always produces the same bytes, which keeps tests and
 * playback-duration assertions stable.
 */
import { encodeWav, osc } from './wav.js';

export type SynthGenre = 'lofi' | 'ambient' | 'synthwave' | 'techno' | 'jazz' | 'hiphop' | 'classical' | 'drumandbass';

interface Recipe {
  bpm: number;
  scale: number[]; // semitone offsets
  rootHz: number;
  drums: 'soft' | 'four' | 'break' | 'none' | 'dnb';
  pad: 'sine' | 'tri' | 'saw';
  lead: 'sine' | 'tri' | 'square' | 'saw';
  reverb: number;
  swing: number;
}

const RECIPES: Record<SynthGenre, Recipe> = {
  lofi: { bpm: 74, scale: [0, 2, 3, 5, 7, 9, 10], rootHz: 220, drums: 'soft', pad: 'tri', lead: 'sine', reverb: 0.35, swing: 0.16 },
  ambient: { bpm: 56, scale: [0, 2, 4, 7, 9, 11, 12], rootHz: 174.6, drums: 'none', pad: 'sine', lead: 'sine', reverb: 0.6, swing: 0 },
  synthwave: { bpm: 104, scale: [0, 3, 5, 7, 10], rootHz: 233.1, drums: 'four', pad: 'saw', lead: 'square', reverb: 0.3, swing: 0 },
  techno: { bpm: 128, scale: [0, 1, 5, 7, 8], rootHz: 110, drums: 'four', pad: 'saw', lead: 'square', reverb: 0.18, swing: 0 },
  jazz: { bpm: 96, scale: [0, 2, 3, 5, 7, 9, 11], rootHz: 261.6, drums: 'soft', pad: 'tri', lead: 'sine', reverb: 0.25, swing: 0.22 },
  hiphop: { bpm: 88, scale: [0, 3, 5, 7, 10], rootHz: 146.8, drums: 'break', pad: 'tri', lead: 'saw', reverb: 0.2, swing: 0.1 },
  classical: { bpm: 66, scale: [0, 2, 4, 5, 7, 9, 11], rootHz: 261.6, drums: 'none', pad: 'sine', lead: 'tri', reverb: 0.5, swing: 0 },
  drumandbass: { bpm: 172, scale: [0, 3, 7, 10], rootHz: 98, drums: 'dnb', pad: 'saw', lead: 'square', reverb: 0.15, swing: 0 },
};

/** mulberry32: tiny deterministic PRNG. */
function rngFrom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface SynthOptions {
  seed: string;
  genre: SynthGenre;
  seconds?: number;
  sampleRate?: number;
  energy?: number;
}

export function synthesizeTrack(opts: SynthOptions): Buffer {
  const sampleRate = opts.sampleRate ?? 22050;
  const seconds = Math.max(4, Math.min(60, opts.seconds ?? 12));
  const recipe = RECIPES[opts.genre] ?? RECIPES.lofi;
  const rng = rngFrom(hashSeed(`${opts.seed}|${opts.genre}`));
  const energy = opts.energy ?? 0.35 + rng() * 0.5;

  const beatsPerSec = recipe.bpm / 60;
  const total = Math.floor(sampleRate * seconds);
  const out = new Float32Array(total);
  const nNotes = 4 + Math.floor(rng() * 3);
  const progression = Array.from({ length: nNotes }, () => recipe.scale[Math.floor(rng() * recipe.scale.length)] ?? 0);
  const bassLine = progression.map((s, i) => (i % 2 ? s - 12 : s - (recipe.drums === 'none' ? 0 : 12)));

  // 1) harmonic bed: slowly detuned pad on chord tones
  const chordDur = (60 / recipe.bpm) * 2;
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const ci = Math.floor(t / chordDur) % progression.length;
    const chord = progression;
    const local = (t % chordDur) / chordDur;
    const env = Math.sin(Math.PI * Math.min(1, local * 1.06)) ** 0.8;
    let v = 0;
    for (const step of [chord[ci]!, chord[(ci + 1) % chord.length]! + 3, chord[(ci + 2) % chord.length]! - 2]) {
      const f = recipe.rootHz * 2 ** (step / 12);
      v += osc(t * f, recipe.pad) * 0.5;
      v += osc(t * f * 1.003, recipe.pad) * 0.3; // detune -> chorus width
    }
    const bassF = recipe.rootHz * 0.5 * 2 ** (bassLine[ci]! / 12);
    v += osc(t * bassF, 'sine') * 0.75;
    out[i]! += v * env * (0.16 + energy * 0.12);
  }

  // 2) melody: pentatonic-ish line on the 8th grid with swing
  const stepDur = (60 / recipe.bpm) / 2;
  const melody: { at: number; dur: number; hz: number; amp: number }[] = [];
  for (let bar = 0; bar * stepDur * 8 < seconds; bar += 1) {
    for (let s = 0; s < 8; s += 1) {
      if (rng() < 0.42) continue;
      const swing = s % 2 ? recipe.swing * stepDur : 0;
      const at = bar * stepDur * 8 + s * stepDur + swing;
      const len = stepDur * (rng() < 0.25 ? 2 : 1);
      const step = (recipe.scale[Math.floor(rng() * recipe.scale.length)] ?? 0) + (rng() < 0.2 ? 12 : 0);
      melody.push({ at, dur: len * 0.9, hz: recipe.rootHz * 4 * 2 ** (step / 12), amp: 0.1 + rng() * 0.1 * (0.5 + energy) });
    }
  }
  for (const n of melody) {
    const from = Math.floor(n.at * sampleRate);
    const to = Math.min(total, Math.floor((n.at + n.dur) * sampleRate));
    for (let i = from; i < to; i += 1) {
      const t = (i - from) / sampleRate;
      const local = (i - from) / Math.max(1, to - from);
      const env = Math.sin(Math.PI * local) ** 1.4;
      const glide = 1 + Math.exp(-t * 18) * 0.03;
      out[i]! += osc(n.at * n.hz + (i / sampleRate) * n.hz * glide - n.at * n.hz, recipe.lead) * n.amp * env;
    }
  }

  // 3) percussion
  const beat = 60 / recipe.bpm;
  const hits: { at: number; kind: 'kick' | 'snare' | 'hat' }[] = [];
  const bars = Math.ceil(seconds / (beat * 4));
  for (let b = 0; b < bars; b += 1) {
    for (let sub = 0; sub < 4; sub += 1) {
      const at = b * beat * 4 + sub * beat;
      if (recipe.drums === 'none') continue;
      if (recipe.drums === 'four') hits.push({ at, kind: 'kick' });
      if (recipe.drums === 'soft' && sub % 2 === 0) hits.push({ at, kind: 'kick' });
      if (recipe.drums === 'break' && (sub === 0 || sub === 2.5)) hits.push({ at, kind: 'kick' });
      if (recipe.drums === 'dnb' && (sub === 1 || sub === 3)) hits.push({ at, kind: 'kick' });
      if (recipe.drums !== 'dnb' && (sub === 1 || sub === 3)) hits.push({ at, kind: 'snare' });
      if (recipe.drums === 'dnb' && sub === 2) hits.push({ at, kind: 'snare' });
      for (let h = 0; h < 2; h += 1) if (rng() > 0.25) hits.push({ at: at + (h * beat) / 2, kind: 'hat' });
    }
  }
  for (const hit of hits) {
    const from = Math.floor(hit.at * sampleRate);
    const dur = hit.kind === 'hat' ? 0.05 : hit.kind === 'snare' ? 0.16 : 0.28;
    const to = Math.min(total, Math.floor((hit.at + dur) * sampleRate));
    for (let i = from; i < to; i += 1) {
      const t = (i - from) / sampleRate;
      const local = t / dur;
      const env = Math.exp(-local * (hit.kind === 'hat' ? 7 : 4));
      let v = 0;
      if (hit.kind === 'kick') v = osc(hit.at * 55 + (i / sampleRate) * 55, 'sine') * Math.exp(-local * 5) * 0.9;
      else if (hit.kind === 'snare') v = (osc(0, 'noise', rngFrom(hashSeed(`${hit.at.toFixed(4)}`))) * 0.6 + osc(t * 190, 'tri') * 0.25) * env;
      else v = osc(t * 6200 + t * t * 900, 'noise', rngFrom(hashSeed(`h${(hit.at * 1000).toFixed(0)}`))) * env;
      out[i]! += v * (hit.kind === 'hat' ? 0.05 : 0.16) * (0.6 + energy * 0.8);
    }
  }

  // 4) gentle one-pole lowpass + feedback "reverb", normalize, fade
  let lp = 0;
  const cutoff = 0.18 + energy * 0.25;
  const delay = Math.floor(sampleRate * 0.19);
  const wet = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const x = out[i]!;
    lp += (x - lp) * cutoff;
    out[i]! = lp;
    wet[i]! = lp + (i >= delay ? wet[i - delay]! * recipe.reverb * 0.55 : 0);
  }
  for (let i = 0; i < total; i += 1) out[i]! = (out[i]! * 0.78 + wet[i]! * 0.22) * 0.999;

  let peak = 0;
  for (let i = 0; i < total; i += 1) peak = Math.max(peak, Math.abs(out[i]!));
  const gain = peak > 0 ? 0.88 / peak : 1;
  const fade = Math.floor(sampleRate * 0.35);
  for (let i = 0; i < total; i += 1) {
    const f = Math.min(1, Math.min(i, total - i) / Math.max(1, fade));
    out[i]! = Math.tanh(out[i]! * gain * f); // soft clip keeps generated audio free of pops
  }
  return encodeWav([out], { sampleRate, channels: 1, bitsPerSample: 16 });
}

/** Perceptual features we can honestly derive from the synthesized master. */
export function estimateFeatures(wav: Buffer) {
  let sum = 0;
  let sumSq = 0;
  let zcr = 0;
  let prev = 0;
  let count = 0;
  for (let i = 44; i + 1 < wav.length; i += 2) {
    const v = wav.readInt16LE(i) / 32768;
    sum += Math.abs(v);
    sumSq += v * v;
    if ((v > 0) !== (prev > 0)) zcr += 1;
    prev = v;
    count += 1;
  }
  const rms = count ? Math.sqrt(sumSq / count) : 0;
  const zcrRate = count ? zcr / (count / 2) : 0;
  const clamp = (n: number) => Math.max(0, Math.min(1, Number(n.toFixed(3))));
  return {
    energy: clamp(rms * 3.2),
    valence: clamp(0.35 + zcrRate * 0.6),
    danceability: clamp(0.3 + rms * 1.4),
    acousticness: clamp(1 - zcrRate * 2.2),
    loudnessLufs: Math.round((20 * Math.log10(rms / 0.7071) + 16) * 10) / 10,
    peakDbfs: Math.round(20 * Math.log10(Math.max(1e-6, sum / Math.max(1, count))) * 100) / 100,
  };
}
