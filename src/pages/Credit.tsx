/** A page that credits the work and says, plainly, how this was built. */
import { useI18n } from '../app/i18n';
import { Link } from '../app/router';
import { FlagKH, IconSparkle } from '../components/icons';

const STACK = [
  { name: 'React 19', why: 'the interface' },
  { name: 'Vite 8 + TypeScript', why: 'the build' },
  { name: 'pdf.js 6', why: 'reading and writing PDF' },
  { name: 'HarfBuzz (WebAssembly)', why: 'shaping Khmer, and other scripts, correctly' },
  { name: 'Khmer OS fonts', why: 'the Cambodian typography, by Danh Hong and the KhmerOS project' },
  { name: 'Google Fonts', why: 'everything else, fetched only when a document needs it' },
];

export function Credit() {
  const { t } = useI18n();
  return (
    <section className="sec sec--top credit">
      <h1 className="h1">{t('credit.title')}</h1>
      <p className="lead">{t('credit.sub')}</p>

      <div className="credit__card">
        <h2 className="h2">
          <IconSparkle size={20} /> {t('credit.ai.title')}
        </h2>
        <p>{t('credit.ai.body')}</p>
        <p className="credit__truth">{t('credit.ai.truth')}</p>
      </div>

      <h2 className="h2 credit__h">{t('credit.stack')}</h2>
      <ul className="credit__stack">
        {STACK.map((item) => (
          <li key={item.name}>
            <b>{item.name}</b>
            <span>{item.why}</span>
          </li>
        ))}
      </ul>

      <div className="credit__card">
        <h2 className="h2">
          <FlagKH size={20} /> {t('credit.thanks.title')}
        </h2>
        <p>{t('credit.thanks.body')}</p>
      </div>

      <p className="credit__foot">
        {t('credit.licence')}{' '}
        <a className="ftr__link" href="/fonts/NOTICE.txt" target="_blank" rel="noopener">
          {t('footer.licences')}
        </a>
      </p>

      <Link to="/" className="btn btn--ghost btn--sm">
        {t('nav.home')}
      </Link>
    </section>
  );
}
