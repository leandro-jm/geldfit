import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readStorage, writeStorage } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';

interface PrefsCtx {
  theme: ThemePref;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: ThemePref) => void;
  privacy: boolean;
  togglePrivacy: () => void;
}

const Ctx = createContext<PrefsCtx | null>(null);

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(() => {
    const v = readStorage('sf.theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  const [sysDark, setSysDark] = useState(systemDark);
  const [privacy, setPrivacy] = useState(() => readStorage('sf.privacy') === '1');

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => setSysDark(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? (sysDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    const meta = document.querySelectorAll('meta[name="theme-color"]');
    meta.forEach((m) => m.setAttribute('content', resolvedTheme === 'dark' ? '#111110' : '#f6f6f4'));
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.classList.toggle('privacy', privacy);
  }, [privacy]);

  const setTheme = useCallback((t: ThemePref) => {
    writeStorage('sf.theme', t === 'system' ? null : t);
    setThemeState(t);
  }, []);
  const togglePrivacy = useCallback(() => {
    setPrivacy((p) => {
      writeStorage('sf.privacy', p ? null : '1');
      return !p;
    });
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, privacy, togglePrivacy }),
    [theme, resolvedTheme, setTheme, privacy, togglePrivacy],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): PrefsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('PrefsProvider ausente');
  return v;
}
