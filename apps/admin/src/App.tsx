import { ToastProvider } from '@pen/design';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import type { AdminApi } from './lib/api.js';
import { AdminProvider, useAdmin } from './lib/context.js';
import { SignIn } from './screens/SignIn.js';
import { Settings } from './screens/settings/Settings.js';
import { AdminShell, ConsolePage } from './shell/AdminShell.js';

/**
 * The operations console (ADR-0026). One page today — settings — and a shell
 * built so the statistics pages land beside it without touching anything here
 * but the nav array.
 */
export function AdminApp({ api }: { api?: AdminApi } = {}) {
  return (
    <AdminProvider {...(api ? { api } : {})}>
      <ToastProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route element={<RequireAdmin />}>
            <Route element={<AdminShell />}>
              <Route path="/settings" element={<Settings />} />
              <Route path="/" element={<Navigate to="/settings" replace />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </ToastProvider>
    </AdminProvider>
  );
}

/**
 * Nothing behind here renders until the server has said this account may be
 * here. A blank frame rather than a spinner: the check is one request, and a
 * spinner that flashes for 80 ms reads as a fault.
 */
function RequireAdmin() {
  const { checked, session } = useAdmin();
  if (!checked) return <div className="min-h-dvh bg-surface" data-testid="admin-checking" />;
  if (!session.admin) return <Navigate to="/sign-in" replace />;
  return <Outlet />;
}

function NotFound() {
  return (
    <ConsolePage title="Not here" intro="That page does not exist in the console.">
      <div />
    </ConsolePage>
  );
}
