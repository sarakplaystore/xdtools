/** pdf.js is used for one thing only: drawing pages on screen. */
import { GlobalWorkerOptions, PDFWorker, RenderingCancelledException, getDocument } from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { assetUrl } from '../../engine/platform.browser';
import type { Mat, PageGeom } from './geometry';

GlobalWorkerOptions.workerSrc = workerUrl;

let worker: PDFWorker | null = null;

/** Opens a PDF for viewing. All documents share one worker thread. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  if (!worker || worker.destroyed) worker = new PDFWorker();
  const task = getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer it is given
    worker,
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('pdfjs/wasm/'),
    iccUrl: assetUrl('pdfjs/iccs/'),
    disableWorkerRendering: true,
  });
  return task.promise;
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
