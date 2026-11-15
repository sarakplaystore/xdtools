/** The pop-up under a selected line or text box: the text field and its styling controls. */
import { CSSProperties, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../app/i18n';
import { IconAlignCenter, IconAlignEnd, IconAlignStart, IconCheck, IconMinus, IconPlus, IconTrash, IconUndo, IconWarn } from '../../components/icons';
import type { EditorDocument, Line, LineOutcome } from '../../engine/document';
import type { LoadedFont } from '../../engine/font/hb';
import { BoxState, FontOption, LineEditState, RGB, fontOptions, fontValue, hexToRgb, isNoop, maxLength, rgbToHex, sameColor, withPage } from './edits';
import { fontStyle } from './fontface';
import { qualityOf } from './fontquality';
import type { PageGeom } from './geometry';
import type { EditorStore } from './store';

const PALETTE: RGB[] = [
  [0, 0, 0],
  [0.85, 0.16, 0.13],
  [0.11, 0.31, 0.85],
  [0.02, 0.46, 0.28],
];

function useCatalogFont(doc: EditorDocument, fontId: string | undefined, weight: number | undefined): LoadedFont | null {
  const [font, setFont] = useState<LoadedFont | null>(null);
  useEffect(() => {
    let live = true;
    setFont(null);
    const entry = fontId ? doc.library.byId(fontId) : undefined;
    if (entry) {
      doc.library
        .load(entry, weight)
        .then((f) => live && setFont(f))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [doc, fontId, weight]);
  return font;
}

function Stepper({ value, min, max, step, label, onChange }: { value: number; min: number; max: number; step: number; label: string; onChange(v: number): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = String(Math.round(value * 10) / 10);
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v * 10) / 10));
  const commit = () => {
    if (draft !== null) {
      const v = parseFloat(draft.replace(',', '.'));
      if (Number.isFinite(v)) onChange(clamp(v));
    }
    setDraft(null);
  };
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(clamp(value - step))} disabled={value <= min + 1e-6} aria-label={`${label} −`}>
        <IconMinus size={16} />
      </button>
      <input
        inputMode="decimal"
        aria-label={label}
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <button type="button" onClick={() => onChange(clamp(value + step))} disabled={value >= max - 1e-6} aria-label={`${label} +`}>
        <IconPlus size={16} />
      </button>
    </div>
  );
}

function Swatches({ value, original, onChange }: { value: RGB | undefined; original?: RGB | null; onChange(c: RGB | undefined): void }) {
  const { t } = useI18n();
  const current = value ?? original ?? null;
  const custom = !!value && !PALETTE.some((c) => sameColor(c, value)) && !(original && sameColor(original, value));
  return (
    <div className="swatches">
      {original !== undefined && (
        <button type="button" className={'swatch swatch--orig' + (!value ? ' is-on' : '')} style={{ background: rgbToHex(original ?? [0, 0, 0]) }} onClick={() => onChange(undefined)} title={t('p.color.keep')} aria-label={t('p.color.keep')}>
          <span>A</span>
        </button>
      )}
      {PALETTE.filter((c) => !(original && sameColor(c, original))).map((c) => (
        <button key={rgbToHex(c)} type="button" className={'swatch' + (value && sameColor(c, value) ? ' is-on' : '')} style={{ background: rgbToHex(c) }} onClick={() => onChange(c)} aria-label={rgbToHex(c)} />
      ))}
      <label className={'swatch swatch--custom' + (custom ? ' is-on' : '')} style={custom && current ? ({ '--c': rgbToHex(current) } as CSSProperties) : undefined} title={t('p.color.custom')}>
        <input type="color" value={rgbToHex(current ?? [0, 0, 0])} onChange={(e) => onChange(hexToRgb(e.target.value))} aria-label={t('p.color.custom')} />
      </label>
    </div>
  );
}

