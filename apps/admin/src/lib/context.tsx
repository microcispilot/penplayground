import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { AdminApi, type AdminSession } from './api.js';
import { forgetGoogleSelection } from './google.js';

/**
 * Who is here, and the one client they reach the API with (ADR-0026).
 *
 * The gate is the server's answer, never a claim in a token: `/api/admin/session`
 * says `admin: true` only for an address on `PEN_ADMIN_EMAILS`, and this
 * console renders nothing behind the sign-in screen until it has said so.
 */
interface AdminContextValue {
  api: AdminApi;
  session: AdminSession;
  /** Null while the first check is in flight. */
  checked: boolean;
  /** The check itself failed (the API is down), as opposed to being refused. */
  unreachable: string | null;
  refresh: () => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAdmin must be used inside <AdminProvider>');
  return value;
}

export function AdminProvider({ children, api }: { children: ReactNode; api?: AdminApi }) {
  const client = useMemo(() => api ?? new AdminApi(), [api]);
  const [session, setSession] = useState<AdminSession>({ admin: false });
  const [checked, setChecked] = useState(false);
  const [unreachable, setUnreachable] = useState<string | null>(null);

  const refresh = useMemo(
    () => async () => {
      try {
        setSession(await client.session());
        setUnreachable(null);
      } catch (error) {
        setSession({ admin: false });
        setUnreachable(error instanceof Error ? error.message : 'The API could not be reached.');
      } finally {
        setChecked(true);
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AdminContextValue>(
    () => ({
      api: client,
      session,
      checked,
      unreachable,
      refresh,
      signOut: () => {
        client.signOut();
        // Otherwise the next visit re-picks the account that was just
        // signed out, which reads as a sign-out that did not work.
        forgetGoogleSelection();
        setSession({ admin: false });
      },
    }),
    [client, session, checked, unreachable, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
