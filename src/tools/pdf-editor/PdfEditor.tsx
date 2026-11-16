/** PDF editor tool: file picker → loading → (password) → workspace. */
import { DragEvent, FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Key, useI18n } from '../../app/i18n';
import { Link } from '../../app/router';
import { IconBack, IconLock, IconPdfDrop } from '../../components/icons';
import { assetUrl } from '../../engine/platform.browser';
import { Workspace } from './Workspace';
import { EditorStore } from './store';
import './editor.css';

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function Intro({ store, failed, lost }: { store: EditorStore; failed: boolean; lost: boolean }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<Key | null>(failed ? 'ed.error' : null);
  const [sampleBusy, setSampleBusy] = useState(false);
  // The page outlived a deployment, so its files are gone; nothing can be opened until a reload.
  const stale = lost;

  const take = (file: File | undefined | null) => {
    if (!file) return;
    if (stale) return;
    if (!isPdf(file)) {
      setNotice('ed.notpdf');
      return;
    }
    void store.open(file);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files[0]);
  };
  const openSample = async () => {
    if (stale) return;
    setSampleBusy(true);
    try {
      const res = await fetch(assetUrl('samples/khmer-letter.pdf'));
      if (!res.ok) throw new Error(String(res.status));
      void store.open({ name: 'khmer-sample.pdf', bytes: new Uint8Array(await res.arrayBuffer()) });
    } catch {
      setNotice('ed.error');
      setSampleBusy(false);
    }
  };

  return (
    <>
      {stale && (
        <div className="notice notice--error notice--block">
          <p>{t('ed.stale')}</p>
          <button type="button" className="btn btn--dark btn--sm" onClick={() => window.location.reload()}>
            {t('ed.stale.reload')}
          </button>
        </div>
      )}
      <div
        className={'drop' + (over ? ' is-over' : '')}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="drop__icon">
          <IconPdfDrop size={60} />
        </span>
        <span className="drop__title">{t('ed.drop')}</span>
        <span className="drop__hint">{t('ed.drop.hint')}</span>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {notice && !stale && <p className="notice notice--error">{t(notice)}</p>}
      <div className="tool__sample">
        <button type="button" className="linkbtn" onClick={openSample} disabled={sampleBusy || stale}>
          {t('ed.sample')}
        </button>
      </div>
    </>
  );
}

function Loading({ store, step, detail, name }: { store: EditorStore; step: 'open' | 'fonts' | 'online' | 'render'; detail?: string; name: string }) {
  const { t } = useI18n();
  const pct = { open: 20, fonts: 50, online: 70, render: 90 }[step];
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="boot__spin" />
      <p>
        <b>{name}</b>
      </p>
      <p>
        {t(`ed.step.${step}` as Key)}
        {detail ? ` (${detail})` : ''}
      </p>
      <div className="progress__bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      {step === 'online' && (
        <button type="button" className="linkbtn" onClick={() => store.skipSearch()}>
          {t('ed.skip')}
        </button>
      )}
    </div>
  );
}

function Password({ store, wrong, name }: { store: EditorStore; wrong: boolean; name: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    store.unlock(value);
  };
  return (
    <form className="pw" onSubmit={submit}>
      <span className="drop__icon">
        <IconLock size={46} />
      </span>
      <h2 className="h2">{t('ed.password.title')}</h2>
      <p className="muted">
        {name} — {t('ed.password.text')}
      </p>
      <input className="input" type="password" autoFocus autoComplete="off" placeholder={t('ed.password.ph')} value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={wrong} />
      {wrong && <p className="notice notice--error">{t('ed.password.wrong')}</p>}
      <button type="submit" className="btn btn--dark btn--block">
        {t('ed.password.open')}
      </button>
      <button type="button" className="btn btn--ghost btn--block" onClick={() => store.close()}>
        {t('ed.cancel')}
      </button>
    </form>
  );
}

export function PdfEditor() {
  const { t } = useI18n();
  const [store] = useState(() => new EditorStore());
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => () => store.close(), [store]);

  // A PDF dropped anywhere on the page opens too (when no file is being edited).
  const stage = snap.stage;
  useEffect(() => {
    if (stage.kind !== 'idle') return;
    const stop = (e: globalThis.DragEvent) => e.preventDefault();
    const drop = (e: globalThis.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file && isPdf(file)) void store.open(file);
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', drop);
    };
  }, [stage.kind, store]);

  if (stage.kind === 'ready' && snap.doc && snap.view) return <Workspace store={store} snap={snap} />;

  return (
    <div className="tool">
      <Link to="/tools" className="tool__back">
        <IconBack size={16} />
        {t('back')}
      </Link>
      <div className="tool__head">
        <h1 className="h1">{t('ed.title')}</h1>
        <p className="tool__sub">{t('ed.sub')}</p>
        <span className="pill">{t('ed.pill')}</span>
      </div>
      {stage.kind === 'idle' && <Intro key={stage.error ? 'e' : 'i'} store={store} failed={!!stage.error} lost={!!stage.lost} />}
      {stage.kind === 'loading' && <Loading store={store} step={stage.step} detail={stage.detail} name={snap.fileName} />}
      {stage.kind === 'password' && <Password key={String(stage.wrong)} store={store} wrong={stage.wrong} name={snap.fileName} />}
    </div>
  );
}
