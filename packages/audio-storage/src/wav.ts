/**
 * Minimal, dependency-free WAV handling.
 *
 * Used for (a) honest duration/loudness analysis of uploaded files and
 * (b) synthesizing the sample catalog that ships with this repo, so the demo never
 * needs — and never contains — someone else's recording.
 */

export interface ParsedWav {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  codec: string;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
  format: 'wav' | 'wave';
}

/** Reads RIFF chunks (handles the common LIST/fact padding that naive parsers miss). */
export function parseWavHeader(buf: Buffer): ParsedWav | null {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) return null;
  const bytesPerSec = Math.max(1, fmt.byteRate || fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8));
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    codec: fmt.audioFormat === 3 ? 'float' : fmt.audioFormat === 1 ? 'pcm_s16le' : `format_${fmt.audioFormat}`,
    dataOffset,
    dataLength,
    durationMs: Math.round((dataLength / bytesPerSec) * 1000),
    format: 'wav',
  };
}

/** Peak/RMS measurement for loudness metadata + a cheap "is this silent?" upload guard. */
export function analyzePcm(buf: Buffer, parsed: ParsedWav) {
  const { dataOffset, dataLength, bitsPerSample, channels } = parsed;
  let peak = 0;
  let sumSq = 0;
  let count = 0;
  const bytesPerSample = bitsPerSample / 8;
  const samples = Math.floor(dataLength / bytesPerSample);
  for (let i = 0; i < samples; i += 1) {
    const at = dataOffset + i * bytesPerSample;
    if (at + bytesPerSample > buf.length) break;
    let v = 0;
    if (bitsPerSample === 16) v = buf.readInt16LE(at) / 32768;
    else if (bitsPerSample === 24) {
      const raw = buf.readUIntBE(at, 3);
      v = ((raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608);
    } else if (bitsPerSample === 32) v = buf.readFloatLE(at);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    count += 1;
  }
  const rms = count ? Math.sqrt(sumSq / count) : 0;
  return {
    peakDbfs: peak > 0 ? Math.round(20 * Math.log10(peak) * 100) / 100 : -120,
    loudnessLufs: rms > 0 ? Math.round((20 * Math.log10(rms / 0.7071) + 16) * 10) / 10 : -70,
    clipped: peak >= 0.999,
    silent: rms < 0.0005,
    channels,
  };
}

export interface WavEncodeOptions {
  sampleRate?: number;
  channels?: 1 | 2;
  bitsPerSample?: 16 | 24;
}

export function encodeWav(samples: Float32Array[], opts: WavEncodeOptions = {}): Buffer {
  const channels = opts.channels ?? 1;
  const bits = opts.bitsPerSample ?? 16;
  const sampleRate = opts.sampleRate ?? 44100;
  const frames = samples[0]?.length ?? 0;
  const bytesPerFrame = channels * (bits / 8);
  const dataBytes = frames * bytesPerFrame;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  buf.writeUInt16LE(bytesPerFrame, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channels; c += 1) {
      const s = Math.max(-1, Math.min(1, samples[c]?.[f] ?? samples[0]![f] ?? 0));
      if (bits === 16) {
        buf.writeInt16LE(Math.round(s * 32767), off);
        off += 2;
      } else {
        buf.writeUIntBE(((Math.round(s * 8388607) << 8) & 0xffffff) >>> 0, off, 3);
        off += 3;
      }
    }
  }
  return buf;
}

/** Fast sine-ish table used by the synth; keeps generated audio light on CPU. */
export function osc(phase: number, shape: 'sine' | 'tri' | 'saw' | 'square' | 'noise' = 'sine', rng = Math.random) {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'tri':
      return 4 * Math.abs(p - 0.5) - 1;
    case 'saw':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'noise':
      return rng() * 2 - 1;
    default:
      return Math.sin(2 * Math.PI * p);
  }
}
