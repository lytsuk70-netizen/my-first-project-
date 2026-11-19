import { useEffect, useRef, useState } from 'react';
import { post } from '../api';
import { useT } from '../i18n';
import { useStore } from '../store';
import type { Draft, TxType } from '../types';
import { TransferSheet, type TransferDraft } from './TransferForm';
import { TxEditor } from './TxEditor';
import { ErrorBox, Icons, Sheet } from './ui';

interface CommandResult {
  answer: string;
  range?: { from: string; to: string };
  command:
    | { intent: 'navigate'; target: string }
    | { intent: 'balance'; accountId: string | null }
    | { intent: 'total'; type: TxType; period: string; categoryId: string | null }
    | { intent: 'transfer'; fromAccountId: string | null; toAccountId: string | null; amount: string | null; rate: string | null; questions: string[] }
    | { intent: 'transaction'; draft: Draft }
    | { intent: 'unknown' };
}

function speakEnabled() { try { return localStorage.getItem('gok.speak') !== 'off'; } catch { return true; } }

/**
 * Voice control for the whole app: speech → server interpreter → action.
 * Questions are answered (and spoken); navigation happens immediately; expenses, income and
 * transfers open a pre-filled form that still needs the user's confirmation.
 */
export function VoiceSheet({ defaultType, autoStart = true, onClose }: { defaultType?: TxType; autoStart?: boolean; onClose: () => void }) {
  const { t, lang } = useT();
  const { accounts, setTab, setMenu, setAccountsTab, openFeed } = useStore();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [transfer, setTransfer] = useState<(TransferDraft & { questions: string[] }) | null>(null);
  const [speak, setSpeak] = useState(speakEnabled);
  const recRef = useRef<any>(null);
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  useEffect(() => { if (autoStart && SR) listen(); return () => { recRef.current?.abort?.(); window.speechSynthesis?.cancel(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function say(answer: string) {
    if (!speak || !answer || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(answer);
    u.lang = lang === 'en' ? 'en-US' : 'uk-UA';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  function listen() {
    if (!SR) { setError(t.voiceUnsupported); return; }
    setError(null); setResult(null);
    window.speechSynthesis?.cancel();
    const rec = new SR();
    rec.lang = lang === 'en' ? 'en-US' : 'uk-UA';
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      const phrase = Array.from(e.results).map((r: any) => r[0].transcript).join(' ');
      setText(phrase);
      if (e.results[e.results.length - 1].isFinal) run(phrase);
    };
    rec.onerror = (e: any) => { setListening(false); if (e.error !== 'aborted' && e.error !== 'no-speech') setError(e.error === 'not-allowed' ? 'Немає доступу до мікрофона / microphone permission denied' : e.error); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { /* already started */ }
  }

  const NAV: Record<string, () => void> = {
    expense: () => setTab('expense'), income: () => setTab('income'), feed: () => setTab('feed'),
    accounts: () => { setAccountsTab('accounts'); setTab('accounts'); }, transfers: () => { setAccountsTab('transfers'); setTab('accounts'); },
    reports: () => { setTab('menu'); setMenu('reports'); }, categories: () => { setTab('menu'); setMenu('categories'); }, projects: () => { setTab('menu'); setMenu('projects'); },
    rates: () => { setTab('menu'); setMenu('rates'); }, settings: () => { setTab('menu'); setMenu('settings'); },
    inbox: () => { setTab('menu'); setMenu('import'); }, integrations: () => { setTab('menu'); setMenu('integrations'); },
  };

  async function run(phrase = text) {
    if (!phrase.trim()) return;
    try {
      const r = await post<CommandResult>('/voice/command', { text: phrase, defaultType });
      const c = r.command;
      if (c.intent === 'navigate') { NAV[c.target]?.(); onClose(); return; }
      if (c.intent === 'transaction') { say(c.draft.questions.join(' ')); setDraft(c.draft); return; }
      if (c.intent === 'transfer') { say(c.questions.join(' ')); setTransfer({ fromAccountId: c.fromAccountId, toAccountId: c.toAccountId, amountSent: c.amount, rate: c.rate, questions: c.questions }); return; }
      setResult(r);
      say(r.answer);
    } catch (e: any) { setError(e.message); }
  }

  if (draft) {
    const accountId = draft.accountId ?? (draft.candidates.accounts.length === 1 ? draft.candidates.accounts[0] : '');
    return (
      <TxEditor mode="create" source="voice" allowTypeChange title={t.checkAndConfirm} questions={draft.questions} onClose={onClose}
        initial={{ type: draft.type ?? defaultType ?? 'expense', amount: draft.amount ?? '', accountId: accounts.some((a) => a.id === accountId) ? accountId : '', categoryId: draft.categoryId ?? '', occurredAt: draft.occurredAt, comment: draft.comment }} />
    );
  }
  if (transfer) {
    return (
      <TransferSheet title={t.checkAndConfirm} draft={transfer} onClose={onClose} />
    );
  }

  const cmd = result?.command;
  return (
    <Sheet title={t.voiceControl} onClose={onClose}>
      <div style={{ textAlign: 'center', margin: '8px 0 14px' }}>
        <button className={'fab-voice' + (listening ? ' on' : '')} style={{ position: 'static', width: 84, height: 84, margin: '0 auto' }} onClick={listening ? () => recRef.current?.stop() : listen} aria-label={t.voice}>
          <span style={{ transform: 'scale(1.5)', display: 'grid' }}>{Icons.mic}</span>
        </button>
        <div className="faint" style={{ marginTop: 8 }}>{listening ? t.voiceListening : SR ? '' : t.voiceUnsupported}</div>
      </div>
      {result && <div className="answer" role="status">{result.answer}</div>}
      {cmd?.intent === 'total' && result?.range && (
        <button className="btn ghost small" onClick={() => { onClose(); openFeed({ kinds: [cmd.type], from: result.range!.from, to: result.range!.to, categoryId: cmd.categoryId ?? undefined }); }}>{t.showOperations} →</button>
      )}
      <textarea className="input" style={{ marginTop: 12 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.voicePlaceholder} maxLength={500}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } }} />
      <p className="faint">{t.voiceHint}</p>
      <label className="row faint" style={{ gap: 8 }}>
        <input type="checkbox" checked={speak} onChange={(e) => { setSpeak(e.target.checked); try { localStorage.setItem('gok.speak', e.target.checked ? 'on' : 'off'); } catch { /* ignore */ } }} />
        {t.speakAnswers}
      </label>
      <ErrorBox error={error} />
      <div className="actions"><button className="btn primary" disabled={!text.trim()} onClick={() => run()}>{t.doIt}</button></div>
    </Sheet>
  );
}
