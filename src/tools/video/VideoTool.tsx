/** Video shrinker: pick a video → choose the output size → shrink on this device → download. */
import { DragEvent, useEffect, useRef, useState } from 'react';
import { Key, useI18n } from '../../app/i18n';
import { Link } from '../../app/router';
import { IconBack, IconVideo } from '../../components/icons';
import { RESOLUTIONS, Resolution, formatSize } from './plan';
import { VideoError, canShrink, shrinkVideo } from './transcode';
import './video.css';

type Phase =
  | { kind: 'idle' }
  | { kind: 'ready'; file: File }
  | { kind: 'working'; file: File; ratio: number }
  | { kind: 'done'; file: File; url: string; bytes: number; width: number; height: number }
  | { kind: 'error'; file: File; key: Key };

const isVideo = (file: File) => file.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(file.name);

function errorKey(err: unknown): Key {
  if (err instanceof VideoError) {
    if (err.code === 'unsupported') return 'video.err.unsupported';
    if (err.code === 'codec') return 'video.err.codec';
    if (err.code === 'novideo') return 'video.err.novideo';
    if (err.code === 'read') return 'video.err.read';
  }
  return 'video.err.generic';
}

const outputName = (name: string) => `${name.replace(/\.[^.]+$/, '') || 'video'}-small.mp4`;

export function VideoTool() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [resolution, setResolution] = useState<Resolution>(1080);
  const [over, setOver] = useState(false);
  const [notice, setNotice] = useState<Key | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const supported = canShrink();

  // Free the download link when the result goes away, and stop any work when the page closes.
  useEffect(() => {
    return () => {
      if (phase.kind === 'done') URL.revokeObjectURL(phase.url);
    };
  }, [phase]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const choose = (file: File | undefined | null) => {
    if (!file) return;
    if (!isVideo(file)) {
      setNotice('video.notvideo');
      return;
    }
    setNotice(null);
    setPhase({ kind: 'ready', file });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  const run = async (file: File) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: 'working', file, ratio: 0 });
    try {
      const res = await shrinkVideo(file, {
        resolution,
        signal: ctrl.signal,
        onProgress: (ratio) => setPhase((p) => (p.kind === 'working' ? { ...p, ratio } : p)),
      });
      const blob = new Blob([res.bytes as BlobPart], { type: 'video/mp4' });
      setPhase({ kind: 'done', file, url: URL.createObjectURL(blob), bytes: blob.size, width: res.plan.width, height: res.plan.height });
    } catch (err) {
      if (err instanceof VideoError && err.code === 'cancelled') setPhase({ kind: 'ready', file });
      else setPhase({ kind: 'error', file, key: errorKey(err) });
    } finally {
      abortRef.current = null;
    }
  };

  const pickAnother = () => {
    setNotice(null);
    setPhase({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="sec sec--top vtool">
      <Link to="/tools" className="tool__back">
        <IconBack size={16} />
        {t('back')}
      </Link>
      <div className="tool__head">
        <h1 className="h1">{t('video.title')}</h1>
        <p className="tool__sub">{t('video.sub')}</p>
      </div>

      {!supported && <p className="notice notice--error">{t('video.err.unsupported')}</p>}

      {supported && phase.kind === 'idle' && (
        <>
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
              <IconVideo size={56} />
            </span>
            <span className="drop__title">{t('video.drop')}</span>
            <span className="drop__hint">{t('video.drop.hint')}</span>
            <input
              ref={inputRef}
              type="file"
              accept="video/*,.mov,.mp4,.m4v"
              hidden
              onChange={(e) => choose(e.target.files?.[0])}
            />
          </div>
          {notice && <p className="notice notice--error">{t(notice)}</p>}
        </>
      )}

      {supported && phase.kind === 'ready' && (
        <div className="vcard">
          <div className="vcard__file">
            <IconVideo size={28} />
            <div>
              <b className="vcard__name">{phase.file.name}</b>
              <span className="vcard__size">{formatSize(phase.file.size)}</span>
            </div>
          </div>
          <span className="vlabel">{t('video.res')}</span>
          <div className="vres" role="radiogroup" aria-label={t('video.res')}>
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={resolution === r}
                className={'vres__opt' + (resolution === r ? ' is-on' : '')}
                onClick={() => setResolution(r)}
              >
                <b>{t(`video.res.${r}` as Key)}</b>
                <span>{t(`video.res.${r}.hint` as Key)}</span>
              </button>
            ))}
          </div>
          <p className="vcard__keep">{t('video.keep')}</p>
          <div className="vcard__actions">
            <button type="button" className="btn btn--dark btn--lg" onClick={() => run(phase.file)}>
              {t('video.start')}
            </button>
            <button type="button" className="linkbtn" onClick={pickAnother}>
              {t('video.change')}
            </button>
          </div>
        </div>
      )}

      {supported && phase.kind === 'working' && (
        <div className="progress" role="status" aria-live="polite">
          <div className="boot__spin" />
          <p>
            <b>{phase.file.name}</b>
          </p>
          <p>
            {t('video.working')} {Math.round(phase.ratio * 100)}%
          </p>
          <div className="progress__bar">
            <i style={{ width: `${Math.round(phase.ratio * 100)}%` }} />
          </div>
          <button type="button" className="linkbtn" onClick={() => abortRef.current?.abort()}>
            {t('video.cancel')}
          </button>
        </div>
      )}

      {supported && phase.kind === 'done' && (
        <div className="vcard">
          <p className="vdone">{t('video.done')}</p>
          <div className="vstats">
            <div>
              <span>{t('video.before')}</span>
              <b>{formatSize(phase.file.size)}</b>
            </div>
            <div className="vstats__arrow" aria-hidden="true">
              →
            </div>
            <div>
              <span>{t('video.after')}</span>
              <b>
                {formatSize(phase.bytes)}
                {phase.file.size > 0 && phase.bytes < phase.file.size && (
                  <em> −{Math.round((1 - phase.bytes / phase.file.size) * 100)}%</em>
                )}
              </b>
            </div>
          </div>
          <p className="vcard__keep">
            {phase.width} × {phase.height} · {t('video.keep')}
          </p>
          <div className="vcard__actions">
            <a className="btn btn--dark btn--lg" href={phase.url} download={outputName(phase.file.name)}>
              {t('video.download')}
            </a>
            <button type="button" className="linkbtn" onClick={pickAnother}>
              {t('video.again')}
            </button>
          </div>
        </div>
      )}

      {supported && phase.kind === 'error' && (
        <div className="vcard">
          <p className="notice notice--error vcard__error">{t(phase.key)}</p>
          <div className="vcard__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setPhase({ kind: 'ready', file: phase.file })}>
              {t('video.start')}
            </button>
            <button type="button" className="linkbtn" onClick={pickAnother}>
              {t('video.change')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
