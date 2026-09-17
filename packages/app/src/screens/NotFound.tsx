import { Button } from '@pen/design';
import { useNavigate } from 'react-router';
import { AppHeader } from '../components/AppHeader.js';

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="grid flex-1 place-items-center px-7">
        <div className="flex flex-col items-center gap-3 text-center">
          <h2>That page isn't on the board.</h2>
          <p className="text-sm text-fg-2">The link may be old, or the session was private.</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </main>
    </div>
  );
}
