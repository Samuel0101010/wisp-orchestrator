import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/ui/icon-button';
import { useUiStore } from '@/store/ui';

export function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const isDark = theme === 'dark';
  return (
    <IconButton
      icon={isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      label={isDark ? t('tooltips.themeLight') : t('tooltips.themeDark')}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      data-testid="theme-toggle"
      className="h-8 w-8"
    />
  );
}
