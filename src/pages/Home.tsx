import { PDF_ROUTE } from '../app/App';
import { useI18n } from '../app/i18n';
import { Link } from '../app/router';
import { ToolGrid } from '../components/ToolGrid';
import { IconChevron, IconFont, IconPdfEdit, IconShield } from '../components/icons';

const BUILT_IN = ['Khmer OS', 'Khmer OS Battambang', 'Khmer OS Siemreap', 'Khmer OS Muol Light', 'Khmer OS Muol', 'Khmer OS Content', 'Khmer OS Bokor', 'Khmer OS Metal Chrieng', 'Battambang', 'Siemreap', 'Moul', 'Hanuman', 'Kantumruy Pro', 'Noto Sans Khmer', 'Koulen'];

export function Home() {
  const { t } = useI18n();
  const cards = [
    { icon: <IconPdfEdit size={44} />, title: t('card.pdf.title'), desc: t('card.pdf.desc') },
    { icon: <IconFont size={44} />, title: t('card.font.title'), desc: t('card.font.desc') },
    { icon: <IconShield size={44} />, title: t('card.private.title'), desc: t('card.private.desc') },
  ];
  return (
    <>
      <section className="hero">
        <span className="badge">
          <i className="badge__dot" />
          {t('hero.badge')}
        </span>
        <h1 className="hero__title">
          {t('hero.title')} <em>{t('hero.title2')}</em>
        </h1>
        <p className="hero__sub">{t('hero.sub')}</p>
        <div className="hero__cta">
          <Link to={PDF_ROUTE} className="btn btn--dark btn--lg">
            <IconPdfEdit size={20} />
            {t('hero.cta')}
          </Link>
          <Link to="/tools" className="btn btn--ghost btn--lg">
            {t('hero.cta2')}
          </Link>
        </div>
        <div className="hero__demo" aria-hidden="true">
          <div className="demo">
            <div className="demo__line demo__line--title">ព្រះរាជាណាចក្រកម្ពុជា</div>
            <div className="demo__line">
              ខ្ញុំបាទឈ្មោះ <span className="demo__edit">សុខ ដារ៉ា</span> កើតថ្ងៃទី១៥
            </div>
            <div className="demo__line demo__line--muted">Font: Khmer OS Battambang · ✓ exact match</div>
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="sec__head">
          <h2 className="h2">{t('home.featured')}</h2>
        </div>
        <div className="cards">
          {cards.map((c, i) => (
            <Link key={i} to={PDF_ROUTE} className="card">
              <span className="card__icon">{c.icon}</span>
              <span className="card__body">
                <span className="card__title">{c.title}</span>
                <span className="card__desc">{c.desc}</span>
              </span>
              <span className="card__go">
                {t('home.open')}
                <IconChevron size={16} />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="sec">
        <div className="sec__head">
          <h2 className="h2">{t('home.tools')}</h2>
          <p className="muted">{t('home.tools.sub')}</p>
        </div>
        <ToolGrid />
      </section>

      <section className="sec">
        <div className="sec__head">
          <h2 className="h2">{t('home.how')}</h2>
        </div>
        <ol className="steps">
          {([1, 2, 3] as const).map((n) => (
            <li key={n} className="step">
              <span className="step__n">{n}</span>
              <div>
                <h3>{t(`how.${n}.t`)}</h3>
                <p>{t(`how.${n}.d`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="sec">
        <div className="sec__head">
          <h2 className="h2">{t('home.fonts')}</h2>
          <p className="muted">{t('home.fonts.sub')}</p>
        </div>
        <div className="chips">
          {BUILT_IN.map((f) => (
            <span key={f} className="chip">
              {f}
            </span>
          ))}
          <span className="chip chip--accent">+ Google Fonts</span>
        </div>
      </section>
    </>
  );
}
