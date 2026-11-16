import { describe, expect, test } from 'vitest';
import { rgbaToI420 } from '../src/tools/video/transcode';

/** Converts one solid colour (w×h, 2×2 is enough) and returns its Y, U, V samples. */
function solid(r: number, g: number, b: number) {
  const w = 2;
  const h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  const out = new Uint8Array(w * h + 2 * (w / 2) * (h / 2));
  rgbaToI420(rgba, w, h, out);
  return { y: out[0], u: out[w * h], v: out[w * h + 1] };
}

describe('RGBA to I420 (BT.709, limited range)', () => {
  test('black and white hit the limited-range ends', () => {
    expect(solid(0, 0, 0)).toEqual({ y: 16, u: 128, v: 128 });
    expect(solid(255, 255, 255)).toEqual({ y: 235, u: 128, v: 128 });
  });

  test('primaries use the BT.709 luma weights', () => {
    // Y = 16 + 219/255 * (0.2126 R + 0.7152 G + 0.0722 B)
    expect(solid(255, 0, 0).y).toBe(Math.round(16 + 0.2126 * 219));
    expect(solid(0, 255, 0).y).toBe(Math.round(16 + 0.7152 * 219));
    expect(solid(0, 0, 255).y).toBe(Math.round(16 + 0.0722 * 219));
  });

  test('pure red and blue push chroma the right way; grey stays neutral', () => {
    const red = solid(255, 0, 0);
    expect(red.v).toBeGreaterThan(200);
    expect(red.u).toBeLessThan(110);
    const blue = solid(0, 0, 255);
    expect(blue.u).toBeGreaterThan(200);
    // Cr for blue is 128 - 0.0458 * 224 ≈ 118: only slightly below neutral.
    expect(blue.v).toBeLessThan(124);
    expect(blue.v).toBeGreaterThan(112);
    const grey = solid(128, 128, 128);
    expect(Math.abs(grey.u - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(grey.v - 128)).toBeLessThanOrEqual(1);
  });

  test('chroma is averaged over each 2×2 block', () => {
    // Left column red, right column blue: the one chroma sample must sit between them.
    const w = 2;
    const h = 2;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const px = [[255, 0, 0], [0, 0, 255], [255, 0, 0], [0, 0, 255]];
    px.forEach((c, i) => rgba.set([...c, 255], i * 4));
    const out = new Uint8Array(w * h + 2 * (w / 2) * (h / 2));
    rgbaToI420(rgba, w, h, out);
    const red = solid(255, 0, 0);
    const blue = solid(0, 0, 255);
    expect(out[w * h]).toBeGreaterThan(Math.min(red.u, blue.u));
    expect(out[w * h]).toBeLessThan(Math.max(red.u, blue.u));
  });
});
