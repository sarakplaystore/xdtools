import { Suspense, lazy, useEffect, useState } from 'react';
import { FlagKH, IconClose, IconGrid, IconHome, IconPdfEdit, Logo } from '../components/icons';
import { Home } from '../pages/Home';
import { NotFound } from '../pages/NotFound';
import { Tools } from '../pages/Tools';
import { PageBoundary, recoverMissingChunk } from './chunks';
import { useI18n } from './i18n';
import { Link, useRouter } from './router';

// The editor pulls in the PDF and font engines; load it only when it is opened.
const PdfEditorPage = lazy(() => import('../pages/PdfEditorPage').catch(recoverMissingChunk));

export const PDF_ROUTE = '/tools/pdf-editor';

function Header({ fixed }: { fixed: boolean }) {
  const { t, lang, setLang } = useI18n();
  const { path } = useRouter();
  const items = [
    { to: '/', label: t('nav.home'), icon: <IconHome size={26} /> },
    { to: '/tools', label: t('nav.tools'), icon: <IconGrid size={26} /> },
    { to: PDF_ROUTE, label: t('nav.pdf'), icon: <IconPdfEdit size={26} /> },
  ];
  return (
    <header className={'hdr' + (fixed ? '' : ' hdr--static')}>
      <div className="hdr__in">
        <Link to="/" className="brand" aria-label="xdtools">
          <Logo size={34} />
          <span className="brand__name">xdtools</span>
        </Link>
        <nav className="nav" aria-label="Main">
          {items.map((it) => (
            <Link key={it.to} to={it.to} className={'nav__item' + (path === it.to ? ' is-active' : '')} aria-current={path === it.to ? 'page' : undefined}>
              <span className="nav__icon">{it.icon}</span>
              <span>{it.label}</span>
            </Link>
          ))}
        </nav>
        <button className="lang" onClick={() => setLang(lang === 'km' ? 'en' : 'km')} aria-label="Switch language">
          {lang === 'km' ? 'EN' : 'ខ្មែរ'}
        </button>
      </div>
    </header>
  );
}

/** Welcome card that closes itself, shown once per browser session. */
function Splash() {
  const { t } = useI18n();
  const { path } = useRouter();
  const [left, setLeft] = useState(() => {
    try {
      return sessionStorage.getItem('xd-splash') ? 0 : 9;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((v) => v - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  useEffect(() => {
    if (left === 0) {
      try {
        sessionStorage.setItem('xd-splash', '1');
      } catch {
        /* ignore */
      }
    }
  }, [left]);
  if (left <= 0 || path !== '/') return null;
  return (
    <div className="splash" role="dialog" aria-label="Welcome">
      <button className="splash__x" onClick={() => setLeft(0)} aria-label="Close">
        <IconClose size={18} />
      </button>
      <div className="splash__icons">
        <span>PDF</span>
        <span>ខ្មែរ</span>
        <span>Aa</span>
      </div>
      <p className="splash__t">
        {t('splash.text')} <b>{t('splash.one')}</b>
      </p>
      <p className="splash__auto">
        {t('splash.auto')} <b>{left}</b> s
      </p>
    </div>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="ftr">
      <div className="ftr__in">
        <div className="brand brand--sm">
          <Logo size={24} />
          <span className="brand__name">xdtools</span>
        </div>
        <p>
          {t('footer.note')}{' '}
          <a className="ftr__link" href="/fonts/NOTICE.txt" target="_blank" rel="noopener">
            {t('footer.licences')}
          </a>
        </p>
        <p className="ftr__made">
          {t('footer.made')} <FlagKH size={18} />
        </p>
      </div>
    </footer>
  );
}

export function App() {
  const { path } = useRouter();
  const { t } = useI18n();
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setBooting(false), 450);
    return () => clearTimeout(id);
  }, []);
  const isEditor = path === PDF_ROUTE;
  let page;
  if (path === '/') page = <Home />;
  else if (path === '/tools') page = <Tools />;
  else if (isEditor) page = <PdfEditorPage />;
  else page = <NotFound />;
  return (
    <>
      {booting && (
        <div className="boot" aria-live="polite">
          <div className="boot__spin" />
          <p>Loading... | សូមរង់ចាំ</p>
        </div>
      )}
      <Header fixed={!isEditor} />
      <main className={'main' + (isEditor ? ' main--wide' : '')}>
        <PageBoundary
          resetKey={path}
          fallback={
            <section className="sec sec--top sec--center" role="alert">
              <h1 className="h1">{t('err.page.title')}</h1>
              <p className="lead">{t('err.page.text')}</p>
              <button type="button" className="btn btn--dark" onClick={() => window.location.reload()}>
                {t('err.page.reload')}
              </button>
            </section>
          }
        >
          <Suspense
            fallback={
              <div className="page-loading">
                <div className="boot__spin" />
                <p>{t('loading')}</p>
              </div>
            }
          >
            {page}
          </Suspense>
        </PageBoundary>
      </main>
      {!isEditor && <Footer />}
      {!isEditor && (
        <Link to={PDF_ROUTE} className="fab">
          <IconPdfEdit size={20} />
          <span>{t('cta.float')}</span>
        </Link>
      )}
      <Splash />
    </>
  );
}
