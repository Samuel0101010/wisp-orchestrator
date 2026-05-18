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
  /**
   * Auto-dismiss after this many ms. Defaults to 4000. Pass a larger value
   * (e.g. 180000) for long-lived "in-progress" toasts that should remain
   * visible while a slow operation runs; dismiss manually via the returned id.
   */
  duration?: number;
}

type Listener = (items: ToastItem[]) => void;

const listeners = new Set<Listener>();
let items: ToastItem[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l(items);
}

export function toast(input: ToastInput): number {
  const id = nextId++;
  const { duration = 4000, ...rest } = input;
  items = [...items, { id, ...rest }];
  emit();
  const handle = setTimeout(() => {
    timers.delete(id);
    items = items.filter((t) => t.id !== id);
    emit();
  }, duration);
  timers.set(id, handle);
  return id;
}

export function dismissToast(id: number): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    timers.delete(id);
  }
  items = items.filter((t) => t.id !== id);
  emit();
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
