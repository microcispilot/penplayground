import { ToastProvider } from '@pen/design';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AppProvider } from './lib/context.js';
import type { Platform } from './platform/types.js';
import { Home } from './screens/Home.js';
import { Library } from './screens/Library.js';
import { NotFound } from './screens/NotFound.js';
import { Pricing } from './screens/Pricing.js';
import { Replay } from './screens/Replay.js';
import { Room } from './screens/Room.js';
import { SessionPage } from './screens/SessionPage.js';

/** The whole product. Hosts render this once with their Platform. */
export function PenApp({ platform }: { platform: Platform }) {
  return (
    <AppProvider platform={platform}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/sessions" element={<Library />} />
            <Route path="/sessions/:id" element={<SessionPage />} />
            <Route path="/room/:id" element={<Room />} />
            <Route path="/replay/:id" element={<Replay />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AppProvider>
  );
}
