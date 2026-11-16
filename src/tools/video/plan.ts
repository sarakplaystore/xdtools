/**
 * Planning for the video shrinker: how big the output is, how fast it runs and how many bits per
 * second it gets. Pure functions only (no browser APIs), so they can be tested without a browser.
 */

/** Clockwise rotation, in degrees, that the stored frames need to be shown upright. */
export type Rotation = 0 | 90 | 180 | 270;

/** Output quality tier: the length of the shorter side of the picture, in pixels. */
export type Resolution = 1080 | 720 | 480;

export const RESOLUTIONS: Resolution[] = [1080, 720, 480];

/** Bits per pixel per frame. About a third of an iPhone 4K HEVC stream: sharp at phone size. */
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE = 800_000;
const MAX_BITRATE = 20_000_000;
/** Never ask for more than this share of the source bitrate, so the output is always smaller. */
const SOURCE_SHARE = 0.7;
const MAX_FPS = 60;

/**
 * Reads the track's display matrix (mp4box gives its 9 entries as 16.16 fixed point) and returns
 * the clockwise rotation that makes the stored frames upright. iPhone portrait video is stored
 * as landscape frames with a 90° matrix.
 */
export function rotationFromMatrix(m: ArrayLike<number> | undefined): Rotation {
  if (!m || m.length < 5) return 0;
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  const quarter = Math.round(deg / 90);
  return ((((quarter * 90) % 360) + 360) % 360) as Rotation;
}

/** H.264 needs even dimensions. Never returns less than 2. */
export function even(n: number): number {
  return Math.max(2, 2 * Math.floor(n / 2));
}

export interface SourceInfo {
  /** Stored frame size, before rotation. */
  width: number;
  height: number;
  rotation: Rotation;
  /** Average frame rate of the source. */
  fps: number;
  /** Bitrate of the source video track in bits per second, if known. */
  bitrate?: number;
}

export interface OutputPlan {
  /** Upright output size; both sides are even. */
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** True when the picture is scaled down from the source. */
  scaled: boolean;
}

/** Size of the upright picture, after rotation and before scaling. */
export function uprightSize(src: Pick<SourceInfo, 'width' | 'height' | 'rotation'>): { w: number; h: number } {
  return src.rotation === 90 || src.rotation === 270 ? { w: src.height, h: src.width } : { w: src.width, h: src.height };
}

export function planOutput(src: SourceInfo, resolution: Resolution): OutputPlan {
  const { w, h } = uprightSize(src);
  // Scale so the shorter side meets the target. Never upscale: a small clip stays small.
  const scale = Math.min(1, resolution / Math.min(w, h));
  const width = even(Math.round(w * scale));
  const height = even(Math.round(h * scale));
  const fps = Math.min(MAX_FPS, Math.max(1, Math.round(src.fps > 0 ? src.fps : 30)));
  let bitrate = Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, width * height * fps * BITS_PER_PIXEL));
  // The source cap wins over the floor, so the output is never planned above the source.
  if (src.bitrate && src.bitrate > 0) bitrate = Math.min(bitrate, src.bitrate * SOURCE_SHARE);
  return { width, height, fps, bitrate: Math.round(bitrate), scaled: width !== w || height !== h };
}

/** Rough size of the output file, in bytes, from the planned bitrate and the duration. */
export function estimateBytes(plan: Pick<OutputPlan, 'bitrate'>, seconds: number, audioBitrate = 128_000): number {
  return Math.round(((plan.bitrate + audioBitrate) / 8) * Math.max(0, seconds));
}

/** Human-readable size: "512 KB", "38.4 MB", "1.2 GB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // One decimal below 100 ("1.5 MB"), whole numbers from 100 up ("512 KB"). Trailing ".0" is dropped.
  const shown = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${shown} ${units[i]}`;
}
