import { Component, type ErrorInfo, type ReactNode } from 'react';
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
          <div className="text-base font-semibold text-destructive">Etwas ist schiefgegangen.</div>
          <div className="text-muted-foreground">
            Diese Ansicht hat unerwartet einen Fehler ausgelöst. Versuche es erneut — falls es
            wiederholt auftritt, melde es bitte als Issue.
          </div>
          <pre className="overflow-auto rounded bg-muted p-3 text-xs">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <Button onClick={this.reset}>Erneut versuchen</Button>
            <Button variant="secondary" onClick={this.reload}>
              Seite neu laden
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
