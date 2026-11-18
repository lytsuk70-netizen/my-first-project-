import { useCallback, useEffect, useState } from 'react';
import { get } from './api';
import { Icons } from './components/ui';
import { VoiceSheet } from './components/VoiceSheet';
import { I18nContext, dictionaries } from './i18n';
import { Accounts } from './screens/Accounts';
import { Auth } from './screens/Auth';
import { Entry } from './screens/Entry';
import { Feed } from './screens/Feed';
import { Menu } from './screens/Menu';
import { TalkoShell } from './screens/TalkoMode';
import { StoreProvider, useStore, type Tab } from './store';
import type { Settings } from './types';

function Shell() {
  const { tab, setTab, settings, pending } = useStore();
  const [voice, setVoice] = useState(false);
  const t = dictionaries[settings.language] ?? dictionaries.uk;
  useEffect(() => { document.documentElement.lang = settings.language; document.title = t.appName; }, [settings.language, t.appName]);
  const nav: Array<[Tab, string, JSX.Element, string]> = [
    ['expense', t.expenses, Icons.minus, 'expense'], ['income', t.income, Icons.plus, 'income'], ['accounts', t.accounts, Icons.wallet, ''],
    ['feed', t.feed, Icons.list, ''], ['menu', t.menu, Icons.menu, ''],
  ];
  return (
    <I18nContext.Provider value={{ t, lang: settings.language }}>
      <main className="app">
        {tab === 'expense' && <Entry key="expense" type="expense" />}
        {tab === 'income' && <Entry key="income" type="income" />}
        {tab === 'accounts' && <Accounts />}
        {tab === 'feed' && <Feed />}
        {tab === 'menu' && <Menu />}
      </main>
      <nav className="nav">
        {nav.map(([key, label, icon, cls]) => (
          <button key={key} className={(tab === key ? 'active ' : '') + cls} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}>
            {icon}<span>{label}</span>{key === 'menu' && pending > 0 && <span className="badge">{pending > 99 ? '99+' : pending}</span>}
          </button>
        ))}
      </nav>
      {tab !== 'expense' && tab !== 'income' && (
        <button className="fab-voice" onClick={() => setVoice(true)} aria-label={t.voiceControl} title={t.voiceControl}>{Icons.mic}</button>
      )}
      {voice && <VoiceSheet onClose={() => setVoice(false)} />}
    </I18nContext.Provider>
  );
}

export function App() {
  const [state, setState] = useState<{ loading: boolean; user: unknown; needsSetup: boolean; settings: Settings | null; error?: string }>({ loading: true, user: null, needsSetup: false, settings: null });
  const load = useCallback(() => {
    get('/auth/me').then((me) => setState({ loading: false, user: me.user, needsSetup: me.needsSetup, settings: me.settings }))
      .catch((e) => setState({ loading: false, user: null, needsSetup: false, settings: null, error: e.message }));
  }, []);
  useEffect(load, [load]);
  if (state.loading) return <div className="empty">…</div>;
  if (state.error) return <div className="auth"><div className="error">{state.error}</div></div>;
  const lang = navigator.language.startsWith('en') ? 'en' : 'uk';
  if (!state.user || !state.settings) {
    return <I18nContext.Provider value={{ t: dictionaries[lang], lang }}><Auth setup={state.needsSetup} onDone={load} /></I18nContext.Provider>;
  }
  if (state.settings.data_source === 'talko') {
    const l = state.settings.language ?? 'uk';
    return <I18nContext.Provider value={{ t: dictionaries[l], lang: l }}><TalkoShell /></I18nContext.Provider>;
  }
  return <StoreProvider settings={state.settings}><Shell /></StoreProvider>;
}
