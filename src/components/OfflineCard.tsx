/**
 * The "Work offline" card: one button that downloads the whole site into this browser, so every
 * page — the editor included, with its Khmer fonts — opens with no network.
 *
 * The pack is ~12 MB of fonts and pdf.js data, so the card says how big it is *before* the click
 * rather than surprising someone on mobile data, and shows real progress while it runs.
 */
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../app/i18n';
import { offlinePack, registerOffline, type PackProgress } from '../app/offline';
import { IconCheck, IconCloudDownload, IconWarn } from '../components/icons';

const IDLE: PackProgress = { done: 0, total: 0, bytes: 0, state: 'idle' };

const mb = (bytes: number) => (bytes ? `${(bytes / 1e6).toFixed(bytes > 1e7 ? 0 : 1)} MB` : '');

export function OfflineCard() {
  const { t } = useI18n();
  const [progress, setProgress] = useState<PackProgress>(IDLE);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const info = offlinePack.info();
    setSupported(info.supported);
    if (!info.supported) return;
    // Register quietly on load: the worker then keeps the shell warm without anyone asking.
    void registerOffline().catch(() => setSupported(false));
    void offlinePack.installed().then((ready) => {
      if (ready) setProgress((p) => ({ ...p, state: 'ready', total: p.total }));
    });
    const onUpdate = () => setWaiting(true);
    window.addEventListener('xdtools:offline-update', onUpdate);
    return () => window.removeEventListener('xdtools:offline-update', onUpdate);
  }, []);

  const size = offlinePack.size();
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setProgress({ done: 0, total: 0, bytes: 0, state: 'checking' });
    await offlinePack.download(setProgress);
    setBusy(false);
  };

  const clear = async () => {
    setBusy(true);
    await offlinePack.clear();
    setProgress(IDLE);
    setBusy(false);
  };

  return (
    <section className="offline" aria-live="polite">
      <div className="offline__head">
        <span className="offline__icon">
          <IconCloudDownload size={26} />
        </span>
        <div>
          <h2 className="h2">{t('off.title')}</h2>
          <p className="muted">{t('off.sub')}</p>
        </div>
      </div>

      {!supported && <p className="offline__note">{t('off.unsupported')}</p>}

      {waiting && (
        <button type="button" className="btn btn--dark btn--sm offline__update" onClick={() => offlinePack.reload()}>
          {t('off.update')}
        </button>
      )}

      {supported && (
        <>
          <div className="offline__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('off.title')}>
            <span style={{ width: `${progress.state === 'ready' ? 100 : pct}%` }} />
          </div>
          <p className="offline__status">
            {progress.state === 'ready' ? (
              <>
                <IconCheck size={15} /> {t('off.ready')}
              </>
            ) : progress.state === 'downloading' || progress.state === 'checking' ? (
              <>
                {progress.state === 'checking' ? t('off.checking') : `${pct}%  ·  ${progress.done} / ${progress.total}`}
              </>
            ) : progress.state === 'error' ? (
              <>
                <IconWarn size={15} /> {t('off.error')} {progress.error}
              </>
            ) : (
              <>
                {t('off.size')} {mb(size) || '…'}
              </>
            )}
          </p>
          <div className="offline__actions">
            {progress.state === 'ready' ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={clear} disabled={busy}>
                {t('off.clear')}
              </button>
            ) : (
              <button type="button" className="btn btn--dark" onClick={start} disabled={busy}>
                <IconCloudDownload size={18} />
                {busy ? t('off.downloading') : t('off.button')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
