/** One page: the rendered canvas, the clickable outlines over its text, and the edit card. */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { CSSProperties, PointerEvent as ReactPointerEvent, RefObject, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../app/i18n';
import type { EditorDocument, Line, LineOutcome } from '../../engine/document';
import { BoxCard, LineCard } from './EditCard';
import { BoxState, PageEdits, Target, effectiveScale, isNoop, withPage } from './edits';
import { Band, PageGeom, Pt, bandQuad, bounds, pointsAttr, toPdf, vecToPdf } from './geometry';
import { renderPage } from './pdfjs';
import type { EditorStore } from './store';

const NO_LINES: Line[] = [];

function useNear(ref: RefObject<Element | null>, margin: number): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setNear(entries[entries.length - 1].isIntersecting), { rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return near;
}

export interface PageViewProps {
  store: EditorStore;
  doc: EditorDocument;
  index: number;
  geom: PageGeom;
  scale: number;
  pdf: PDFDocumentProxy;
  /** Signature of the edits baked into `pdf` for this page; the canvas is redrawn when it changes. */
  stamp: string;
  outcomes: Map<string, LineOutcome> | undefined;
  edits: PageEdits | undefined;
  mode: 'edit' | 'add';
  /** The selection, when it is on this page. */
  selected: Target | null;
  fontsVersion: number;
  /** Long documents: drop the bitmaps of pages that are far from view. */
  frugal: boolean;
  showNumber: boolean;
  onSelect(target: Target | null): void;
  onAdd(page: number, x: number, y: number): void;
  onOpenFonts(): void;
}

interface Drag {
  id: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  moved: boolean;
}

export const PageView = memo(function PageView(props: PageViewProps) {
  const { store, doc, index, geom, scale, pdf, stamp, outcomes, edits, mode, selected, fontsVersion, frugal, showNumber, onSelect, onAdd, onOpenFonts } = props;
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef(pdf);
  pdfRef.current = pdf;
  const near = useNear(rootRef, 1000);
  const [painted, setPainted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const width = geom.width * scale;
  const height = geom.height * scale;

  // ---- canvas
  useEffect(() => {
    if (!near) return;
    let live = true;
    const job = renderPage(pdfRef.current, index, scale);
    job.promise
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (!live || !bitmap || !canvas) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        setPainted(true);
      })
      .catch((err) => {
        // Usually the document was replaced mid-render; try again with the current one.
        if (live && attempt < 3) setTimeout(() => live && setAttempt((n) => n + 1), 150);
        else if (live) console.warn('Page render failed', err);
      });
    return () => {
      live = false;
      job.cancel();
    };
  }, [near, index, scale, stamp, attempt]);

  useEffect(() => {
    if (near || !frugal) return;
    const canvas = canvasRef.current;
    if (canvas && canvas.width > 1) {
      canvas.width = 1;
      canvas.height = 1;
      setPainted(false);
    }
  }, [near, frugal]);

  // ---- overlay geometry
  const lines = useMemo(() => (near ? store.lines(index) : NO_LINES), [near, store, index, doc, fontsVersion]);

  const lineItems = useMemo(() => {
    const pad = 1.5 / scale;
    const out: { line: Line; quad: Pt[]; edited: boolean }[] = [];
    for (const line of lines) {
      const e = edits?.lines[line.id];
      if (line.text.trim() === '' && !e) continue;
      const oc = e ? outcomes?.get(line.id) : undefined;
      const k = e ? effectiveScale(e) : 1;
      const length = Math.max(oc ? oc.length : line.length, line.size * 0.6);
      const band: Band = {
        origin: line.origin, dir: line.dir, normal: line.normal,
        start: (oc?.offset ?? 0) - pad, length: length + 2 * pad, ascent: line.ascent * k + pad, descent: line.descent * k + pad,
      };
      out.push({ line, quad: bandQuad(geom, scale, band), edited: !!e && !isNoop(e, line) });
    }
    return out;
  }, [lines, edits, outcomes, geom, scale]);

  const boxItems = useMemo(() => {
    const pad = 2 / scale;
    return (edits?.boxes ?? []).map((box) => {
      const oc = outcomes?.get(box.id);
      const length = Math.max(oc?.length ?? box.size * 0.55 * Array.from(box.text).length, box.size * 1.6);
      const band: Band = {
        origin: [box.x, box.y], dir: box.dir, normal: [-box.dir[1], box.dir[0]],
        start: -pad, length: length + 2 * pad, ascent: box.size * 1.05 + pad, descent: box.size * 0.45 + pad,
      };
      return { box, quad: bandQuad(geom, scale, band) };
    });
  }, [edits, outcomes, geom, scale]);

  // ---- interactions
  const pagePoint = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onBackground = (e: React.MouseEvent) => {
    if (mode === 'add') {
      const [px, py] = pagePoint(e);
      const [x, y] = toPdf(geom, scale, px, py);
      onAdd(index, x, y);
    } else if (selected) onSelect(null);
  };

  const moveBox = (box: BoxState, dx: number, dy: number) => {
    const [vx, vy] = vecToPdf(geom, scale, dx, dy);
    store.update((eds) => withPage(eds, index, (pe) => ({ ...pe, boxes: pe.boxes.map((b) => (b.id === box.id ? { ...b, x: b.x + vx, y: b.y + vy } : b)) })), { now: true });
  };

  const boxPointer = {
    down: (box: BoxState) => (e: ReactPointerEvent<SVGPolygonElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { id: box.id, x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false };
    },
    move: (e: ReactPointerEvent<SVGPolygonElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      dragRef.current = { ...d, dx, dy, moved: true };
      setDrag(dragRef.current);
    },
    up: (box: BoxState) => (e: ReactPointerEvent<SVGPolygonElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      e.stopPropagation();
      if (d.moved) moveBox(box, d.dx, d.dy);
      else onSelect({ kind: 'box', page: index, id: box.id });
    },
    cancel: () => {
      dragRef.current = null;
      setDrag(null);
    },
  };

  // ---- the card for the selected line / box
  let card = null;
  if (selected) {
    const place = (quad: Pt[]): CSSProperties => {
      const b = bounds(quad);
      return { '--x': `${Math.max(0, b.x0 - 6).toFixed(1)}px`, '--y': `${(b.y1 + 10).toFixed(1)}px` } as CSSProperties;
    };
    if (selected.kind === 'line') {
      const item = lineItems.find((it) => it.line.id === selected.id);
      if (item) {
        card = (
          <LineCard
            key={selected.id}
            store={store} doc={doc} page={index} line={item.line} lines={lines} geom={geom}
            edit={edits?.lines[selected.id]} outcome={edits?.lines[selected.id] ? outcomes?.get(selected.id) : undefined}
            fontsVersion={fontsVersion} style={place(item.quad)} onClose={() => onSelect(null)} onOpenFonts={onOpenFonts}
          />
        );
      }
    } else {
      const item = boxItems.find((it) => it.box.id === selected.id);
      if (item) {
        card = (
          <BoxCard
            key={selected.id} store={store} doc={doc} page={index} box={item.box} outcome={outcomes?.get(selected.id)}
            fontsVersion={fontsVersion} style={place(item.quad)} onClose={() => onSelect(null)}
          />
        );
      }
    }
  }

  const textless = near && painted && lineItems.length === 0 && !(edits?.boxes.length ?? 0);
  const shared = near && doc.hasSharedText(index);

  return (
    <div className="pgwrap" style={{ width }}>
      {showNumber && (
        <div className="pg__num">
          {t('ed.page')} {index + 1}
        </div>
      )}
      <div ref={rootRef} className={'pg' + (selected ? ' is-active' : '') + (mode === 'add' ? ' is-adding' : '')} style={{ width, height }} data-page={index + 1}>
        <canvas ref={canvasRef} className="pg__canvas" width={1} height={1} />
        {!painted && <div className="pg__wait" />}
        {near && (
          <svg className="pg__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} onClick={onBackground}>
            {mode === 'edit' &&
              lineItems.map(({ line, quad, edited }) => (
                <polygon
                  key={line.id}
                  className={'ln' + (edited ? ' is-edited' : '') + (selected?.kind === 'line' && selected.id === line.id ? ' is-sel' : '')}
                  points={pointsAttr(quad)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect({ kind: 'line', page: index, id: line.id });
                  }}
                >
                  <title>{line.text}</title>
                </polygon>
              ))}
            {boxItems.map(({ box, quad }) => {
              const d = drag && drag.id === box.id ? drag : null;
              return (
                <polygon
                  key={box.id}
                  className={'bx' + (selected?.kind === 'box' && selected.id === box.id ? ' is-sel' : '') + (d ? ' is-drag' : '')}
                  points={pointsAttr(quad)}
                  transform={d ? `translate(${d.dx} ${d.dy})` : undefined}
                  onPointerDown={boxPointer.down(box)}
                  onPointerMove={boxPointer.move}
                  onPointerUp={boxPointer.up(box)}
                  onPointerCancel={boxPointer.cancel}
                  onClick={(e) => e.stopPropagation()}
                />
              );
            })}
          </svg>
        )}
        {card}
      </div>
      {textless && <p className="pg__note">{t('ed.notext')}</p>}
      {shared && !textless && <p className="pg__note">{t('ed.shared')}</p>}
    </div>
  );
});
