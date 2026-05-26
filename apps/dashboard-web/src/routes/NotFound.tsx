import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFound(): ReactElement {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 p-8 text-sm">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">404</div>
      <div className="text-2xl font-semibold">Diese Ansicht gibt es nicht.</div>
      <div className="text-muted-foreground">
        Die URL passt zu keiner Route. Vermutlich ein veralteter Link oder ein Tippfehler.
      </div>
      <Button asChild>
        <Link to="/">Zurück zu Mission Control</Link>
      </Button>
    </div>
  );
}
