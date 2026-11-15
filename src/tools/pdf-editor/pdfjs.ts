/** pdf.js is used for one thing only: drawing pages on screen. */
import { GlobalWorkerOptions, PDFWorker, RenderingCancelledException, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { isMissingAssetError } from '../../app/chunks';
import { assetUrl } from '../../engine/platform.browser';
import type { Mat, PageGeom } from './geometry';

GlobalWorkerOptions.workerSrc = workerUrl;

let worker: PDFWorker | null = null;

/** A file this deployment should serve is gone: the tab was opened before a newer deployment. */
export class ViewerFilesGoneError extends Error {
  constructor() {
    super('The viewer files this page was built with are no longer on the server');
    this.name = 'ViewerFilesGoneError';
  }
}

/** How long opening a document may take before the viewer files are suspected. */
const OPEN_TIMEOUT_MS = 15_000;

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false; // offline or blocked: the caller already has a failure to report
  }
}

/**
 * Are the viewer files this tab was built with still on the server?
 *
 * After a deployment the old names are gone, and the browser's own complaint is either a bare
 * "Failed to fetch" for the worker (which pdf.js swallows) or a message for a character map that
 * repeats the URL. Probing settles it, and covers both. Both files exist in every build; the
 * character maps under /pdfjs/ keep their names, so the deploy that removes the worker is the odd
 * one out.
 */
async function viewerFilesGone(): Promise<boolean> {
  const files = [workerUrl, assetUrl('pdfjs/cmaps/Adobe-Japan1-0.bcmap')];
  const found = await Promise.all(files.map(exists));
  return found.includes(false);
}

function openDocument(bytes: Uint8Array, w: PDFWorker): Promise<PDFDocumentProxy> {
  const task = getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer it is given
    worker: w,
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('pdfjs/wasm/'),
    iccUrl: assetUrl('pdfjs/iccs/'),
    disableWorkerRendering: true,
  });
  return task.promise;
}

/** Runs one attempt; a document that still arrives after the timeout is closed, not leaked. */
async function withTimeout(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  worker ??= new PDFWorker();
  const attempt = openDocument(bytes, worker);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      done = true;
      reject(new Error('timeout'));
    }, OPEN_TIMEOUT_MS);
  });
  try {
    const pdf = await Promise.race([attempt, timeout]);
    done = true;
    return pdf;
  } finally {
    clearTimeout(timer);
    if (!done) void attempt.then((pdf) => closePdf(pdf), () => {});
  }
}

/**
 * Opens a PDF for viewing. All documents share one worker thread.
 *
 * When this deployment has replaced the one the tab was opened with, the worker file is a 404.
 * pdf.js does not report that: it quietly carries on parsing on the main thread, where this call
 * can then hang for good. So the open is raced against a timeout, and a stall is checked against
 * the files before the error is handed back.
 */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  for (let tries = 0; ; tries++) {
    try {
      return await withTimeout(bytes);
    } catch (err) {
      if (isMissingAssetError(err) || (await viewerFilesGone())) throw new ViewerFilesGoneError();
      const timedOut = err instanceof Error && err.message === 'timeout';
      // A worker that stopped answering is worth replacing once.
      if (timedOut && tries === 0) {
        const dead = worker;
        worker = new PDFWorker();
        void dead?.destroy();
        continue;
      }
      throw timedOut ? new Error('The viewer did not start') : err;
    }
  }
}

export async function pageGeom(pdf: PDFDocumentProxy, index: number): Promise<PageGeom> {
  const page = await pdf.getPage(index + 1);
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height, transform: vp.transform as Mat, viewBox: vp.viewBox as [number, number, number, number] };
}

/** Canvas pixels per CSS pixel: sharp on high-density screens, bounded so phones do not run out of memory. */
function outputScale(width: number, height: number): number {
  let ratio = Math.min(window.devicePixelRatio || 1, 3);
  const maxPixels = 11_000_000;
  if (width * height * ratio * ratio > maxPixels) ratio = Math.sqrt(maxPixels / (width * height));
  return ratio;
}

export interface PageRender {
  promise: Promise<HTMLCanvasElement | null>;
  cancel(): void;
}

/** Renders a page off-screen; resolves with the finished canvas, or null when cancelled. */
export function renderPage(pdf: PDFDocumentProxy, index: number, scale: number): PageRender {
  let task: RenderTask | null = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await pdf.getPage(index + 1);
    if (cancelled) return null;
    const viewport = page.getViewport({ scale });
    const ratio = outputScale(viewport.width, viewport.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width * ratio));
    canvas.height = Math.max(1, Math.round(viewport.height * ratio));
    task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    try {
      await task.promise;
    } catch (err) {
      if (cancelled || err instanceof RenderingCancelledException) return null;
      throw err;
    }
    return cancelled ? null : canvas;
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}

/** Frees a viewer document (its worker-side data and fonts). */
export function closePdf(pdf: PDFDocumentProxy): void {
  void pdf.loadingTask.destroy().catch(() => {});
}
