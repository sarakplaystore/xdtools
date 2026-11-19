/**
 * Shrinks a video in the browser: demux (mp4box), decode (WebCodecs), rotate and scale on a canvas,
 * encode H.264 (WebCodecs), copy the audio packets untouched, and mux an MP4 (mp4-muxer).
 *
 * Nothing leaves the device. The picture is re-encoded, the sound is copied bit for bit.
 */
import { DataStream, Endianness, createFile } from 'mp4box';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { OutputPlan, Resolution, Rotation, planOutput, rotationFromMatrix } from './plan';

type PlaneLayout = { offset: number; stride: number };

export type VideoErrorCode = 'read' | 'novideo' | 'unsupported' | 'codec' | 'decode' | 'cancelled';

export class VideoError extends Error {
  constructor(
    readonly code: VideoErrorCode,
    readonly detail = '',
  ) {
    super(detail || code);
    this.name = 'VideoError';
  }
}

/** A key frame at least this often, so the output can be seeked. */
const KEY_INTERVAL_US = 2_000_000;
/** How many chunks may wait in a codec's queue before we stop feeding it. */
const QUEUE_LIMIT = 6;

interface Sample {
  data: Uint8Array;
  cts: number;
  dts: number;
  duration: number;
  is_sync: boolean;
}

interface TrackInfo {
  id: number;
  codec: string;
  nb_samples: number;
  timescale: number;
  duration: number;
  track_width: number;
  track_height: number;
  matrix: ArrayLike<number>;
  bitrate?: number;
  video?: { width: number; height: number };
  audio?: { channel_count: number; sample_rate: number };
}

interface MovieInfo {
  videoTracks: TrackInfo[];
  audioTracks: TrackInfo[];
}

/** The parts of the mp4box file object this module uses. */
interface Mp4File {
  onError: ((module: string, message: string) => void) | null;
  onReady: ((info: MovieInfo) => void) | null;
  onSamples: ((id: number, user: unknown, samples: Sample[]) => void) | null;
  appendBuffer(data: ArrayBuffer & { fileStart?: number }): number;
  flush(): void;
  setExtractionOptions(id: number, user: unknown, options: { nbSamples?: number }): void;
  start(): void;
  getTrackById(id: number): RawTrak;
}

interface RawTrak {
  mdia: { minf: { stbl: { stsd: { entries: Record<string, any>[] } } } };
}

export interface Demuxed {
  video: { info: TrackInfo; description?: Uint8Array; samples: Sample[]; rotation: Rotation };
  audio?: { info: TrackInfo; description?: Uint8Array; samples: Sample[] };
}

/** Reads every sample of the first video (and audio) track. Synchronous: mp4box runs in one pass. */
export function demux(buffer: ArrayBuffer): Demuxed {
  const file = createFile() as unknown as Mp4File;
  const collected = new Map<number, Sample[]>();
  // Filled in by mp4box callbacks; held in an object so the checks below see what they wrote.
  const state: { info: MovieInfo | null; failure: VideoError | null } = { info: null, failure: null };

  file.onError = (_module, message) => {
    state.failure = new VideoError('read', message);
  };
  file.onReady = (info) => {
    state.info = info;
    const video = info.videoTracks[0];
    if (!video) {
      state.failure = new VideoError('novideo');
      return;
    }
    const tracks = [video, info.audioTracks[0]].filter((t): t is TrackInfo => !!t);
    for (const t of tracks) {
      collected.set(t.id, []);
      file.setExtractionOptions(t.id, null, { nbSamples: 1000 });
    }
    file.onSamples = (id, _user, samples) => {
      const list = collected.get(id);
      if (list) list.push(...samples);
    };
    file.start();
  };

  const input = buffer as ArrayBuffer & { fileStart?: number };
  input.fileStart = 0;
  file.appendBuffer(input);
  file.flush();

  if (state.failure) throw state.failure;
  const info = state.info;
  if (!info) throw new VideoError('read');
  const v = info.videoTracks[0];
  const a = info.audioTracks[0];
  const vSamples = collected.get(v.id) ?? [];
  if (vSamples.length === 0) throw new VideoError('read');

  return {
    video: {
      info: v,
      description: codecDescription(file.getTrackById(v.id)),
      samples: vSamples,
      rotation: rotationFromMatrix(v.matrix),
    },
    audio: a
      ? { info: a, description: aacConfig(file.getTrackById(a.id)), samples: collected.get(a.id) ?? [] }
      : undefined,
  };
}

