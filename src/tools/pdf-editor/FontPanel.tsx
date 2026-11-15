/** The "Fonts in this PDF" drawer: what each font was matched to, and ways to fix a poor match. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Key, useI18n } from '../../app/i18n';
import { IconCheck, IconClose, IconDevice, IconSearch, IconShapes, IconUpload, IconWarn } from '../../components/icons';
import type { DocFont, EditorDocument } from '../../engine/document';
import type { CatalogEntry } from '../../engine/font/library';
import { fontOptions } from './edits';
import { FontGroup, Quality, groupFonts } from './fontquality';
import { fontStyle } from './fontface';
import type { EditorStore, FontActionError } from './store';

/** A short piece of the document's own text drawn with this font. */
function sampleText(doc: EditorDocument, fonts: DocFont[]): string {
  let best = '';
  for (const df of fonts.slice(0, 4)) {
    for (const page of df.pages.slice(0, 3)) {
      const lines = doc.lines(page);
      const hit = lines.find((l) => l.fonts[0] === df.font && l.text.trim().length > 1) ?? lines.find((l) => l.fonts.includes(df.font) && l.text.trim().length > 1);
      if (!hit) continue;
      const text = hit.text.trim().slice(0, 60);
      if (text.length >= 8) return text;
      if (text.length > best.length) best = text;
    }
  }
  return best;
}

/** Where a matched font comes from, in the reader's language. */
export function sourceLabel(e: CatalogEntry, t: (k: Key) => string): string {
  const cut = e.label.indexOf(' · ');
  const tail = cut >= 0 ? e.label.slice(cut + 3) : '';
  const join = (head: string) => (tail ? `${head} · ${tail}` : head);
  switch (e.source) {
    case 'bundled':
      return join(t('src.bundled'));
    case 'upload':
      return join(t('src.upload'));
    case 'device':
      return t('src.device');
    case 'google':
      return `${t('src.online')} · Google Fonts`;
    default:
      return tail ? `${t('src.online')} · ${tail}` : e.label;
  }
}

function pagesLabel(pages: number[], t: (k: Key) => string): string {
  if (pages.length === 1) return `${t('f.page')} ${pages[0] + 1}`;
  return `${pages.length} ${t('f.pages')}`;
}

