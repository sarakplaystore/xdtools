import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The editor keeps drawing with pdf.js. After a deployment the worker file it was built with is a
 * 404, which pdf.js hides: it falls back to parsing on the main thread, where opening can hang.
 * These tests pin down what loadPdf does about that.
 */
const state = {
  open: () => new Promise<never>(() => {}),
  workerAlive: true,
};

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {} as Record<string, string>,
  RenderingCancelledException: class extends Error {},
  getDocument: () => ({ promise: state.open() }),
  PDFWorker: class {
    destroyed = false;
    promise = Promise.resolve();
    destroy() {
      this.destroyed = true;
      return Promise.resolve();
    }
  },
}));

const { loadPdf, ViewerFilesGoneError } = await import('../src/tools/pdf-editor/pdfjs');

const bytes = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.useFakeTimers();
  state.workerAlive = true;
  state.open = () => new Promise<never>(() => {});
  vi.stubGlobal('fetch', async (url: string) => ({ ok: state.workerAlive || !String(url).includes('pdf.worker') }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loadPdf when the deployment under it changed', () => {
  test('a hung open with the worker file gone is reported as a stale tab', async () => {
    state.workerAlive = false;
    const run = loadPdf(bytes);
    run.catch(() => {});
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(run).rejects.toBeInstanceOf(ViewerFilesGoneError);
  });

  test('a dead worker is replaced once before giving up', async () => {
    state.workerAlive = true;
    const run = loadPdf(bytes);
    run.catch(() => {});
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(run).rejects.toThrow(/did not start/);
  });

  test('a damaged PDF is reported as itself, not as a stale tab', async () => {
    state.open = () => Promise.reject(new Error('Invalid PDF structure'));
    await expect(loadPdf(bytes)).rejects.toThrow('Invalid PDF structure');
  });

  test('a character map that cannot be fetched is a stale tab even if the worker is fine', async () => {
    state.open = () => Promise.reject(new Error('Unable to load CMap data at: /pdfjs/cmaps/Adobe-Japan1-0.bcmap'));
    await expect(loadPdf(bytes)).rejects.toBeInstanceOf(ViewerFilesGoneError);
  });

  test('a working open is handed straight back', async () => {
    const pdf = { numPages: 2 } as never;
    state.open = (() => Promise.resolve(pdf)) as never;
    await expect(loadPdf(bytes)).resolves.toBe(pdf);
  });
});
