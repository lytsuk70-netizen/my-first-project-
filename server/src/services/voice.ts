/** Executes read-only voice commands and phrases a spoken answer. Writes always come back as drafts. */
import { interpret, type Command, type Period } from '../engine/commands.js';
import { parseContext } from './catalog.js';
import { getSettings, listAccounts, netWorth } from './ledger.js';
import { report } from './reports.js';

const DAY = 86400000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function periodRange(p: Period, todayLocal: string): { from: string; to: string } {
  const t = new Date(todayLocal + 'T00:00:00Z');
  const [y, m] = todayLocal.split('-').map(Number);
  switch (p) {
    case 'today': return { from: todayLocal, to: todayLocal };
    case 'yesterday': { const d = ymd(new Date(t.getTime() - DAY)); return { from: d, to: d }; }
    case 'week': { const dow = (t.getUTCDay() + 6) % 7; return { from: ymd(new Date(t.getTime() - dow * DAY)), to: todayLocal }; }
    case 'month': return { from: `${todayLocal.slice(0, 8)}01`, to: todayLocal };
    case 'prevMonth': { const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; return { from: `${py}-${String(pm).padStart(2, '0')}-01`, to: ymd(new Date(Date.UTC(py, pm, 0))) }; }
    case 'year': return { from: `${y}-01-01`, to: todayLocal };
  }
}

const say = (v: string) => {
  const [i, f] = v.replace('-', '').split('.');
  return `${v.startsWith('-') ? 'мінус ' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${f && f !== '00' ? ',' + f : ''}`;
};
const CUR: Record<string, [string, string]> = { UAH: ['гривень', 'hryvnias'], USD: ['доларів', 'dollars'], EUR: ['євро', 'euros'], PLN: ['злотих', 'zloty'], GBP: ['фунтів', 'pounds'] };

const PERIOD_NAME: Record<Period, [string, string]> = {
  today: ['сьогодні', 'today'], yesterday: ['вчора', 'yesterday'], week: ['цього тижня', 'this week'], month: ['цього місяця', 'this month'],
  prevMonth: ['минулого місяця', 'last month'], year: ['цього року', 'this year'],
};

export async function runVoiceCommand(userId: string, text: string, defaultType?: 'income' | 'expense') {
  const settings = await getSettings(userId);
  const en = settings.language === 'en';
  const ctx = await parseContext(userId);
  const cmd: Command = interpret(text, ctx.accounts, ctx.categories, { lang: settings.language, defaultType });
  const money = (v: string, c: string) => `${say(v)} ${CUR[c]?.[en ? 1 : 0] ?? c}`;

  if (cmd.intent === 'balance') {
    const accounts = await listAccounts(userId, false);
    if (cmd.accountId) {
      const a = accounts.find((x) => x.id === cmd.accountId)!;
      return { command: cmd, answer: en ? `${a.name}: ${money(a.balance, a.currency)}.` : `На рахунку ${a.name} ${money(a.balance, a.currency)}.` };
    }
    const nw = await netWorth(userId);
    const lines = accounts.map((a) => `${a.name}: ${money(a.balance, a.currency)}`).join('; ');
    const total = en ? `Total net worth ${money(nw.total, nw.baseCurrency)}` : `Загальний капітал ${money(nw.total, nw.baseCurrency)}`;
    const warn = nw.complete ? '' : en ? ` (no rate for ${nw.missingRates.join(', ')})` : ` (без курсу: ${nw.missingRates.join(', ')})`;
    return { command: cmd, answer: `${total}${warn}. ${lines}.` };
  }

  if (cmd.intent === 'total') {
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(new Date());
    const range = periodRange(cmd.period, todayLocal);
    const r = await report(userId, range.from, range.to);
    const sec = r[cmd.type];
    let total = sec.total;
    let catName = '';
    if (cmd.categoryId) {
      const rows = sec.byCategory.filter((c: any) => c.id === cmd.categoryId || c.parentId === cmd.categoryId);
      catName = ctx.categories.find((c) => c.id === cmd.categoryId)?.name ?? '';
      const minor = rows.reduce((s: bigint, c: any) => s + BigInt(c.total.replace('.', '')), 0n);
      const str = minor.toString().padStart(3, '0');
      total = `${str.slice(0, -2)}.${str.slice(-2)}`;
    }
    const p = PERIOD_NAME[cmd.period][en ? 1 : 0];
    const what = cmd.type === 'expense' ? (en ? 'spent' : 'витратили') : (en ? 'earned' : 'отримали');
    const answer = en
      ? `You ${what} ${money(total, r.baseCurrency)} ${p}${catName ? ` on ${catName}` : ''}.`
      : `${p[0].toUpperCase() + p.slice(1)} ви ${what}${catName ? ` на «${catName}»` : ''} ${money(total, r.baseCurrency)}.`;
    return { command: cmd, answer, range };
  }

  if (cmd.intent === 'unknown') {
    return {
      command: cmd,
      answer: en
        ? 'I did not understand. Try: "spent 200 on taxi with Mono", "how much did I spend this month", "balance on Mono", "transfer 1000 dollars from Bank USD to Privat at 41.5", "open reports".'
        : 'Не зрозумів. Спробуйте: «витратив 200 на таксі з моно», «скільки я витратив цього місяця», «який баланс на моно», «переведи 1000 доларів з Bank USD на Приват за курсом 41,5», «відкрий звіти».',
    };
  }
  if (cmd.intent === 'transfer' || cmd.intent === 'transaction') {
    const qs = cmd.intent === 'transfer' ? cmd.questions : cmd.draft.questions;
    return { command: cmd, answer: qs.length ? qs.join(' ') : en ? 'Check and confirm.' : 'Перевірте та підтвердіть.' };
  }
  return { command: cmd, answer: '' };
}
