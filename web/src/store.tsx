import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { get } from './api';
import type { Account, Category, Currency, Project, Settings } from './types';

export type Tab = 'expense' | 'income' | 'accounts' | 'feed' | 'menu';
export type MenuScreen = null | 'reports' | 'categories' | 'projects' | 'rates' | 'import' | 'integrations' | 'settings' | 'audit';
export type AccountsTab = 'accounts' | 'transfers' | 'archive';
export interface FeedPreset { kinds?: string[]; accountId?: string; categoryId?: string; projectId?: string; from?: string; to?: string; nonce: number }

interface Store {
  accounts: Account[]; categories: Category[]; projects: Project[]; currencies: Currency[]; settings: Settings;
  reload: () => Promise<void>;
  version: number; // bumps after every mutation so screens re-fetch derived data
  changed: () => Promise<void>;
  tab: Tab; setTab: (t: Tab) => void;
  menu: MenuScreen; setMenu: (m: MenuScreen) => void;
  feedPreset: FeedPreset | null; openFeed: (p: Omit<FeedPreset, 'nonce'>) => void;
  toast: (msg: string, error?: boolean) => void;
  accountsTab: AccountsTab; setAccountsTab: (t: AccountsTab) => void;
  pending: number; refreshPending: () => void;
  sharedText: string | null; consumeShared: () => void;
}

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

function readTab(): Tab {
  try { const t = localStorage.getItem('gok.tab') as Tab | null; if (t && ['expense', 'income', 'accounts', 'feed', 'menu'].includes(t)) return t; } catch { /* storage unavailable */ }
  return 'expense';
}

export function StoreProvider({ settings: initialSettings, children }: { settings: Settings; children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [version, setVersion] = useState(0);
  const [tab, setTabState] = useState<Tab>(readTab);
  const [menu, setMenu] = useState<MenuScreen>(null);
  const [feedPreset, setFeedPreset] = useState<FeedPreset | null>(null);
  const [toastMsg, setToastMsg] = useState<{ msg: string; error?: boolean } | null>(null);
  const toastTimer = useRef<number>();
  const [sharedText, setSharedText] = useState<string | null>(null);
  const [accountsTab, setAccountsTab] = useState<AccountsTab>('accounts');
  const [pending, setPending] = useState(0);
  const refreshPending = useCallback(() => { get<{ pending: number }>('/import/count').then((r) => setPending(r.pending)).catch(() => {}); }, []);
  // bank feeds (Telegram, monobank, SMS forwarding) arrive in the background: poll the inbox counter
  useEffect(() => { refreshPending(); const h = window.setInterval(refreshPending, 60000); return () => window.clearInterval(h); }, [refreshPending]);

  const reload = useCallback(async () => {
    const [a, c, p, cur, s] = await Promise.all([get<Account[]>('/accounts'), get<Category[]>('/categories'), get<Project[]>('/projects'), get<Currency[]>('/currencies'), get<Settings>('/settings')]);
    setAccounts(a); setCategories(c); setProjects(p); setCurrencies(cur); setSettings(s);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // Web Share Target (Android PWA): /share?text=... opens the SMS import with the shared text.
  useEffect(() => {
    if (location.pathname === '/share') {
      const p = new URLSearchParams(location.search);
      const text = [p.get('title'), p.get('text')].filter(Boolean).join('\n');
      if (text) { setSharedText(text); setTabState('menu'); setMenu('import'); }
      history.replaceState(null, '', '/');
    }
  }, []);

  const value = useMemo<Store>(() => ({
    accounts, categories, projects, currencies, settings, reload, version,
    changed: async () => { await reload(); setVersion((v) => v + 1); refreshPending(); },
    tab, setTab: (t) => { setTabState(t); if (t !== 'menu') setMenu(null); try { localStorage.setItem('gok.tab', t); } catch { /* ignore */ } },
    menu, setMenu,
    feedPreset, openFeed: (p) => { setFeedPreset({ ...p, nonce: Date.now() }); setTabState('feed'); setMenu(null); },
    toast: (msg, error) => { setToastMsg({ msg, error }); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToastMsg(null), error ? 4500 : 2200); },
    sharedText, consumeShared: () => setSharedText(null),
    accountsTab, setAccountsTab, pending, refreshPending,
  }), [accounts, categories, projects, currencies, settings, reload, version, tab, menu, feedPreset, sharedText, accountsTab, pending, refreshPending]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {toastMsg && <div className={'toast' + (toastMsg.error ? ' err' : '')} role="status">{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, setData };
}
