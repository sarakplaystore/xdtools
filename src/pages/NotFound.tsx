import { useI18n } from '../app/i18n';
import { Link } from '../app/router';

export function NotFound() {
  const { t } = useI18n();
  return (
    <section className="sec sec--top sec--center">
      <h1 className="h1">{t('nf.title')}</h1>
      <p className="lead">{t('nf.text')}</p>
      <Link to="/" className="btn btn--dark">
        {t('nav.home')}
      </Link>
    </section>
  );
}
