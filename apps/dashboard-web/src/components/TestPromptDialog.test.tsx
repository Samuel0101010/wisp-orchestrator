import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TestPromptDialog } from './TestPromptDialog';
import type { DraftAgent } from './TeamRoleCard';
import i18n from '@/i18n';

const draft: DraftAgent = {
  role: 'architect',
  model: 'opus',
  allowedTools: ['Read'],
  systemPrompt: 'x'.repeat(60),
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TestPromptDialog open onOpenChange={() => {}} draft={draft} />
    </QueryClientProvider>,
  );
}

// The dialog previously hardcoded every string; it now uses the testPrompt namespace.
describe('TestPromptDialog i18n', () => {
  it('renders localized copy and leaks no raw testPrompt.* keys', () => {
    renderDialog();
    expect(screen.getByText(i18n.t('testPrompt.title', { role: 'architect' }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('testPrompt.sampleGoal'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('testPrompt.runProbe'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('testPrompt.close'))).toBeInTheDocument();
    expect(screen.queryByText(/testPrompt\./)).toBeNull();
  });
});
