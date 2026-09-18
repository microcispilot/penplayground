import { Avatar, cn } from '@pen/design';
import { Menu, Moon, PanelLeft, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useApp } from '../lib/context.js';
import { isDarkTheme, useTheme } from '../lib/theme.js';
import { NameDialog } from './NameDialog.js';

/** The nib: Pen's mark. Ink on the left, a drop of aqua where the stroke lands. */
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
      <path d="M6.2 17.8 8.4 20" stroke="var(--color-bg)" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="17.5" cy="5" r="2.6" fill="var(--color-aqua-400)" />
    </svg>
  );
}

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    'relative rounded-full px-3.5 py-1.5 text-[14px] font-medium transition-colors duration-[var(--duration-fast)]',
    isActive ? 'bg-fg/[0.07] text-fg' : 'text-fg-2 hover:bg-fg/[0.05] hover:text-fg',
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
        'z-20 border-b border-line/70 bg-bg/80 backdrop-blur-xl backdrop-saturate-150',
        sticky && 'sticky top-0',
      )}
    >
      <div className="flex h-16 w-full items-center gap-2 px-4 sm:px-5">
        {onMenu ? (
          <button
            type="button"
            aria-label="Open the sidebar"
            data-testid="sidebar-menu"
            className="grid size-9 shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-fg/[0.06] hover:text-fg lg:hidden"
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
            className="hidden size-9 shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-fg/[0.06] hover:text-fg lg:grid"
            onClick={onToggleSidebar}
          >
            <PanelLeft size={19} />
          </button>
        ) : null}
        <button
          type="button"
          className="mr-3 flex items-center gap-2 rounded-full py-1 pr-2 pl-1 text-fg transition-opacity hover:opacity-80"
          onClick={() => navigate('/')}
          aria-label="Pen Playground home"
        >
          <PenMark />
          <span className="font-display text-[21px] font-semibold tracking-[-0.045em]">Pen</span>
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
          className="grid size-9 place-items-center rounded-full text-fg-2 transition-colors hover:bg-fg/[0.06] hover:text-fg"
          onClick={() => setTheme(dark ? 'light' : 'dark')}
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        {signedIn && participant ? (
          <button
            type="button"
            className="ml-1 flex h-9 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-[14px] font-medium text-fg transition-colors hover:bg-fg/[0.06]"
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
            className="ml-1 flex h-9 items-center rounded-full bg-accent-soft px-3.5 text-[14px] font-medium text-accent-strong transition-colors hover:bg-accent/25"
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

function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
