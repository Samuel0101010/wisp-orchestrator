import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import i18n from '../i18n';
import { LanguageToggle } from './LanguageToggle';

describe('LanguageToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    void i18n.changeLanguage('en');
  });

  it('renders the current language code (EN by default)', () => {
    render(<TooltipProvider><LanguageToggle /></TooltipProvider>);
    const toggle = screen.getByTestId('language-toggle');
    expect(toggle).toHaveTextContent('EN');
  });

  it('opens the menu and lists EN + DE options', () => {
    render(<TooltipProvider><LanguageToggle /></TooltipProvider>);
    fireEvent.click(screen.getByTestId('language-toggle'));
    expect(screen.getByTestId('language-toggle-en')).toHaveTextContent('English');
    expect(screen.getByTestId('language-toggle-de')).toHaveTextContent('Deutsch');
  });

  it('switches to German on click and persists in localStorage', async () => {
    render(<TooltipProvider><LanguageToggle /></TooltipProvider>);
    fireEvent.click(screen.getByTestId('language-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('language-toggle-de'));
    });
    expect(i18n.language).toBe('de');
    expect(localStorage.getItem('agent-harness-lang')).toBe('de');
    expect(screen.getByTestId('language-toggle')).toHaveTextContent('DE');
  });

  it('switches back to English from German', async () => {
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    render(<TooltipProvider><LanguageToggle /></TooltipProvider>);
    fireEvent.click(screen.getByTestId('language-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('language-toggle-en'));
    });
    expect(i18n.language).toBe('en');
    expect(screen.getByTestId('language-toggle')).toHaveTextContent('EN');
  });
});
