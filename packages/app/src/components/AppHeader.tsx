import { avatarHue } from '@pen/contracts';
import { Avatar, cn, PenLogo } from '@pen/design';
import { Menu, Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { trackAction } from '../lib/analytics.js';
import { useApp } from '../lib/context.js';
import { isDarkTheme, useTheme } from '../lib/theme.js';
import { AuthDialog } from './AuthDialog.js';

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
  const { participant, signInOpen, openSignIn, closeSignIn } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, setTheme] = useTheme();
  const dark = isDarkTheme(theme);
  // Identity lives in one place: this chip. Anonymous is signed out — the row
  // the sidebar used to carry is gone, and a learner with a name but no Google
  // account still reaches the same sheet through "Sign in".
  const signedIn = participant !== null && !participant.anonymous;

  // Anything that asks for the account sheet (a deep link, a screen) routes through here.
  const wantsSignIn = (location.state as { signIn?: boolean } | null)?.signIn === true;
  useEffect(() => {
    if (wantsSignIn) openSignIn('link');
  }, [wantsSignIn, openSignIn]);

  return (
    <header
      className={cn(
        /*
         * One plane. The bar, the sidebar and the page are the same surface —
         * `surface-container-lowest`, #ffffff in light and #0e0e0e in dark.
         *
         * This reverses an earlier arrangement, deliberately and on the
         * owner's instruction: *"Remove the top and left side bar backgrounds
         * and they should have the same background of the main background, all
         * same (like YouTube)."* The shell used to climb M3's container ladder
         * — page lowest, rails low, this bar one rung above them — to answer
         * an earlier note that the bar should differ from the other panels.
         * It no longer should. YouTube is the reference and YouTube's masthead,
         * guide and page are one colour; the structure comes from spacing and
         * from where the content starts, not from three greys.
         *
         * Nothing replaces the old contrast. There is no border under the bar
         * and none down the sidebar's edge: adding one would be the same
         * mistake in a thinner form, and the reference does without.
         *
         * Still opaque, and that part is not cosmetic — the bar is sticky, so
         * content scrolls underneath it. `bg-transparent` here would let the
         * page show through rather than inherit anything.
         */
        'z-20 bg-surface-container-lowest',
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
            onClick={() => {
              trackAction('menu_opened');
              onMenu();
            }}
          >
            <Menu size={19} />
          </button>
        ) : null}
        {onToggleSidebar ? (
          /*
           * The hamburger, not a panel glyph. `PanelLeft` draws a little
           * diagram of the layout — a box with a bar down one side — which the
           * owner did not like the look of, and which asks the reader to match
           * a picture of the UI to the UI. The three lines are what every
           * learner already reads as "the navigation", they are what the
           * reference uses for exactly this control, and they are the same
           * mark the drawer button carries below 1024 px. One icon, one
           * meaning, at every width.
           */
          <button
            type="button"
            aria-label={sidebarRail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-pressed={sidebarRail}
            title={sidebarRail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            data-testid="sidebar-toggle"
            className="state-layer hidden size-9 shrink-0 place-items-center rounded-full text-on-surface-variant lg:grid"
            onClick={() => {
              trackAction('sidebar_toggled', { rail: !sidebarRail });
              onToggleSidebar();
            }}
          >
            <Menu size={19} />
          </button>
        ) : null}
        <button
          type="button"
          className="mr-3 flex items-center gap-2 rounded-full py-1 pr-2 pl-1 text-on-surface transition-opacity hover:opacity-80"
          onClick={() => {
            trackAction('home_clicked');
            navigate('/');
          }}
          aria-label="Pen Playground home"
        >
          {/*
            The lockup, as drawn. This used to be the mark beside "Pen" set in
            the UI face, which made the logotype SF Pro on a Mac, Segoe on
            Windows and Inter on everything else — three logos. The word is
            outlines now, so it is one.
          */}
          <PenLogo />
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
          /* Below `sm` the two doors need the room (the Settings screen keeps a theme control). */
          className="state-layer hidden size-9 place-items-center rounded-full text-on-surface-variant sm:grid"
          onClick={() => {
            trackAction('theme_changed', { theme: dark ? 'light' : 'dark', source: 'header' });
            setTheme(dark ? 'light' : 'dark');
          }}
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        {signedIn && participant ? (
          <button
            type="button"
            className="state-layer ml-1 flex h-9 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-label-large text-on-surface"
            // Signed in, this is a way to your account, not a dialog: the
            // things it used to open — your name, your plan, privacy, delete —
            // are a page now.
            onClick={() => {
              trackAction('nav_clicked', { to: '/account', rail: false });
              navigate('/account');
            }}
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
          <>
            {/* Two doors, one sheet (ADR-0040): the quiet one for someone who
                has an account, the brand-filled one for someone who has not —
                the highest-emphasis action on the page for a signed-out visitor,
                and the only place the chrome carries the brand. */}
            <button
              type="button"
              className="state-layer flex h-9 items-center whitespace-nowrap rounded-full px-2.5 text-label-large text-on-surface sm:ml-1 sm:px-3"
              onClick={() => openSignIn('header')}
              data-testid="account-chip"
            >
              Sign in
            </button>
            <button
              type="button"
              className="state-layer flex h-9 items-center whitespace-nowrap rounded-full bg-primary-fixed px-3.5 text-label-large text-on-primary-fixed sm:px-4"
              onClick={() => openSignIn('header_sign_up')}
              data-testid="sign-up-cta"
            >
              Sign up for free
            </button>
          </>
        )}
        <AuthDialog open={signInOpen} onClose={closeSignIn} />
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