/** The codec's configuration record (avcC, hvcC, ...) without its box header. */
function codecDescription(trak: RawTrak): Uint8Array | undefined {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);
    }
  }
  return undefined;
}

/** The AAC AudioSpecificConfig, from the esds box. */
function aacConfig(trak: RawTrak): Uint8Array | undefined {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const data = entry.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    if (data) return new Uint8Array(data);
  }
  return undefined;
}

/** Encoder settings, from the most compatible H.264 profile the browser accepts. */
async function pickEncoderConfig(plan: OutputPlan): Promise<VideoEncoderConfig> {
  // High 4.2 covers 1080p at 60 fps; the others are fallbacks for older hardware.
  const codecs = ['avc1.64002A', 'avc1.640028', 'avc1.42001F'];
  for (const codec of codecs) {
    const config: VideoEncoderConfig = {
      codec,
      width: plan.width,
      height: plan.height,
      bitrate: plan.bitrate,
      framerate: plan.fps,
      avc: { format: 'avc' },
      // Realtime mode skips the slow look-ahead search of quality mode: the output is a little
      // larger at the same bitrate, but the encode runs several times faster.
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported && support.config) return support.config;
  }
  throw new VideoError('unsupported');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ShrinkOptions {
  resolution: Resolution;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface ShrinkResult {
  bytes: Uint8Array;
  plan: OutputPlan;
  rotation: Rotation;
  durationSec: number;
}

/** True when the browser has the pieces this tool needs. */
export function canShrink(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/** Shrinks one video file. Throws VideoError on failure or cancellation. */
export async function shrinkVideo(file: Blob, opts: ShrinkOptions): Promise<ShrinkResult> {
  if (!canShrink()) throw new VideoError('unsupported');
  const data = await file.arrayBuffer();
  const throwIfCancelled = () => {
    if (opts.signal?.aborted) throw new VideoError('cancelled');
  };
  throwIfCancelled();
  const src = demux(data);
  const v = src.video;
  const seconds = v.info.duration / v.info.timescale;
  const fps = seconds > 0 ? v.samples.length / seconds : 30;
  const plan = planOutput({ width: v.info.track_width, height: v.info.track_height, rotation: v.rotation, fps, bitrate: v.info.bitrate }, opts.resolution);

  const decoderConfig: VideoDecoderConfig = {
    codec: v.info.codec,
    codedWidth: v.info.track_width,
    codedHeight: v.info.track_height,
    description: v.description,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  };
  const decodeSupport = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!decodeSupport.supported) throw new VideoError('codec', v.info.codec);
  const encoderConfig = await pickEncoderConfig(plan);

  const target = new ArrayBufferTarget();
  const audio = src.audio;
  const audioChannels = audio?.info.audio?.channel_count ?? 2;
  const audioRate = audio?.info.audio?.sample_rate ?? 48000;
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: plan.width, height: plan.height },
    audio: audio && audio.description ? { codec: 'aac', numberOfChannels: audioChannels, sampleRate: audioRate } : undefined,
    fastStart: 'in-memory',
    // Source clips often start at a non-zero time (edit lists). Shift both tracks by the same
    // amount so the file starts at 0 and audio stays in sync with video.
    firstTimestampBehavior: 'cross-track-offset',
  });

  const state: { failure: VideoError | null } = { failure: null };
  const fail = (e: unknown) => {
    if (!state.failure) state.failure = e instanceof VideoError ? e : new VideoError('decode', e instanceof Error ? e.message : String(e));
  };
  // Muxer errors are thrown inside encoder callbacks, where the encoder's error handler never sees them.
  const safeMux = (write: () => void) => {
    try {
      write();
    } catch (e) {
      fail(e);
    }
  };

  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new VideoError('unsupported');
  const yuv = i420Buffer(plan.width, plan.height);

  const encoder = new VideoEncoder({
    output: (chunk, meta) =>
      safeMux(() => {
        // The frames are BT.709 by construction. The muxer writes the colour tag from the first
        // chunk's decoder config; without it players fall back to BT.601 and shift the colours.
        if (!meta?.decoderConfig) return muxer.addVideoChunk(chunk, meta);
        muxer.addVideoChunk(chunk, { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: BT709_LIMITED } });
      }),
    error: fail,
  });
  encoder.configure(encoderConfig);

  let keyAt = Number.NEGATIVE_INFINITY;
  let done = 0;
  let lastReported = 0;
  const total = v.samples.length;
  const onFrame = (frame: VideoFrame) => {
    try {
      if (state.failure || opts.signal?.aborted) return;
      drawUpright(ctx, frame, plan.width, plan.height, v.rotation);
      rgbaToI420(ctx.getImageData(0, 0, plan.width, plan.height).data, plan.width, plan.height, yuv.buf);
      const out = new VideoFrame(yuv.buf, {
        format: 'I420',
        codedWidth: plan.width,
        codedHeight: plan.height,
        timestamp: frame.timestamp,
        duration: frame.duration ?? undefined,
        layout: yuv.layout,
        colorSpace: BT709_LIMITED,
      });
      const key = frame.timestamp - keyAt >= KEY_INTERVAL_US;
      if (key) keyAt = frame.timestamp;
      encoder.encode(out, { keyFrame: key });
      out.close();
      done++;
      // Report at most every half percent: a progress update per frame costs a re-render each time.
      const ratio = Math.min(1, done / total);
      if (ratio - lastReported >= 0.005 || ratio === 1) {
        lastReported = ratio;
        opts.onProgress?.(ratio);
      }
    } catch (e) {
      fail(e);
    } finally {
      frame.close();
    }
  };
  const decoder = new VideoDecoder({ output: onFrame, error: fail });
  decoder.configure(decoderConfig);

  try {
    if (audio && audio.description) {
      const aTs = audio.info.timescale;
      audio.samples.forEach((s, i) => {
        const chunk = new EncodedAudioChunk({ type: 'key', timestamp: toUs(s.dts, aTs), duration: toUs(s.duration, aTs), data: s.data });
        const meta = i === 0 ? { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: audioChannels, sampleRate: audioRate, description: audio.description } } : undefined;
        safeMux(() => muxer.addAudioChunk(chunk, meta));
      });
    }

    const vTs = v.info.timescale;
    for (const s of v.samples) {
      throwIfCancelled();
      if (state.failure) throw state.failure;
      while (decoder.decodeQueueSize > QUEUE_LIMIT || encoder.encodeQueueSize > QUEUE_LIMIT) {
        await sleep(2);
        throwIfCancelled();
        if (state.failure) throw state.failure;
      }
      decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: toUs(s.cts, vTs), duration: toUs(s.duration, vTs), data: s.data }));
    }
    await decoder.flush();
    await encoder.flush();
    if (state.failure) throw state.failure;
    muxer.finalize();
  } catch (e) {
    fail(e);
    throw state.failure ?? e;
  } finally {
    if (decoder.state !== 'closed') decoder.close();
    if (encoder.state !== 'closed') encoder.close();
  }

  return { bytes: new Uint8Array(target.buffer), plan, rotation: v.rotation, durationSec: seconds };
}

