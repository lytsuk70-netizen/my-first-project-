import { useEffect, useRef, useState } from 'react';
import { post } from '../api';
import { useT } from '../i18n';
import { useStore } from '../store';
import type { Draft, TxType } from '../types';
import { TxEditor } from './TxEditor';
import { ErrorBox, Icons, Sheet } from './ui';

/**
 * Voice entry: browser speech recognition (Web Speech API) -> server-side parser -> confirmation form.
 * Nothing is saved until the user confirms. Typing the phrase works everywhere as a fallback.
 */
export function VoiceSheet({ defaultType, onClose }: { defaultType: TxType; onClose: () => void }) {
  const { t, lang } = useT();
  const { accounts } = useStore();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const recRef = useRef<any>(null);
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  useEffect(() => () => recRef.current?.abort?.(), []);

  function listen() {
    if (!SR) { setError(t.voiceUnsupported); return; }
    setError(null);
    const rec = new SR();
    rec.lang = lang === 'en' ? 'en-US' : 'uk-UA';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      const phrase = Array.from(e.results).map((r: any) => r[0].transcript).join(' ');
      setText(phrase);
      if (e.results[e.results.length - 1].isFinal) recognize(phrase);
    };
    rec.onerror = (e: any) => { setListening(false); if (e.error !== 'aborted' && e.error !== 'no-speech') setError(e.error === 'not-allowed' ? 'Microphone permission denied' : e.error); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }

  async function recognize(phrase = text) {
    if (!phrase.trim()) return;
    try { setDraft(await post<Draft>('/parse/voice', { text: phrase, defaultType })); } catch (e: any) { setError(e.message); }
  }

  if (draft) {
    const accountId = draft.accountId ?? (draft.candidates.accounts.length === 1 ? draft.candidates.accounts[0] : '');
    return (
      <TxEditor
        mode="create" source="voice" allowTypeChange title={t.checkAndConfirm} questions={draft.questions} onClose={onClose}
        initial={{ type: draft.type ?? defaultType, amount: draft.amount ?? '', accountId: accounts.some((a) => a.id === accountId) ? accountId : '', categoryId: draft.categoryId ?? '', occurredAt: draft.occurredAt, comment: draft.comment }}
      />
    );
  }

  return (
    <Sheet title={t.voice} onClose={onClose}>
      <div style={{ textAlign: 'center', margin: '8px 0 16px' }}>
        <button className={'icon-btn' + (listening ? ' on' : '')} style={{ width: 84, height: 84, borderRadius: '50%', margin: '0 auto' }} onClick={listening ? () => recRef.current?.stop() : listen} aria-label={t.voice}>
          <span style={{ transform: 'scale(1.6)', display: 'grid' }}>{Icons.mic}</span>
        </button>
        <div className="faint" style={{ marginTop: 8 }}>{listening ? t.voiceListening : SR ? '' : t.voiceUnsupported}</div>
      </div>
      <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t.voicePlaceholder} maxLength={500} />
      <ErrorBox error={error} />
      <div className="actions"><button className="btn primary" disabled={!text.trim()} onClick={() => recognize()}>{t.recognize}</button></div>
    </Sheet>
  );
}
