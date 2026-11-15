import { useI18n } from '../app/i18n';
import { ToolGrid } from '../components/ToolGrid';

export function Tools() {
  const { t } = useI18n();
  return (
    <section className="sec sec--top">
      <h1 className="h1">{t('tools.title')}</h1>
      <p className="lead">{t('tools.sub')}</p>
      <ToolGrid />
    </section>
  );
}