/** Draws a decoded frame upright, scaled to the output canvas. `rotation` is clockwise. */
/** The colour space the output is written in: BT.709, limited range (what iPhone and most H.264 use). */
const BT709_LIMITED: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

/** One I420 (YUV 4:2:0) frame buffer and the plane layout that goes with it. */
function i420Buffer(w: number, h: number): { buf: Uint8Array; layout: PlaneLayout[] } {
  const ySize = w * h;
  const cSize = (w / 2) * (h / 2);
  return {
    buf: new Uint8Array(ySize + 2 * cSize),
    layout: [
      { offset: 0, stride: w },
      { offset: ySize, stride: w / 2 },
      { offset: ySize + cSize, stride: w / 2 },
    ],
  };
}

/**
 * Per-channel contributions to Y, U and V, precomputed once per byte value. The sums below add
 * these up, so the per-pixel work is a few table lookups instead of float maths on every pixel.
 */
const YUV_TABLES = (() => {
  const yScale = 219 / 255;
  const cScale = 224 / 255;
  const make = (k: number) => new Float64Array(256).map((_, i) => i * k);
  return {
    yR: make(0.2126 * yScale),
    yG: make(0.7152 * yScale),
    yB: make(0.0722 * yScale),
    uR: make(-0.1146 * cScale),
    uG: make(-0.3854 * cScale),
    uB: make(0.5 * cScale),
    vR: make(0.5 * cScale),
    vG: make(-0.4542 * cScale),
    vB: make(-0.0458 * cScale),
  };
})();

