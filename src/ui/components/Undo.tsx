import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAlertActions } from '../../client/hooks';

interface Toast {
  id: number;
  message: string;
  actionId: number;
}

const Ctx = createContext<(message: string, actionId: number) => void>(() => {});

/** Every alert action shows an Undo toast; undo marks the action undone in the log. */
export function UndoProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const { undo } = useAlertActions();
  const seq = useRef(0);

  const show = useCallback((message: string, actionId: number) => {
    setToast({ id: ++seq.current, message, actionId });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 10_000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast.message}</span>
            <button
              className="btn"
              onClick={() => {
                undo.mutate(toast.actionId);
                setToast(null);
              }}
            >
              Undo
            </button>
            <button className="btn ghost" aria-label="Dismiss" onClick={() => setToast(null)}>
              ✕
            </button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

export const useUndoToast = () => useContext(Ctx);