function FontSelect({ options, value, auto, onChange }: { options: FontOption[]; value: string; auto?: string; onChange(opt: FontOption | null): void }) {
  const { t } = useI18n();
  const groups: [FontOption['group'], string][] = [
    ['doc', t('p.font.doc')],
    ['user', t('p.font.user')],
    ['builtin', t('p.font.builtin')],
  ];
  return (
    <select className="select" value={value} onChange={(e) => onChange(options.find((o) => o.value === e.target.value) ?? null)}>
      {auto !== undefined && <option value="">{auto}</option>}
      {groups.map(([g, label]) => {
        const list = options.filter((o) => o.group === g);
        return list.length ? (
          <optgroup key={g} label={label}>
            {list.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

function TextField({ value, font, placeholder, onChange, onDone }: { value: string; font: LoadedFont | null; placeholder: string; onChange(v: string): void; onDone(): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight + 2)}px`;
  }, [value, font]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      className="ecard__text"
      rows={1}
      dir="auto"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      placeholder={placeholder}
      value={value}
      style={fontStyle(font)}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' && !e.nativeEvent.isComposing) || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    />
  );
}

function Shell({ style, children }: { style: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Bring the card (and the line just above it) into view without jumping around.
    const id = requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div ref={ref} className="ecard" style={style} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

interface CommonProps {
  store: EditorStore;
  doc: EditorDocument;
  page: number;
  outcome: LineOutcome | undefined;
  /** Changes whenever font matches change, so the lists refresh. */
  fontsVersion: number;
  style: CSSProperties;
  onClose(): void;
}

export function LineCard(props: CommonProps & { line: Line; lines: Line[]; geom: PageGeom | null; edit: LineEditState | undefined; onOpenFonts(): void }) {
  const { store, doc, page, line, lines, geom, edit, outcome, fontsVersion, style, onClose, onOpenFonts } = props;
  const { t } = useI18n();
  const options = useMemo(() => fontOptions(doc), [doc, fontsVersion]);
  const defaultAlign = useMemo(() => store.defaultAlign(page, line), [store, page, line, geom]);
  const align = edit?.align ?? defaultAlign;
  const docFont = doc.docFont(line.fonts[0]);
  const match = docFont?.match ?? null;
  const standard = !!docFont && qualityOf(docFont) === 'standard';
  const override = useCatalogFont(doc, edit?.fontId, edit?.weight);

  const change = (patch: Partial<LineEditState>, tag?: string) =>
    store.update(
      (eds) =>
        withPage(eds, page, (pe) => {
          const cur = pe.lines[line.id] ?? { text: line.text, align: defaultAlign };
          return { ...pe, lines: { ...pe.lines, [line.id]: { ...cur, ...patch } } };
        }),
      { tag: tag ? `${page}:${line.id}:${tag}` : undefined },
    );

  const reset = () =>
    store.update((eds) =>
      withPage(eds, page, (pe) => {
        if (!pe.lines[line.id]) return pe;
        const rest = { ...pe.lines };
        delete rest[line.id];
        return { ...pe, lines: rest };
      }),
    );

  const size = line.size * (edit?.scale ?? 1);
  const length = outcome?.length ?? line.length;
  const room = maxLength(line, lines, align, geom);
  const overflow = !!edit && !edit.fit && length > room + 0.75 && length > line.length + 0.75;

  let tone: 'ok' | 'info' | 'warn' = 'info';
  let status = '';
  let fix = false;
  if (edit?.fontId) status = `${t('p.s.override')}: ${doc.library.byId(edit.fontId)?.family ?? ''}`;
  else if (outcome && outcome.fonts.length) {
    const names = outcome.fonts.join(', ');
    if (outcome.via.includes('substitute') && standard) {
      status = `${t('p.s.standard')} ${names}`;
    } else if (outcome.via.includes('substitute')) {
      tone = 'warn';
      status = `${t('p.s.substitute')}: ${names}`;
      fix = true;
    } else if (outcome.via.every((v) => v === 'embedded')) {
      tone = 'ok';
      status = t('p.s.embedded');
    } else if (match?.quality === 'exact') {
      tone = 'ok';
      status = `${t('p.s.exact')} · ${names}`;
    } else if (match?.chosen) {
      status = `${t('p.s.chosen')} · ${names}`;
    } else {
      status = `${t('p.s.name')} · ${names}`;
      fix = true;
    }
  } else if (match && standard) {
    status = `${t('p.s.standard')} ${match.entry.family}`;
  } else if (!match || match.quality === 'substitute') {
    tone = 'warn';
    status = `${t('p.s.substitute')}${match ? `: ${match.entry.family}` : ''}`;
    fix = true;
  } else if (match.quality === 'exact') {
    tone = 'ok';
    status = `${t('p.s.exact')} · ${match.entry.family}`;
  } else if (match.chosen) {
    status = `${t('p.s.chosen')} · ${match.entry.family}`;
  } else {
    status = `${t('p.s.name')} · ${match.entry.family}`;
    fix = true;
  }

  return (
    <Shell style={style}>
      <TextField value={edit?.text ?? line.text} font={override ?? match?.font ?? null} placeholder={t('p.placeholder')} onChange={(v) => change({ text: v }, 'text')} onDone={onClose} />

      <div className={`ecard__status is-${tone}`}>
        {tone === 'warn' ? <IconWarn size={15} /> : tone === 'ok' ? <IconCheck size={15} /> : null}
        <span>
          {status}
          {fix && (
            <>
              {' '}
              <button type="button" className="ecard__link" onClick={onOpenFonts}>
                {t('p.s.fix')}
              </button>
            </>
          )}
        </span>
      </div>
      {!line.exact && <p className="ecard__note">{t('p.inexact')}</p>}
      {!!outcome?.missing.length && (
        <p className="ecard__note">
          {t('p.missing')} <b>{outcome.missing.join(' ')}</b>
        </p>
      )}
      {overflow && (
        <p className="ecard__note">
          {t('p.overflow')}{' '}
          <button type="button" className="ecard__link" onClick={() => change({ fit: true, fitScale: 1 })}>
            {t('p.fit')}
          </button>
        </p>
      )}

      <div className="ecard__row">
        <label className="field field--grow">
          <span>{t('p.font')}</span>
          <FontSelect
            options={options}
            auto={`${t('p.font.auto')}${match ? ` (${match.entry.family})` : ''}`}
            value={edit?.fontId ? fontValue(edit.fontId, edit.weight ?? 400) : ''}
            onChange={(o) => change({ fontId: o?.entry.id, weight: o?.weight })}
          />
        </label>
        <div className="field">
          <span>{t('p.size')}</span>
          <Stepper label={t('p.size')} value={size} min={2} max={400} step={0.5} onChange={(v) => change({ scale: Math.abs(v - line.size) < 0.05 ? undefined : v / line.size }, 'size')} />
        </div>
      </div>

      <div className="ecard__row">
        <div className="field">
          <span>{t('p.color')}</span>
          <Swatches value={edit?.color} original={line.color} onChange={(c) => change({ color: c }, 'color')} />
        </div>
        <div className="field">
          <span>{t('p.align')}</span>
          <div className="seg" role="group" aria-label={t('p.align')}>
            {(
              [
                [0, t('p.align.start'), <IconAlignStart size={17} key="s" />],
                [0.5, t('p.align.center'), <IconAlignCenter size={17} key="c" />],
                [1, t('p.align.end'), <IconAlignEnd size={17} key="e" />],
              ] as [number, string, ReactNode][]
            ).map(([v, label, icon]) => (
              <button key={v} type="button" className={align === v ? 'is-on' : ''} onClick={() => change({ align: v })} title={label} aria-label={label} aria-pressed={align === v}>
                {icon}
              </button>
            ))}
          </div>
        </div>
        {edit?.fit && (
          <button type="button" className="chipbtn" onClick={() => change({ fit: false, fitScale: undefined })} title={t('p.fit.on')}>
            {t('p.fit.on')} {Math.round((edit.fitScale ?? 1) * 100)}% ✕
          </button>
        )}
      </div>

      <div className="ecard__actions">
        <button type="button" className="btn btn--sm btn--ghost" onClick={reset} disabled={!edit || isNoop(edit, line)}>
          <IconUndo size={15} />
          {t('p.reset')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          onClick={() => {
            change({ text: '' });
            onClose();
          }}
          disabled={(edit?.text ?? line.text) === ''}
        >
          <IconTrash size={15} />
          {t('p.delete')}
        </button>
        <span className="grow" />
        <button type="button" className="btn btn--sm btn--dark" onClick={onClose}>
          <IconCheck size={15} />
          {t('p.done')}
        </button>
      </div>
    </Shell>
  );
}

export function BoxCard(props: CommonProps & { box: BoxState }) {
  const { store, doc, page, box, outcome, fontsVersion, style, onClose } = props;
  const { t } = useI18n();
  const options = useMemo(() => fontOptions(doc), [doc, fontsVersion]);
  const font = useCatalogFont(doc, box.fontId, box.weight);

  const change = (patch: Partial<BoxState>, tag?: string) =>
    store.update((eds) => withPage(eds, page, (pe) => ({ ...pe, boxes: pe.boxes.map((b) => (b.id === box.id ? { ...b, ...patch } : b)) })), {
      tag: tag ? `${page}:${box.id}:${tag}` : undefined,
    });
  const remove = () => {
    store.update((eds) => withPage(eds, page, (pe) => ({ ...pe, boxes: pe.boxes.filter((b) => b.id !== box.id) })));
    onClose();
  };

  return (
    <Shell style={style}>
      <TextField value={box.text} font={font} placeholder={t('p.placeholder')} onChange={(v) => change({ text: v }, 'text')} onDone={onClose} />
      {outcome?.via.includes('substitute') && (
        <div className="ecard__status is-info">
          <span>
            {t('p.s.override')}: {outcome.fonts.join(', ')}
          </span>
        </div>
      )}
      {!!outcome?.missing.length && (
        <p className="ecard__note">
          {t('p.missing')} <b>{outcome.missing.join(' ')}</b>
        </p>
      )}
      <div className="ecard__row">
        <label className="field field--grow">
          <span>{t('p.font')}</span>
          <FontSelect options={options} value={fontValue(box.fontId, box.weight)} onChange={(o) => o && change({ fontId: o.entry.id, weight: o.weight })} />
        </label>
        <div className="field">
          <span>{t('p.size')}</span>
          <Stepper label={t('p.size')} value={box.size} min={2} max={400} step={0.5} onChange={(v) => change({ size: v }, 'size')} />
        </div>
      </div>
      <div className="ecard__row">
        <div className="field">
          <span>{t('p.color')}</span>
          <Swatches value={box.color} onChange={(c) => change({ color: c ?? [0, 0, 0] }, 'color')} />
        </div>
        <p className="ecard__hint">{t('p.move')}</p>
      </div>
      <div className="ecard__actions">
        <button type="button" className="btn btn--sm btn--danger" onClick={remove}>
          <IconTrash size={15} />
          {t('p.delete')}
        </button>
        <span className="grow" />
        <button type="button" className="btn btn--sm btn--dark" onClick={onClose}>
          <IconCheck size={15} />
          {t('p.done')}
        </button>
      </div>
    </Shell>
  );
}
