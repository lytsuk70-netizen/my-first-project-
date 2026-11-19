/**
 * Voice command interpreter: turns a phrase into an intent the app can execute.
 * It never changes data by itself — transactions and transfers come back as drafts to confirm.
 */
import { ACCOUNT_ALIASES, extractAmounts, matchCategory, norm, parseVoice, translit, words, type Draft, type ParseAccount, type ParseCategory } from './parser.js';

export type NavTarget = 'expense' | 'income' | 'accounts' | 'transfers' | 'feed' | 'reports' | 'categories' | 'projects' | 'rates' | 'inbox' | 'settings' | 'integrations';
export type Period = 'today' | 'yesterday' | 'week' | 'month' | 'prevMonth' | 'year';

export type Command =
  | { intent: 'navigate'; target: NavTarget }
  | { intent: 'balance'; accountId: string | null }
  | { intent: 'total'; type: 'expense' | 'income'; period: Period; categoryId: string | null }
  | { intent: 'transfer'; fromAccountId: string | null; toAccountId: string | null; amount: string | null; rate: string | null; comment: string; missing: string[]; questions: string[] }
  | { intent: 'transaction'; draft: Draft }
  | { intent: 'unknown' };

const has = (toks: string[], stems: string[]) => toks.some((t) => stems.some((s) => t.startsWith(s)));

const NAV: Array<[NavTarget, string[]]> = [
  ['integrations', ['підключ', 'інтеграц', 'телеграм', 'telegram', 'монобанк', 'integration', 'connect']],
  ['inbox', ['вхідн', 'імпорт', 'inbox', 'import', 'смс', 'sms', 'повідомлен']],
  ['transfers', ['переказ', 'transfers']],
  ['reports', ['звіт', 'аналіт', 'статист', 'діаграм', 'report', 'analytic', 'stat']],
  ['categories', ['категор', 'categor']],
  ['projects', ['проєкт', 'проект', 'об\'єкт', 'project']],
  ['rates', ['курс', 'rates', 'exchange']],
  ['settings', ['налаштув', 'settings']],
  ['feed', ['стрічк', 'історі', 'операці', 'feed', 'history']],
  ['accounts', ['рахунк', 'рахунок', 'гаманц', 'accounts', 'wallet']],
  ['income', ['доход', 'income']],
  ['expense', ['витрат', 'expenses']],
];
const NAV_VERBS = ['відкр', 'покаж', 'перейд', 'перейт', 'відобраз', 'зайд', 'open', 'show', 'go', 'display'];
const TRANSFER_VERBS = ['переказ', 'перев', 'перекин', 'обмін', 'обмін', 'обміня', 'поміня', 'transfer', 'move', 'exchang', 'convert'];
const QUESTION = ['скільки', 'how', 'який', 'яка', 'what', 'what\'s'];
const BALANCE = ['баланс', 'залиш', 'balance', 'грошей', 'money', 'left'];
const SPENT = ['витрат', 'потрат', 'spent', 'spend', 'expens', 'заплат'];
const EARNED = ['зароб', 'отрима', 'доход', 'earn', 'income', 'received', 'got'];

function period(toks: string[], text: string): Period {
  const t = norm(text);
  if (/сьогодні|today/.test(t)) return 'today';
  if (/позавчора/.test(t)) return 'yesterday';
  if (/вчора|yesterday/.test(t)) return 'yesterday';
  if (/тижн|тиждень|week/.test(t)) return 'week';
  if (/минул\p{L}*\s+місяц|попередн\p{L}*\s+місяц|last month|previous month/u.test(t)) return 'prevMonth';
  if (has(toks, ['рік', 'року', 'year'])) return 'year';
  return 'month';
}

