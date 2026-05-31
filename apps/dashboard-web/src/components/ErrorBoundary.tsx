import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '@/i18n';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  reload = (): void => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" className="mx-auto flex max-w-lg flex-col gap-4 p-8 text-sm">
          <div className="text-base font-semibold text-destructive">
            {i18n.t('errorBoundary.title', 'Something went wrong.')}
          </div>
          <div className="text-muted-foreground">
            {i18n.t(
              'errorBoundary.body',
              'This view encountered an unexpected error. Try again — if it persists, please report it as an issue.',
            )}
          </div>
          <pre className="overflow-auto rounded bg-muted p-3 text-xs">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <Button onClick={this.reset}>{i18n.t('errorBoundary.retry', 'Try again')}</Button>
            <Button variant="secondary" onClick={this.reload}>
              {i18n.t('errorBoundary.reload', 'Reload page')}
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
