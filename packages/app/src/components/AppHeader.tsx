import { avatarHue } from '@pen/contracts';
import { Avatar, cn } from '@pen/design';
import { Menu, Moon, PanelLeft, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useApp } from '../lib/context.js';
import { isDarkTheme, useTheme } from '../lib/theme.js';
import { NameDialog } from './NameDialog.js';

/** The nib: Pen's mark. Ink on the left, a drop of the brand where the stroke lands. */
export function PenMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M5.5 18.5 15.2 8.8a2.2 2.2 0 0 1 3.1 0l.4.4a2.2 2.2 0 0 1 0 3.1L9 22l-4.3 1 1-4.5Z"
        fill="currentColor"
      />
      <path
        d="M6.2 17.8 8.4 20"
        stroke="var(--color-surface)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="17.5" cy="5" r="2.6" fill="var(--color-primary-fixed)" />
    </svg>
  );
}

/**
 * The header's primary links, as M3 navigation items: a filled pill when the
 * route is the one you are on (`secondary-container` / `on-secondary-container`,
 * the navigation-drawer active indicator), and a state layer the rest of the
 * time rather than a second colour.
 */
const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    'state-layer relative rounded-full px-4 py-1.5 text-label-large transition-colors duration-[var(--duration-fast)]',
    isActive ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant',
  );

export interface AppHeaderProps {
  sticky?: boolean;
  /** Opens the small-screen sidebar drawer; absent outside the shell. */
  onMenu?: () => void;
  /** Collapses the sidebar to the icon rail (wide screens only). */
  onToggleSidebar?: () => void;
  sidebarRail?: boolean;
}

export function AppHeader({
  sticky = true,
  onMenu,
  onToggleSidebar,
  sidebarRail = false,
}: AppHeaderProps) {
  const { participant } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useTheme();
  const [naming, setNaming] = useState(false);
  const dark = isDarkTheme(theme);
  // Identity lives in one place: this chip. Anonymous is signed out — the row
  // the sidebar used to carry is gone, and a learner with a name but no Google
  // account still reaches the same sheet through "Sign in".
  const signedIn = participant !== null && !participant.anonymous;

  // Anything that asks for the account sheet (a deep link, a screen) routes through here.
  const wantsSignIn = (location.state as { signIn?: boolean } | null)?.signIn === true;
  useEffect(() => {
    if (wantsSignIn) setNaming(true);
  }, [wantsSignIn]);

  return (
    <header
      className={cn(
        /*
         * Three planes, in order, and the bar is the middle one.
         *
         * It used to share `surface-container-low` with the sidebar and the
         * footer, which made the chrome one undifferentiated slab against a
         * page of a different value — the sidebar's top edge simply
         * disappeared into the bar, and the whole thing read as a smudge
         * rather than as a structure. The owner: *"the top bar should have a
         * different color than other panels."*
         *
         * So the values run content → bar → rails, brightest to deepest:
         * `surface-container-lowest` for the page, `surface` here, and
         * `surface-container-low` for the sidebar and the footer. Nearest the
         * content is nearest its colour, which is also the order of how much
         * you look at them. That is M3's own elevation-by-value, applied to
         * the shell rather than only to cards, and it is why no rule is
         * needed to say where one plane stops.
         *
         * Opaque, not a blurred wash: a translucent bar over a white page is
         * a smear, and the line that used to sit under it was there to make
         * up for being one.
         */
        'z-20 bg-surface',
        sticky && 'sticky top-0',
      )}
    >
      <div className="flex h-16 w-full items-center gap-2 px-4 sm:px-5">
        {onMenu ? (
          <button
            type="button"
            aria-label="Open the sidebar"
            data-testid="sidebar-menu"
            className="state-layer grid size-9 shrink-0 place-items-center rounded-full text-on-surface-variant lg:hidden"
            onClick={onMenu}
          >
            <Menu size={19} />
          </button>
        ) : null}
        {onToggleSidebar ? (
          <button
            type="button"
            aria-label={sidebarRail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-pressed={sidebarRail}
            title={sidebarRail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            data-testid="sidebar-toggle"
            className="state-layer hidden size-9 shrink-0 place-items-center rounded-full text-on-surface-variant lg:grid"
            onClick={onToggleSidebar}
          >
            <PanelLeft size={19} />
          </button>
        ) : null}
        <button
          type="button"
          className="mr-3 flex items-center gap-2 rounded-full py-1 pr-2 pl-1 text-on-surface transition-opacity hover:opacity-80"
          onClick={() => navigate('/')}
          aria-label="Pen Playground home"
        >
          <PenMark />
          {/* A logotype, not a heading: it keeps its own tracking. */}
          <span className="font-display text-title-large font-semibold tracking-[-0.045em]">
            Pen
          </span>
        </button>
        {/* Inside the shell the sidebar is the navigation; a standalone header keeps its own. */}
        <nav
          className={cn('hidden items-center gap-0.5', !onMenu && 'sm:flex')}
          aria-label="Primary"
        >
          <NavLink to="/" end className={link}>
            Explore
          </NavLink>
          <NavLink to="/sessions" className={link}>
            My sessions
          </NavLink>
          <NavLink to="/pricing" className={link}>
            Pricing
          </NavLink>
        </nav>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={dark ? 'Light theme' : 'Dark theme'}
          className="state-layer grid size-9 place-items-center rounded-full text-on-surface-variant"
          onClick={() => setTheme(dark ? 'light' : 'dark')}
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        {signedIn && participant ? (
          <button
            type="button"
            className="state-layer ml-1 flex h-9 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-label-large text-on-surface"
            onClick={() => setNaming(true)}
            aria-label={`Your account, ${participant.name}`}
            data-testid="account-chip"
          >
            <Avatar
              name={participant.name}
              hue={hueOf(participant.id)}
              src={participant.avatarUrl}
              initials={firstLetterOf(participant.name)}
              size={28}
            />
            <span className="max-w-[120px] truncate">{firstNameOf(participant.name)}</span>
          </button>
        ) : (
          <button
            type="button"
            /* M3 filled button: for a signed-out visitor this is the highest-emphasis action on the page, and the only place the chrome carries the brand. */
            className="state-layer ml-1 flex h-9 items-center rounded-full bg-primary-fixed px-4 text-label-large text-on-primary-fixed"
            onClick={() => setNaming(true)}
            data-testid="account-chip"
          >
            Sign in
          </button>
        )}
        <NameDialog open={naming} onClose={() => setNaming(false)} />
      </div>
    </header>
  );
}

/** The name other apps show beside the avatar: the first word of it, and only that. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

/** The letter a picture-less avatar carries: the first of the first name, upper case. */
export function firstLetterOf(name: string): string {
  return (firstNameOf(name)[0] ?? '?').toUpperCase();
}

/**
 * The same hash the room uses, not a second one that looks like it.
 *
 * This took the modulus on every step; `hueFor` coerces to uint32 and takes
 * it once. For most ids the two disagree, so the very same person was one
 * colour on the header chip and a different colour on their tile in the
 * room — the one place a person sees both at once. An avatar's colour is an
 * identity, and there can only be one of it.
 */
const hueOf = avatarHue;
