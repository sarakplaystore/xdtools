import { useI18n } from '../app/i18n';
import { Link } from '../app/router';
import { TOOLS } from '../pages/tools-data';

export function ToolGrid() {
  const { t } = useI18n();
  return (
    <div className="tiles">
      {TOOLS.map((tool) =>
        tool.to ? (
          <Link key={tool.key} to={tool.to} className="tile">
            <span className="tile__icon">{tool.icon}</span>
            <span className="tile__label">{t(tool.key)}</span>
            <span className="tile__badge tile__badge--live">{t('live')}</span>
          </Link>
        ) : (
          <div key={tool.key} className="tile tile--soon" aria-disabled="true">
            <span className="tile__icon">{tool.icon}</span>
            <span className="tile__label">{t(tool.key)}</span>
            <span className="tile__badge">{t('soon')}</span>
          </div>
        ),
      )}
    </div>
  );
}
