import { Button } from '@pen/design';
import { useNavigate } from 'react-router';

export function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-1 flex-col">
      <div className="grid flex-1 place-items-center px-7 py-24">
        <div className="flex flex-col items-center gap-3 text-center">
          <h2>That page isn't on the board.</h2>
          <p className="text-sm text-fg-2">The link may be old, or the session was private.</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to Explore
          </Button>
        </div>
      </div>
    </div>
  );
}
