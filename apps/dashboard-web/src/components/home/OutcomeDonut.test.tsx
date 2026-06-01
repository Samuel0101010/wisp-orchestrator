import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutcomeDonut } from './OutcomeDonut';
import i18n from '@/i18n';

describe('OutcomeDonut', () => {
  it('folds budget_exceeded into the failure bucket (not dropped, not raw)', () => {
    // success:1 + budget_exceeded:3 → total 4 (≤5 ⇒ stat-row path). The fold makes
    // failure=3 the dominant slice; WITHOUT the fold, budget_exceeded would vanish
    // from the donut and success(1) would dominate / the total would undercount.
    render(<OutcomeDonut counts={{ success: 1, budget_exceeded: 3 }} />);
    const row = screen.getByTestId('outcome-stat-row');
    expect(row).toHaveTextContent(i18n.t('home.outcomeDonut.labels.failure'));
    expect(row).toHaveTextContent('3');
    // never leak the raw enum token, and success must NOT be the dominant slice
    expect(row).not.toHaveTextContent('budget_exceeded');
    expect(row).not.toHaveTextContent(i18n.t('home.outcomeDonut.labels.success'));
  });

  it('renders the empty state when there are no completed runs', () => {
    render(<OutcomeDonut counts={{}} />);
    expect(screen.getByText(i18n.t('home.outcomeDonut.empty'))).toBeInTheDocument();
  });
});
