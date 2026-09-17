import { applyTheme, Button, cn, IconButton, readTheme, type Theme } from '@pen/design';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useApp } from '../lib/context.js';
import { NameDialog } from './NameDialog.js';

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors',
    isActive ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
  );

export function AppHeader({ sticky = true }: { sticky?: boolean }) {
  const { participant } = useApp();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [naming, setNaming] = useState(false);
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <header
      className={cn(
        'z-10 flex items-center gap-6 border-b border-line bg-bg px-7 py-3.5',
        sticky && 'sticky top-0',
      )}
    >
      <button
        type="button"
        className="font-display text-[19px] font-medium tracking-[-0.02em]"
        onClick={() => navigate('/')}
      >
        Pen Academy
      </button>
      <nav className="ml-2 flex gap-1" aria-label="Primary">
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
      <div className="flex gap-0.5 rounded-full bg-surface-2 p-[3px]">
        <IconButton
          label="Dark theme"
          size={30}
          className={cn(
            'rounded-full',
            theme === 'dark' ? '' : 'bg-transparent shadow-none text-fg-2',
          )}
          onClick={() => setTheme('dark')}
        >
          <Moon size={15} />
        </IconButton>
        <IconButton
          label="Light theme"
          size={30}
          className={cn(
            'rounded-full',
            theme === 'light' ? '' : 'bg-transparent shadow-none text-fg-2',
          )}
          onClick={() => setTheme('light')}
        >
          <Sun size={15} />
        </IconButton>
      </div>
      <Button variant="secondary" onClick={() => setNaming(true)}>
        {participant ? participant.name : 'Sign in'}
      </Button>
      <NameDialog open={naming} onClose={() => setNaming(false)} />
    </header>
  );
}