/** Account mentions with their position, so "з Mono на Privat" keeps the right direction. */
export function accountMentions(text: string, accounts: ParseAccount[]) {
  const toks = words(text);
  const tl = toks.map(translit);
  const out: Array<{ id: string; index: number; prev: string }> = [];
  for (const a of accounts.filter((x) => !x.is_archived)) {
    const nameTl = translit(a.name);
    const stems = words(a.name).filter((w) => w.length >= 3 && !/^(uah|usd|eur|pln|gbp|грн)$/i.test(w)).map(translit);
    for (const [nameKeys, phraseKeys] of ACCOUNT_ALIASES) if (nameKeys.some((k) => nameTl.includes(translit(k)))) stems.push(...phraseKeys.map(translit));
    const index = tl.findIndex((t) => stems.some((s) => t.startsWith(s)));
    if (index >= 0) out.push({ id: a.id, index, prev: index > 0 ? toks[index - 1] : '' });
  }
  // the same word can hit «Моно» and «Деп Моно»: keep the account with the fewest extra words
  const extra = (id: string) => words(accounts.find((a) => a.id === id)?.name ?? '').length;
  const byIndex = new Map<number, { id: string; index: number; prev: string }>();
  for (const m of out) { const cur = byIndex.get(m.index); if (!cur || extra(m.id) < extra(cur.id)) byIndex.set(m.index, m); }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export function interpret(text: string, accounts: ParseAccount[], categories: ParseCategory[], opts: { lang?: 'uk' | 'en'; defaultType?: 'income' | 'expense' } = {}): Command {
  const en = opts.lang === 'en';
  const q = (uk: string, e: string) => (en ? e : uk);
  const toks = words(text);
  const amounts = extractAmounts(text);
  const isQuestion = has(toks, QUESTION) || /\?\s*$/.test(text);

  // 1) transfer / exchange
  if (has(toks, TRANSFER_VERBS) && amounts.length) {
    const rateMatch = norm(text).match(/(?:курс\p{L}*|rate|at)\s*(\d+(?:[.,]\d+)?)/u);
    const rate = rateMatch ? rateMatch[1].replace(',', '.') : null;
    const amount = amounts.find((a) => a !== rate) ?? null;
    const mentions = accountMentions(text, accounts);
    let from = mentions.find((m) => /^(з|із|зі|від|from)$/.test(m.prev))?.id ?? null;
    let to = mentions.find((m) => /^(на|в|у|до|to|into)$/.test(m.prev))?.id ?? null;
    const rest = mentions.filter((m) => m.id !== from && m.id !== to).map((m) => m.id);
    if (!from && rest.length) from = rest.shift()!;
    if (!to && rest.length) to = rest.shift()!;
    const missing: string[] = [];
    const questions: string[] = [];
    if (!amount) { missing.push('amount'); questions.push(q('Яку суму переказати?', 'How much to transfer?')); }
    if (!from) { missing.push('from'); questions.push(q('З якого рахунку?', 'From which account?')); }
    if (!to) { missing.push('to'); questions.push(q('На який рахунок?', 'To which account?')); }
    const fa = accounts.find((a) => a.id === from); const ta = accounts.find((a) => a.id === to);
    if (fa && ta && fa.currency !== ta.currency && !rate) { missing.push('rate'); questions.push(q(`Який курс ${fa.currency}/${ta.currency}?`, `What is the ${fa.currency}/${ta.currency} rate?`)); }
    return { intent: 'transfer', fromAccountId: from, toAccountId: to, amount, rate, comment: '', missing, questions };
  }

  // 2) questions: balance / totals
  if ((has(toks, BALANCE) && (isQuestion || toks.length <= 4)) || (isQuestion && !amounts.length && !has(toks, SPENT) && !has(toks, EARNED) && accountMentions(text, accounts).length)) {
    const m = accountMentions(text, accounts);
    return { intent: 'balance', accountId: m.length === 1 ? m[0].id : null };
  }
  if (isQuestion && (has(toks, SPENT) || has(toks, EARNED))) {
    const type = has(toks, SPENT) ? 'expense' : 'income';
    const cat = matchCategory(text.replace(/витрат\p{L}*|потрат\p{L}*|spent/giu, ' '), categories, type);
    return { intent: 'total', type, period: period(toks, text), categoryId: cat.id };
  }

  // 3) navigation
  if (!amounts.length || has(toks, NAV_VERBS)) {
    const verb = has(toks, NAV_VERBS);
    for (const [target, stems] of NAV) {
      if (has(toks, stems) && (verb || toks.length <= 3)) return { intent: 'navigate', target };
    }
  }

  // 4) a new expense / income
  if (amounts.length) return { intent: 'transaction', draft: parseVoice(text, accounts, categories, { lang: opts.lang, defaultType: opts.defaultType }) };
  return { intent: 'unknown' };
}
