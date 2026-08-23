import { useI18n } from '../i18n';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div
      className={compact ? 'locale-switch locale-switch-compact' : 'locale-switch'}
      role="group"
      aria-label={t('common.language')}
    >
      <button type="button" aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>
        中
      </button>
      <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
        EN
      </button>
    </div>
  );
}
