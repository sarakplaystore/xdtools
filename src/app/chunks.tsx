import { Component, type ReactNode } from 'react';

const KEY = 'xd-chunk-reload';
/** A reload that happened this recently did not help, so do not try it again. */
const RETRY_AFTER_MS = 60_000;

/** pdf.js: `Unable to load ${what} data at: ${url}`; `what` is one of its own fixed names. */
const PDFJS_LOAD = /Unable to load (?:CMap|standard font|wasm|ICC|binary) data at:/i;
/** Chrome, for a lazy page: `error loading dynamically imported module: ${url}`. */
const LAZY_PAGE = /error loading dynamically imported module:\s*\S+\/assets\//i;
/** The browser, for a `fetch()` that got nothing: the whole message is this and nothing else. */
const FETCH_FAILED = /^Failed to fetch$/i;

/**
 * True for a failure that means a file this deployment should serve is not there: a page script,
 * the PDF worker, a font character map, a WebAssembly module.
 *
 * A new deployment renames the hashed files in `/assets/` and deletes the old ones, so a tab
 * opened before it asks for names that no longer exist. Only the wording of the wrapper that
 * failed to load the file is matched — never text that came out of a PDF, which can say anything
 * and must not cost the reader a reload.
 */
export function isMissingAssetError(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e && depth < 4; depth++) {
    const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    if (PDFJS_LOAD.test(msg) || LAZY_PAGE.test(msg) || FETCH_FAILED.test(msg.trim())) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Handles a page script that failed to download.
 *
 * Every deployment gives the script files new names and removes the old ones, so a tab that was
 * opened before a deployment cannot load a page it has not visited yet. Reloading fetches the new
 * names. That is done once; if it was already tried a moment ago, or the device is offline, the
 * error is passed on so the page can say what happened instead of reloading in a loop.
 */
export function recoverMissingChunk(error: unknown): Promise<never> {
  let canReload = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (canReload) {
    try {
      const last = Number(sessionStorage.getItem(KEY)) || 0;
      if (Date.now() - last < RETRY_AFTER_MS) canReload = false;
      else sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      canReload = false; // without storage there is no way to tell a second attempt from the first
    }
  }
  if (!canReload) throw error;
  window.location.reload();
  return new Promise<never>(() => {}); // stay on the loading screen until the reload takes over
}

interface BoundaryProps {
  /** Changing this (the current path) clears the error, so other pages still open. */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  key: string;
  failed: boolean;
}

/** Shows `fallback` instead of an empty screen when a page fails to load or to draw. */
export class PageBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { key: this.props.resetKey, failed: false };

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): BoundaryState | null {
    return state.key === props.resetKey ? null : { key: props.resetKey, failed: false };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
