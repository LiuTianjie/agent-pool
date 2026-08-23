import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { DocumentTitle } from '../components/DocumentTitle';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { useI18n } from '../i18n';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <main className="not-found">
      <DocumentTitle title={t('notFound.title')} />
      <LanguageSwitcher />
      <Brand />
      <span>{t('notFound.code')}</span>
      <h1>{t('notFound.heading')}</h1>
      <Link className="button button-primary" to="/">
        <ArrowLeft aria-hidden="true" /> {t('notFound.back')}
      </Link>
    </main>
  );
}
