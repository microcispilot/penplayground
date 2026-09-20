import { ToastProvider } from '@pen/design';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import type { AdminApi } from './lib/api.js';
import { AdminProvider, useAdmin } from './lib/context.js';
import { SignIn } from './screens/SignIn.js';
import { Settings } from './screens/settings/Settings.js';
import { Audience } from './screens/statistics/Audience.js';
import { Money } from './screens/statistics/Money.js';
import { Overview } from './screens/statistics/Overview.js';
import { People } from './screens/statistics/People.js';
import { Pipeline } from './screens/statistics/Pipeline.js';
import { SessionDetail } from './screens/statistics/SessionDetail.js';
import { Sessions } from './screens/statistics/Sessions.js';
import { Statistics } from './screens/statistics/Statistics.js';
import { UserDetail } from './screens/statistics/UserDetail.js';
import { Visits } from './screens/statistics/Visits.js';
import { AdminShell, ConsolePage } from './shell/AdminShell.js';

/**
 * The operations console (ADR-0026). Two sections: the settings this
 * deployment runs on, and the statistics it produces (ADR-0027). The
 * statistics section owns its own tabs and its own date range, so a page
 * added to it is one line in `Statistics.tsx` and one route here.
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
              <Route path="/statistics" element={<Statistics />}>
                <Route index element={<Overview />} />
                <Route path="money" element={<Money />} />
                <Route path="sessions" element={<Sessions />} />
                <Route path="sessions/:id" element={<SessionDetail />} />
                <Route path="pipeline" element={<Pipeline />} />
                <Route path="people" element={<People />} />
                <Route path="people/:id" element={<UserDetail />} />
                <Route path="visits" element={<Visits />} />
                <Route path="audience" element={<Audience />} />
              </Route>
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
