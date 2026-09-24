import { useNavigate, useParams } from 'react-router';
import { SessionPlayer } from '../components/SessionPlayer.js';

/**
 * The room screen: the live classroom at the whole viewport. Where a host
 * runs a room with guests, and where a direct link to a session lands. The
 * classroom itself is `SessionPlayer` (ADR-0045); the watch page renders the
 * same component inline.
 */
export function Room() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  return (
    <SessionPlayer
      sessionId={id}
      layout="full"
      onExit={() => navigate('/')}
      onOpenSaved={() => navigate(`/sessions/${id}`)}
    />
  );
}