function FontRow({ store, doc, group, fontsVersion }: { store: EditorStore; doc: EditorDocument; group: FontGroup; fontsVersion: number }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const df = group.lead;
  const fonts = group.fonts;
  const q = group.quality;
  const m = df.match;
  const sample = useMemo(() => sampleText(doc, fonts), [doc, group.key, fontsVersion]);
  const options = useMemo(() => fontOptions(doc).filter((o) => o.group !== 'doc'), [doc, fontsVersion]);
  const busy = q === 'searching';
  const comparable = fonts.some((f) => f.font.embedded && !f.font.type3);
  const fail = (code: FontActionError | null) => setError(code ? t(`f.err.${code}` as Key) : null);
  const note: Key | null = q === 'exact' || q === 'searching' ? null : q === 'name' ? 'f.note.name' : q === 'chosen' ? 'f.note.chosen' : q === 'standard' ? 'f.note.standard' : 'f.note.substitute';

  return (
    <li className={`frow is-${q}`}>
      <div className="frow__head">
        <div className="frow__name">
          <b>{df.name.clean || '—'}</b>
          <span>
            {pagesLabel(group.pages, t)}
            {df.font.type3 ? ` · ${t('f.type3')}` : !df.font.embedded ? ` · ${t('f.embedded.no')}` : ''}
          </span>
        </div>
        <span className={`fbadge fbadge--${q}`}>
          {q === 'exact' && <IconCheck size={14} />}
          {(q === 'substitute' || q === 'none') && <IconWarn size={14} />}
          {t(`f.${q}` as Key)}
        </span>
      </div>

      {m && (
        <p className="frow__match">
          <span className="frow__arrow">→</span> <b>{m.entry.family}</b>
          {m.entry.style && m.entry.style !== 'Regular' ? ` ${m.entry.style}` : ''} <span className="frow__src">· {sourceLabel(m.entry, t)}</span>
          {group.total > 0 && (
            <span className="frow__src">
              {' '}
              · {group.verified}/{group.total} {t('f.verified')}
            </span>
          )}
        </p>
      )}
      {sample && (
        <p className="frow__sample" style={fontStyle(m?.font)} dir="auto">
          {sample}
        </p>
      )}
      {note && <p className="frow__note">{t(note)}</p>}

      {q !== 'exact' && (
        <div className="frow__actions">
          <button type="button" className="btn btn--sm btn--dark" disabled={busy} onClick={() => fileRef.current?.click()}>
            <IconUpload size={15} />
            {t('f.upload')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={busy}
            onClick={async () => {
              setError(null);
              const before = fonts.map((f) => f.match?.entry.id);
              await store.searchOnline(fonts);
              if (fonts.every((f, i) => f.match?.quality !== 'exact' && f.match?.entry.id === before[i])) setError(t('f.online.none'));
            }}
          >
            <IconSearch size={15} />
            {t('f.online')}
          </button>
          {comparable && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={async () => {
                setError(null);
                if (!(await store.deepSearch(fonts))) setError(t('f.deep.none'));
              }}
            >
              <IconShapes size={15} />
              {t('f.deep')}
            </button>
          )}
          <select
            className="select select--sm"
            value=""
            disabled={busy}
            onChange={async (e) => {
              const opt = options.find((o) => o.value === e.target.value);
              if (opt) fail(await store.assignFont(fonts, opt.entry.id));
            }}
            aria-label={t('f.choose')}
          >
            <option value="">{t('f.choose')}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".ttf,.otf,.ttc,font/ttf,font/otf,application/x-font-ttf,application/x-font-otf"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) fail(await store.uploadFont(fonts, file));
            }}
          />
        </div>
      )}
      {error && <p className="frow__error">{error}</p>}
    </li>
  );
}

export function FontPanel({ store, doc, fontsVersion, searching, onClose }: { store: EditorStore; doc: EditorDocument; fontsVersion: number; searching: boolean; onClose(): void }) {
  const { t } = useI18n();
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const canQuery = typeof window !== 'undefined' && 'queryLocalFonts' in window;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Exact matches last: what needs attention comes first.
  const order: Record<Quality, number> = { none: 0, substitute: 1, searching: 2, name: 3, standard: 4, chosen: 5, exact: 6 };
  const rows = groupFonts(doc.fonts).sort((a, b) => order[a.quality] - order[b.quality]);
  const exact = rows.filter((g) => g.quality === 'exact').length;

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={t('f.title')}>
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <div>
            <h2>{t('f.title')}</h2>
            <p>{t('f.sub')}</p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label={t('f.close')}>
            <IconClose size={20} />
          </button>
        </div>
        <div className="sheet__body">
          {rows.length === 0 ? (
            <p className="sheet__hint">{t('f.empty')}</p>
          ) : (
            <p className="sheet__sum">
              <span className="fbadge fbadge--exact">
                <IconCheck size={14} />
                {exact}/{rows.length} {t('f.exact')}
              </span>
              {searching && <span className="fbadge fbadge--searching">{t('ed.searching')}</span>}
            </p>
          )}
          <ul className="frows">
            {rows.map((g) => (
              <FontRow key={g.lead.id} store={store} doc={doc} group={g} fontsVersion={fontsVersion} />
            ))}
          </ul>
          <div className="sheet__device">
            <button
              type="button"
              className="btn btn--ghost btn--block"
              disabled={deviceBusy || !canQuery}
              onClick={async () => {
                setDeviceBusy(true);
                const code = await store.useDeviceFonts();
                setDeviceBusy(false);
                setDeviceError(code ? t(`f.err.${code}` as Key) : null);
              }}
            >
              <IconDevice size={18} />
              {t('f.device')}
            </button>
            <p className="sheet__hint">{deviceError ?? (canQuery ? t('f.device.hint') : t('f.err.unsupported'))}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