/**
 * Converts RGBA to I420 with the exact BT.709 limited-range equations. Done here, not by the
 * encoder, so the colours in the output match the source instead of shifting toward green.
 * Chroma is the average of each 2×2 block. w and h must be even.
 */
export function rgbaToI420(rgba: Uint8ClampedArray, w: number, h: number, out: Uint8Array): void {
  const { yR, yG, yB, uR, uG, uB, vR, vG, vB } = YUV_TABLES;
  const ySize = w * h;
  const cw = w >> 1;
  const uOff = ySize;
  const vOff = ySize + cw * (h >> 1);
  for (let y = 0; y < h; y += 2) {
    const row0 = y * w * 4;
    const row1 = row0 + w * 4;
    const yo0 = y * w;
    const yo1 = yo0 + w;
    const co = (y >> 1) * cw;
    for (let x = 0; x < w; x += 2) {
      // The four pixels of the 2×2 block: a b on the top row, c d below.
      const a = row0 + x * 4;
      const c = row1 + x * 4;
      const ra = rgba[a];
      const ga = rgba[a + 1];
      const ba = rgba[a + 2];
      const rb = rgba[a + 4];
      const gb = rgba[a + 5];
      const bb = rgba[a + 6];
      const rc = rgba[c];
      const gc = rgba[c + 1];
      const bc = rgba[c + 2];
      const rd = rgba[c + 4];
      const gd = rgba[c + 5];
      const bd = rgba[c + 6];
      // 16.5 + x truncated = round(16 + x) for the positive values Y takes.
      out[yo0 + x] = (16.5 + yR[ra] + yG[ga] + yB[ba]) | 0;
      out[yo0 + x + 1] = (16.5 + yR[rb] + yG[gb] + yB[bb]) | 0;
      out[yo1 + x] = (16.5 + yR[rc] + yG[gc] + yB[bc]) | 0;
      out[yo1 + x + 1] = (16.5 + yR[rd] + yG[gd] + yB[bd]) | 0;
      const sumU = uR[ra] + uG[ga] + uB[ba] + uR[rb] + uG[gb] + uB[bb] + uR[rc] + uG[gc] + uB[bc] + uR[rd] + uG[gd] + uB[bd];
      const sumV = vR[ra] + vG[ga] + vB[ba] + vR[rb] + vG[gb] + vB[bb] + vR[rc] + vG[gc] + vB[bc] + vR[rd] + vG[gd] + vB[bd];
      const ci = co + (x >> 1);
      out[uOff + ci] = clampByte((128.5 + sumU / 4) | 0);
      out[vOff + ci] = clampByte((128.5 + sumV / 4) | 0);
    }
  }
}

const clampByte = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n);

function drawUpright(ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame, width: number, height: number, rotation: Rotation): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  // Before rotation the picture is drawn with its sides swapped for a quarter turn.
  const quarter = rotation === 90 || rotation === 270;
  const dw = quarter ? height : width;
  const dh = quarter ? width : height;
  ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

const toUs = (ticks: number, timescale: number) => Math.round((ticks * 1_000_000) / timescale);
