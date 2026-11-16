import { describe, expect, test } from 'vitest';
import { estimateBytes, even, formatSize, planOutput, rotationFromMatrix, uprightSize } from '../src/tools/video/plan';

const ONE = 65536;
// mp4box gives the display matrix as 9 entries in 16.16 fixed point.
const IDENTITY = [ONE, 0, 0, 0, ONE, 0, 0, 0, 1 << 30];
const ROT90 = [0, ONE, 0, -ONE, 0, 0, 0, 0, 1 << 30];
const ROT180 = [-ONE, 0, 0, 0, -ONE, 0, 0, 0, 1 << 30];
const ROT270 = [0, -ONE, 0, ONE, 0, 0, 0, 0, 1 << 30];

describe('rotationFromMatrix', () => {
  test('reads the four right angles', () => {
    expect(rotationFromMatrix(IDENTITY)).toBe(0);
    expect(rotationFromMatrix(ROT90)).toBe(90);
    expect(rotationFromMatrix(ROT180)).toBe(180);
    expect(rotationFromMatrix(ROT270)).toBe(270);
  });

  test('missing or short matrices mean no rotation', () => {
    expect(rotationFromMatrix(undefined)).toBe(0);
    expect(rotationFromMatrix([ONE, 0])).toBe(0);
  });
});

describe('even and uprightSize', () => {
  test('dimensions are always even and at least 2', () => {
    expect(even(0)).toBe(2);
    expect(even(1)).toBe(2);
    expect(even(3)).toBe(2);
    expect(even(1081)).toBe(1080);
    expect(even(720)).toBe(720);
  });

  test('a 90 or 270 degree track swaps width and height', () => {
    expect(uprightSize({ width: 1920, height: 1080, rotation: 90 })).toEqual({ w: 1080, h: 1920 });
    expect(uprightSize({ width: 1920, height: 1080, rotation: 270 })).toEqual({ w: 1080, h: 1920 });
    expect(uprightSize({ width: 1920, height: 1080, rotation: 180 })).toEqual({ w: 1920, h: 1080 });
  });
});

describe('planOutput', () => {
  test('keeps a 1080p landscape clip at full size', () => {
    const p = planOutput({ width: 1920, height: 1080, rotation: 0, fps: 30 }, 1080);
    expect([p.width, p.height, p.scaled]).toEqual([1920, 1080, false]);
  });

  test('keeps an iPhone portrait clip upright at full size', () => {
    const p = planOutput({ width: 1920, height: 1080, rotation: 90, fps: 30 }, 1080);
    expect([p.width, p.height, p.scaled]).toEqual([1080, 1920, false]);
  });

  test('scales a 4K clip down so the shorter side meets the target', () => {
    const p = planOutput({ width: 3840, height: 2160, rotation: 0, fps: 30 }, 1080);
    expect([p.width, p.height, p.scaled]).toEqual([1920, 1080, true]);
  });

  test('scales an upright portrait clip by its shorter side', () => {
    const p = planOutput({ width: 1920, height: 1080, rotation: 90, fps: 30 }, 720);
    expect([p.width, p.height]).toEqual([720, 1280]);
    expect(p.scaled).toBe(true);
  });

  test('never upscales a small clip', () => {
    const p = planOutput({ width: 640, height: 480, rotation: 0, fps: 30 }, 1080);
    expect([p.width, p.height, p.scaled]).toEqual([640, 480, false]);
  });

  test('odd source sizes come out even', () => {
    const p = planOutput({ width: 1001, height: 751, rotation: 0, fps: 30 }, 1080);
    expect(p.width % 2).toBe(0);
    expect(p.height % 2).toBe(0);
  });

  test('bitrate never exceeds 70% of the source bitrate', () => {
    const p = planOutput({ width: 1920, height: 1080, rotation: 90, fps: 30, bitrate: 8_100_000 }, 1080);
    expect(p.bitrate).toBeLessThanOrEqual(Math.round(8_100_000 * 0.7));
    expect(p.bitrate).toBeGreaterThan(0);
  });

  test('a very low source bitrate is never raised by the floor', () => {
    const p = planOutput({ width: 320, height: 240, rotation: 0, fps: 1, bitrate: 100_000 }, 480);
    expect(p.bitrate).toBeLessThanOrEqual(70_000);
  });

  test('without a known source bitrate, the bitrate follows the pixel count and stays in range', () => {
    const big = planOutput({ width: 1920, height: 1080, rotation: 0, fps: 30 }, 1080);
    expect(big.bitrate).toBe(Math.round(1920 * 1080 * 30 * 0.15));
    const tiny = planOutput({ width: 160, height: 120, rotation: 0, fps: 1 }, 480);
    expect(tiny.bitrate).toBe(800_000);
    const huge = planOutput({ width: 7680, height: 4320, rotation: 0, fps: 60 }, 1080);
    expect(huge.bitrate).toBeLessThanOrEqual(20_000_000);
  });

  test('frame rate is clamped to 1-60 and defaults to 30 when unknown', () => {
    expect(planOutput({ width: 640, height: 480, rotation: 0, fps: 0 }, 480).fps).toBe(30);
    expect(planOutput({ width: 640, height: 480, rotation: 0, fps: 240 }, 480).fps).toBe(60);
    expect(planOutput({ width: 640, height: 480, rotation: 0, fps: 29.97 }, 480).fps).toBe(30);
  });
});

describe('estimateBytes and formatSize', () => {
  test('estimates bytes from video plus audio bitrate and duration', () => {
    expect(estimateBytes({ bitrate: 8_000_000 }, 10, 128_000)).toBe(Math.round(((8_128_000) / 8) * 10));
    expect(estimateBytes({ bitrate: 8_000_000 }, -5)).toBe(0);
  });

  test('formats sizes in readable units', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(512 * 1024)).toBe('512 KB');
    expect(formatSize(150 * 1024 * 1024)).toBe('150 MB');
    expect(formatSize(38.4 * 1024 * 1024)).toBe('38.4 MB');
    expect(formatSize(1.2 * 1024 ** 3)).toBe('1.2 GB');
  });

  test('rejects impossible sizes', () => {
    expect(formatSize(Number.NaN)).toBe('—');
    expect(formatSize(-1)).toBe('—');
  });
});
