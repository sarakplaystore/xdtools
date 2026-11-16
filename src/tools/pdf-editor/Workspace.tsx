/** The editing screen: toolbar, pages, font drawer. */
import { CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../app/i18n';
import { setNavigationGuard } from '../../app/router';
import { IconBack, IconCheck, IconCursor, IconDownload, IconFont, IconMinus, IconPlus, IconRedo, IconTextAdd, IconUndo, IconWarn } from '../../components/icons';
import { FontPanel } from './FontPanel';
import { qualityOf, visibleFonts } from './fontquality';
import { PageView } from './PageView';
import { BoxState, RGB, Target, isNoop, withPage } from './edits';
import { screenRightDir } from './geometry';
import type { EditorStore, Snapshot } from './store';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const FALLBACK_FONT = 'b:khmeros/KhmerOS_battambang.ttf';

export function Workspace({ store, snap }: { store: EditorStore; snap: Snapshot }) {
  const { t } = useI18n();
  const doc = snap.doc!;
  const view = snap.view!;
  const [mode, setMode] = useState<'edit' | 'add'>('edit');
  const [selected, setSelected] = useState<Target | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fontsOpen, setFontsOpen] = useState(false);
  const [avail, setAvail] = useState(0);
  const [flash, setFlash] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<Target | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // ---- layout
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = snap.geoms[0]!;
  const fit = avail > 0 ? Math.min(1.5, Math.max(0.15, (avail - 4) / first.width)) : 1;
  const scale = fit * zoom;

  // ---- selection
  const select = useCallback(
    (target: Target | null) => {
      const prev = selectedRef.current;
      if (prev && (!target || prev.kind !== target.kind || prev.id !== target.id || prev.page !== target.page)) {
        // Leave nothing behind that changes nothing: untouched edits and empty text boxes.
        store.update(
          (eds) =>
            withPage(eds, prev.page, (pe) => {
              if (prev.kind === 'line') {
                const e = pe.lines[prev.id];
                const line = store.lines(prev.page).find((l) => l.id === prev.id);
                if (!e || !line || !isNoop(e, line)) return pe;
                const rest = { ...pe.lines };
                delete rest[prev.id];
                return { ...pe, lines: rest };
              }
              const box = pe.boxes.find((b) => b.id === prev.id);
              return box && box.text.trim() === '' ? { ...pe, boxes: pe.boxes.filter((b) => b !== box) } : pe;
            }),
          { silent: true },
        );
      }
      selectedRef.current = target;
      setSelected(target);
      store.breakUndoRun();
    },
    [store],
  );

  // A selected text box can vanish through undo.
  useEffect(() => {
    if (selected?.kind === 'box' && !snap.edits[selected.page]?.boxes.some((b) => b.id === selected.id)) {
      selectedRef.current = null;
      setSelected(null);
    }
  }, [snap.edits, selected]);

  const addBox = useCallback(
    (page: number, x: number, y: number) => {
      const s = snapRef.current;
      const geom = s.geoms[page] ?? s.geoms[0]!;
      // Start from the look of the nearest text on the page.
      let fontId = FALLBACK_FONT;
      let weight = 400;
      let size = 12;
      let color: RGB = [0, 0, 0];
      let best = Infinity;
      for (const line of store.lines(page)) {
        if (!line.text.trim()) continue;
        const d = Math.hypot(line.origin[0] - x, line.origin[1] - y);
        if (d >= best) continue;
        best = d;
        size = Math.round(line.size * 2) / 2;
        color = line.color ?? [0, 0, 0];
        const df = s.doc?.docFont(line.fonts[0]);
        const m = df?.match;
        if (m && s.doc?.library.byId(m.entry.id)) {
          fontId = m.entry.id;
          weight = m.entry.axes?.wght ? (df?.name.weight ?? 400) : m.entry.weight;
        }
      }
      const dir = screenRightDir(geom);
      const normal: [number, number] = [-dir[1], dir[0]];
      // The tap marks the left edge of the text, at mid-height.
      const box: BoxState = { id: `B${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, x: x - normal[0] * size * 0.32, y: y - normal[1] * size * 0.32, dir, text: '', fontId, weight, size, color };
      store.update((eds) => withPage(eds, page, (pe) => ({ ...pe, boxes: [...pe.boxes, box] })));
      select({ kind: 'box', page, id: box.id });
      setMode('edit');
    },
    [store, select],
  );

  const openFonts = useCallback(() => setFontsOpen(true), []);

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (mod && !e.altKey && key === 'y') {
        e.preventDefault();
        store.redo();
      } else if (e.key === 'Escape') {
        if (fontsOpen) setFontsOpen(false);
        else if (selectedRef.current) select(null);
        else setMode('edit');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, select, fontsOpen]);

  // ---- leaving with work that was not downloaded
  const atRisk = snap.unsaved && snap.changes > 0;
  useEffect(() => {
    if (!atRisk) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    setNavigationGuard(() => t('ed.unsaved'));
    return () => {
      window.removeEventListener('beforeunload', warn);
      setNavigationGuard(null);
    };
  }, [atRisk, t]);

  const closeFile = () => {
    if (atRisk && !window.confirm(t('ed.unsaved'))) return;
    store.close();
  };

  const download = async () => {
    select(null);
    const out = await store.exportPdf();
    if (!out) return;
    const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = out.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setFlash(true);
    setTimeout(() => setFlash(false), 2500);
  };

  const stepZoom = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => Math.abs(z - zoom) < 1e-6);
    const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir))];
    setZoom(next);
  };

  // ---- font summary
  const shown = visibleFonts(doc.fonts);
  const qualities = shown.map(qualityOf);
  const weak = qualities.filter((q) => q === 'substitute' || q === 'none').length;
  const allExact = shown.length > 0 && qualities.every((q) => q === 'exact');
  const tone = weak ? 'warn' : allExact ? 'ok' : 'info';
  void snap.fontsVersion;

  const status = snap.buildFailed ? t('ed.failed') : snap.busy ? t('ed.updating') : flash ? `✓ ${t('ed.saved')}` : snap.changes ? `${snap.changes} ${t(snap.changes === 1 ? 'ed.change' : 'ed.changes')}` : t('ed.nochanges');

  return (
    <div className="ws">
      <div className="tb">
        <div className="tb__row">
          <button type="button" className="iconbtn" onClick={closeFile} title={t('ed.close')} aria-label={t('ed.close')}>
            <IconBack size={20} />
          </button>
          <div className="tb__file">
            <b title={snap.fileName}>{snap.fileName}</b>
            <span className={snap.buildFailed ? 'is-bad' : ''}>
              {snap.pageCount} {snap.pageCount === 1 ? t('f.page') : t('ed.pages')} · {status}
            </span>
          </div>
          <button type="button" className={`btn btn--sm btn--ghost tb__fonts is-${tone}`} onClick={openFonts}>
            <IconFont size={18} />
            <span className="tb__label">{t('ed.fonts')}</span>
            <i className={'dot' + (snap.searching ? ' is-busy' : '')} />
          </button>
          <button type="button" className="btn btn--sm btn--dark" onClick={download} disabled={snap.saving}>
            <IconDownload size={16} />
            {snap.saving ? t('ed.downloading') : t('ed.download')}
          </button>
        </div>
        <div className="tb__row tb__row--tools">
          <div className="seg seg--tools" role="group">
            <button type="button" className={mode === 'edit' ? 'is-on' : ''} onClick={() => setMode('edit')} aria-pressed={mode === 'edit'}>
              <IconCursor size={18} />
              <span>{t('ed.tool.edit')}</span>
            </button>
            <button
              type="button"
              className={mode === 'add' ? 'is-on' : ''}
              onClick={() => {
                select(null);
                setMode(mode === 'add' ? 'edit' : 'add');
              }}
              aria-pressed={mode === 'add'}
            >
              <IconTextAdd size={18} />
              <span>{t('ed.tool.add')}</span>
            </button>
          </div>
          <span className="grow" />
          <div className="tb__group">
            <button type="button" className="iconbtn" disabled={!snap.canUndo} onClick={() => store.undo()} title={t('ed.undo')} aria-label={t('ed.undo')}>
              <IconUndo size={19} />
            </button>
            <button type="button" className="iconbtn" disabled={!snap.canRedo} onClick={() => store.redo()} title={t('ed.redo')} aria-label={t('ed.redo')}>
              <IconRedo size={19} />
            </button>
          </div>
          <div className="tb__group">
            <button type="button" className="iconbtn" disabled={zoom <= ZOOMS[0]} onClick={() => stepZoom(-1)} title={t('ed.zoom.out')} aria-label={t('ed.zoom.out')}>
              <IconMinus size={19} />
            </button>
            <button type="button" className="tb__zoom" onClick={() => setZoom(1)} title={t('ed.fit')}>
              {Math.round(scale * 100)}%
            </button>
            <button type="button" className="iconbtn" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => stepZoom(1)} title={t('ed.zoom.in')} aria-label={t('ed.zoom.in')}>
              <IconPlus size={19} />
            </button>
          </div>
        </div>
      </div>

      <div className="ws__info">
        <p className={'ws__hint' + (mode === 'add' ? ' is-add' : '')}>{mode === 'add' ? t('ed.hint.add') : t('ed.hint.edit')}</p>
        {shown.length > 0 && (
          <button type="button" className={`ws__fonts is-${tone}`} onClick={openFonts}>
            {tone === 'ok' ? <IconCheck size={15} /> : tone === 'warn' ? <IconWarn size={15} /> : <IconFont size={15} />}
            <span>{tone === 'ok' ? `${t('f.all.ok')}: ${[...new Set(shown.map((f) => f.match?.entry.family ?? ''))].filter(Boolean).join(', ')}` : tone === 'warn' ? `${t('ed.fonts.warn')} ${t('p.s.fix')} ›` : `${t('ed.fonts')} ›`}</span>
          </button>
        )}
        {snap.viewerGone && (
          <div className="notice notice--error notice--block">
            <p>{t('ed.stale.open')}</p>
            <button type="button" className="btn btn--dark btn--sm" onClick={download}>
              {t('ed.download')}
            </button>
          </div>
        )}
        {doc.encrypted && <p className="ws__enc">{t('ed.encrypted')}</p>}
      </div>

      <div ref={stageRef} className="stage" style={{ '--stage-w': `${avail}px` } as CSSProperties}>
        {avail > 0 &&
          Array.from({ length: snap.pageCount }, (_, i) => (
            <PageView
              key={i}
              store={store}
              doc={doc}
              index={i}
              geom={snap.geoms[i] ?? first}
              scale={scale}
              pdf={view.pdf}
              stamp={view.stamps[i] ?? ''}
              outcomes={view.outcomes.get(i)}
              edits={snap.edits[i]}
              mode={mode}
              selected={selected && selected.page === i ? selected : null}
              fontsVersion={snap.fontsVersion}
              frugal={snap.pageCount > 12}
              showNumber={snap.pageCount > 1}
              onSelect={select}
              onAdd={addBox}
              onOpenFonts={openFonts}
            />
          ))}
      </div>

      {fontsOpen && <FontPanel store={store} doc={doc} fontsVersion={snap.fontsVersion} searching={snap.searching} onClose={() => setFontsOpen(false)} />}
    </div>
  );
}
