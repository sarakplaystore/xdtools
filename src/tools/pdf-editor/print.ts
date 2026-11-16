/**
 * Sends a PDF to the browser's print dialog.
 *
 * On desktop the file is loaded into a hidden frame and printed from there, so the user stays on
 * the editor. On touch devices, where a hidden frame cannot print, the PDF opens in the tab that
 * was opened synchronously from the tap (so the pop-up is not blocked) and the PDF viewer prints it.
 */

const CLEANUP_MS = 120_000;
const LOAD_TIMEOUT_MS = 20_000;

export type PrintOutcome = 'printed' | 'opened' | 'failed';

/** Opens an empty tab during the user's gesture; it is later pointed at the PDF. */
export function reservePrintTab(): Window | null {
  if (typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches) return null;
  return window.open('', '_blank');
}

function printInFrame(url: string, fallback: () => void): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    frame.remove();
  };
  const timer = window.setTimeout(() => {
    if (!done) {
      finish();
      fallback();
    }
  }, LOAD_TIMEOUT_MS);
  frame.onload = () => {
    window.clearTimeout(timer);
    try {
      const w = frame.contentWindow!;
      w.addEventListener('afterprint', finish, { once: true });
      w.focus();
      w.print();
      // Some browsers never fire `afterprint` for PDF viewers: drop the frame eventually.
      window.setTimeout(finish, CLEANUP_MS);
    } catch {
      finish();
      fallback();
    }
  };
  frame.src = url;
  document.body.appendChild(frame);
}

/** Prints the PDF bytes. `tab` is the window reserved by `reservePrintTab`, if any. */
export function printPdf(bytes: Uint8Array, tab: Window | null): PrintOutcome {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  window.setTimeout(() => URL.revokeObjectURL(url), CLEANUP_MS);
  const openTab = (): PrintOutcome => {
    if (tab && !tab.closed) {
      tab.location.href = url;
      return 'opened';
    }
    const opened = window.open(url, '_blank');
    return opened ? 'opened' : 'failed';
  };
  if (tab) return openTab();
  try {
    printInFrame(url, () => void openTab());
    return 'printed';
  } catch {
    return openTab();
  }
}
