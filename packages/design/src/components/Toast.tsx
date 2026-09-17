import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { cn } from '../cn.js';

export interface ToastItem {
  id: number;
  text: string;
  tone: 'neutral' | 'danger' | 'success';
}

const ToastCtx = createContext<{ push: (text: string, tone?: ToastItem['tone']) => void } | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: ToastItem['tone'] = 'neutral') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'animate-rise rounded-full px-4 py-2 text-sm shadow-pop',
              t.tone === 'neutral' && 'bg-fg text-bg',
              t.tone === 'danger' && 'bg-danger text-white',
              t.tone === 'success' && 'bg-success text-white',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx.push;
}
