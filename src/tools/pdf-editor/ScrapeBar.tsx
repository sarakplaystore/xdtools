/** "Scrape fonts until matched": the start/stop control with live progress and the run summary. */
import { Key, useI18n } from '../../app/i18n';
import { IconCheck, IconSearch, IconWarn } from '../../components/icons';
import type { ScrapePhase } from '../../engine/font/scrape';
import type { EditorStore, ScrapeState } from './store';

const PHASE_KEY: Record<ScrapePhase, Key> = {
  local: 'scrape.phase.local',
  catalog: 'scrape.phase.catalog',
  web: 'scrape.phase.web',
  script: 'scrape.phase.script',
  sweep: 'scrape.phase.sweep',
};

export function ScrapeBar({ store, scrape, canStart, variant }: { store: EditorStore; scrape: ScrapeState | null; canStart: boolean; variant: 'banner' | 'panel' }) {
  const { t } = useI18n();
  const running = !!scrape?.running;
  const pct = scrape && scrape.total
    ? Math.min(100, Math.round(((scrape.index + (scrape.phaseTotal ? scrape.done / scrape.phaseTotal : 0)) / scrape.total) * 100))
    : 0;

  return (
    <div className={`scrape scrape--${variant}`}>
      <div className="scrape__head">
        {!running && (
          <button type="button" className="btn btn--sm btn--dark scrape__start" disabled={!canStart} onClick={() => void store.scrapeFonts()}>
            <IconSearch size={15} />
            {t('scrape.button')}
          </button>
        )}
        {running && (
          <button type="button" className="btn btn--sm btn--ghost scrape__stop" onClick={() => store.stopScrape()}>
            {t('scrape.stop')}
          </button>
        )}
      </div>

      {running && scrape && (
        <div className="scrape__status" aria-live="polite">
          <p className="scrape__now">
            <b>{t('scrape.running')}</b>
            {scrape.current ? ` · ${scrape.current}` : ''}
            {scrape.phase ? ` — ${t(PHASE_KEY[scrape.phase])}` : ''}
          </p>
          <div className="scrape__bar" role="progressbar" aria-label={t('scrape.button')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <p className="scrape__meta">
            {scrape.index}/{scrape.total} {t('scrape.fonts')} · {scrape.probed} {t('scrape.tested')} · {scrape.matched} {t('scrape.matched')}
          </p>
        </div>
      )}

      {!running && scrape?.finished && (
        <p className={`scrape__result${scrape.error ? ' is-bad' : scrape.matched === scrape.total ? ' is-ok' : ''}`}>
          {scrape.error ? (
            <>
              <IconWarn size={14} /> {t('scrape.error')}
            </>
          ) : scrape.stopped ? (
            t('scrape.stopped')
          ) : scrape.matched === scrape.total ? (
            <>
              <IconCheck size={14} /> {scrape.matched}/{scrape.total} {t('scrape.matched')} · {t('scrape.allDone')}
            </>
          ) : (
            <>
              <IconWarn size={14} /> {scrape.matched}/{scrape.total} {t('scrape.matched')} · {t('scrape.none')}
            </>
          )}
        </p>
      )}
    </div>
  );
}
