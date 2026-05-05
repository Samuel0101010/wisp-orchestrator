import * as React from 'react';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

type ToastVariant = 'default' | 'destructive';

interface ToastItem {
  id: number;
  title?: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastInput {
  title?: string;
  description?: string;
  variant?: ToastVariant;
}

type Listener = (items: ToastItem[]) => void;

const listeners = new Set<Listener>();
let items: ToastItem[] = [];
let nextId = 1;

function emit(): void {
  for (const l of listeners) l(items);
}

export function toast(input: ToastInput): void {
  const id = nextId++;
  items = [...items, { id, ...input }];
  emit();
  // Auto-dismiss after 4s.
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 4000);
}

export function useToastItems(): ToastItem[] {
  const [state, setState] = React.useState<ToastItem[]>(items);
  React.useEffect(() => {
    const l: Listener = (next) => setState(next);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

export function ToastViewportRoot(): React.ReactElement {
  const list = useToastItems();
  return (
    <ToastProvider>
      {list.map((t) => (
        <Toast key={t.id} variant={t.variant}>
          <div className="grid gap-1">
            {t.title && <ToastTitle>{t.title}</ToastTitle>}
            {t.description && <ToastDescription>{t.description}</ToastDescription>}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
