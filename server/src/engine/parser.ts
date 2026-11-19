/**
 * Natural-language parsers for voice phrases and bank SMS notifications.
 * They only produce *drafts*. Nothing is saved without explicit user confirmation.
 */

export interface ParseAccount { id: string; name: string; currency: string; sms_keywords?: string; is_archived?: boolean }
export interface ParseCategory { id: string; name: string; type: 'income' | 'expense'; is_archived?: boolean }

export interface Draft {
  type: 'income' | 'expense' | null;
  amount: string | null; // decimal string in major units
  currency: string | null;
  accountId: string | null;
  categoryId: string | null;
  comment: string;
  occurredAt: string | null; // ISO
  missing: Array<'type' | 'amount' | 'currency' | 'account' | 'category'>;
  questions: string[];
  candidates: { accounts: string[]; amounts: string[] };
}

export interface SmsDraft extends Draft {
  balance: string | null;
  balanceCurrency: string | null;
  cardLast4: string | null;
  bank: string | null;
  merchant: string;
}

// ---------- normalisation helpers ----------

export function norm(s: string): string {
  return s.toLowerCase().replace(/[’'`ʼ‘]/g, "'").replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'sch', ь: '', ю: 'yu', я: 'ya', ы: 'y', э: 'e', ъ: '', "'": '',
};
export function translit(s: string): string {
  return [...norm(s)].map((c) => TRANSLIT[c] ?? c).join('').replace(/y/g, 'i');
}

export function words(s: string): string[] {
  return norm(s).split(/[^\p{L}\p{N}'*$€₴£]+/u).filter(Boolean);
}

// ---------- dictionaries ----------

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/(₴|(?<!\p{L})(грн|грив\p{L}*|hryvn\p{L}*|uah|гривен\p{L}*)(?!\p{L}))/iu, 'UAH'],
  [/(\$|(?<!\p{L})(usd|долар\p{L}*|dollar\p{L}*|бакс\p{L}*|bucks?)(?!\p{L}))/iu, 'USD'],
  [/(€|(?<!\p{L})(eur|євро|euros?|евро)(?!\p{L}))/iu, 'EUR'],
  [/(zł|(?<!\p{L})(pln|злот\p{L}*|zlot\p{L}*)(?!\p{L}))/iu, 'PLN'],
  [/(£|(?<!\p{L})(gbp|фунт\p{L}*|pounds?)(?!\p{L}))/iu, 'GBP'],
];

const EXPENSE_WORDS = ['витрат', 'витра', 'заплат', 'купи', 'купу', 'оплат', 'сплат', 'потрат', 'spent', 'spend', 'paid', 'pay', 'bought', 'buy', 'purchase', 'списан', 'покупк', 'зняття', 'withdraw'];
const INCOME_WORDS = ['отрима', 'заробі', 'зароби', 'надійш', 'надход', 'зарахув', 'поповн', 'дохід', 'прибут', 'received', 'receive', 'earned', 'earn', 'got', 'income', 'credited', 'refund', 'повернен'];

/** keyword stem -> category name stem */
const CATEGORY_SYNONYMS: Array<[string[], string[]]> = [
  // Юрій's known recipients (project rules)
  [['таврі', 'tavri'], ['продукт']],
  [['кондитер', 'kaviarn', 'doppio', 'доппіо', 'небесн', 'мигдал'], ['кафе', 'ресторан']],
  [['mastak', 'мастак', 'будмагаз', 'budmahaz', 'novapay', 'новапей'], ['житл']],
  [['жасмін', 'jasmin'], ['хімі']],
  [['zeekr', 'зікр', 'зікер', 'автомий', 'мийк'], ['авто']],
  [['силмед', 'сілмед', 'silmed'], ["здоров"]],
  [['ресторан', 'кафе', "кав'ярн", 'кав', 'бар', 'піц', 'суші', 'обід', 'вечер', 'сніданок', 'restaurant', 'cafe', 'coffee', 'lunch', 'dinner', 'mcdonald', 'макдонал', 'kfc', 'starbucks'], ['ресторан', 'restaurant', 'кафе']],
  [['продукт', 'їж', 'їда', 'супермаркет', 'атб', 'atb', 'сільпо', 'silpo', 'novus', 'новус', 'ашан', 'auchan', 'фора', 'fora', 'varus', 'варус', 'metro', 'food', 'grocer', 'продовол'], ['їж', 'food', 'продукт', 'харч']],
  [['таксі', 'taxi', 'uber', 'bolt', 'уклон', 'uklon', 'бензин', 'пальн', 'заправ', 'wog', 'окко', 'okko', 'socar', 'метро', 'автобус', 'маршрут', 'проїзд', 'парков', 'parking', 'fuel', 'transport', 'потяг', 'укрзалізн', 'train', 'квиток'], ['транспорт', 'transport', 'авто']],
  [['аптек', 'pharm', 'лік', 'лікар', 'клінік', 'стоматол', 'doctor', 'health', 'медиц', 'аналіз'], ["здоров", 'health', 'медиц']],
  [['сім', 'дит', 'дітей', 'family', 'kids', 'child'], ["сім'", 'сім', 'family', 'родин']],
  [['комунал', 'оренд', 'квартир', 'rent', 'utilit', 'світло', 'електро', 'вода', 'опален', 'home', 'дім', 'дому', 'господар'], ['дім', 'home', 'житл', 'house']],
  [['київстар', 'kyivstar', 'vodafone', 'lifecell', 'мобільн', 'phone', 'інтернет', 'internet', "зв'яз"], ["зв'яз", 'зв', 'phone', 'mobile', 'інтернет']],
  [['кіно', 'cinema', 'концерт', 'театр', 'netflix', 'spotify', 'youtube', 'ігр', 'game', 'розваг', 'entertain'], ['розваг', 'entertain', 'дозвіл']],
  [['одяг', 'взутт', 'clothes', 'shoes', 'zara', 'reserved'], ['одяг', 'cloth']],
  [['благод', 'донат', 'donat', 'зсу', 'фонд', 'charity', 'волонт'], ['благод', 'charity', 'донат']],
  [['інвест', 'invest', 'акці', 'облігац', 'овдп', 'stock'], ['інвест', 'invest']],
  [['будів', 'ремонт', 'епіцентр', 'epicentr', 'construct', 'матеріал', 'нова лінія'], ['будів', 'construct', 'ремонт', 'об\'єкт']],
  [['курс', 'книг', 'навчан', 'освіт', 'educat', 'school', 'школ', 'універ'], ['освіт', 'educat', 'навчан']],
  [['зарплат', 'зп', 'salary', 'payroll', 'аванс'], ['зарплат', 'salary', 'заробітн']],
  [['фриланс', 'freelance', 'upwork', 'fiverr'], ['фриланс', 'freelance']],
  [['подар', 'gift'], ['подар', 'gift']],
  [['відсот', 'депозит', 'кешбек', 'cashback', 'interest', 'дивіденд', 'dividend'], ['відсот', 'interest', 'кешбек', 'cashback', 'пасив']],
  [['бізнес', 'business', 'продаж', 'клієнт', 'sale'], ['бізнес', 'business', 'продаж']],
];

export const ACCOUNT_ALIASES: Array<[string[], string[]]> = [
  // account name contains one of [0] -> phrase may use any of [1]
  [['mono'], ['mono', 'моно']],
  [['privat', 'pryvat', 'приват'], ['privat', 'pryvat', 'приват']],
  [['cash', 'готів', 'гот', 'кеш', 'налич'], ['cash', 'готів', 'кеш', 'налич', 'кешем']],
  [['pumb', 'пумб'], ['pumb', 'пумб']],
  [['oschad', 'ощад'], ['oschad', 'ощад']],
  [['home', 'дом', 'вдома'], ['home', 'вдома', 'домашн', 'сейф']],
  [['sense', 'сенс'], ['sense', 'сенс']],
  [['abank', 'a-bank', 'а-банк'], ['abank', 'a-bank', 'а-банк', 'абанк']],
  [['business', 'бізнес', 'фоп', 'fop'], ['business', 'бізнес', 'фоп', 'fop']],
];

const STOP_WORDS = new Set(['я', 'на', 'в', 'у', 'за', 'з', 'із', 'зі', 'до', 'по', 'і', 'й', 'та', 'a', 'the', 'at', 'on', 'in', 'for', 'with', 'using', 'from', 'to', 'of', 'and', 'my', 'via', 'by', 'через', 'картк', 'карткою', 'card', 'рахунк', 'рахунку', 'рахунок', 'account', 'тис', 'тисяч', 'тисячі', 'тисячу', 'k', 'thousand']);

// ---------- matching ----------

function stemMatch(token: string, stem: string): boolean {
  const t = norm(token);
  const s = norm(stem);
  if (s.length <= 3) return t.startsWith(s) && t.length <= s.length + 3;
  return t.startsWith(s) || translit(t).startsWith(translit(s));
}

/** Construction objects spoken as «ПВ-5», «пв 5», «PV5». */
export const OBJECT_CODE_RE = /(?<!\p{L})(пв|pv)[\s-]?(\d{1,2})(?!\d)/giu;
/** Words too generic to identify a category by themselves («Витрати ПВ-5», «Особисті доходи»). */
const GENERIC_NAME_WORDS = new Set(['витрати', 'витрат', 'особисті', 'особисті', 'доходи', 'дохід', 'послуги', 'інші', 'інше', 'інший', 'надходження', 'expenses', 'income', 'other']);

export function matchCategory(text: string, categories: ParseCategory[], type: 'income' | 'expense' | null) {
  const pool = categories.filter((c) => !c.is_archived && (!type || c.type === type));
  const scores = new Map<string, number>();
  const usedTokens = new Set<string>();
  // 0) object codes like «ПВ-5» pick the object's category directly
  for (const m of norm(text).matchAll(OBJECT_CODE_RE)) {
    const code = `пв-${m[2]}`;
    for (const c of pool) {
      const n = norm(c.name).replace(/pv/g, 'пв').replace(/пв\s*-?\s*(\d)/g, 'пв-$1');
      if (new RegExp(`(?<!\\p{L})${code}(?!\\d)`, 'u').test(n)) scores.set(c.id, (scores.get(c.id) ?? 0) + 10);
    }
  }
  const toks = words(text.replace(OBJECT_CODE_RE, ' ')).filter((t) => !/^\d+$/.test(t));
  // 1) direct category-name match (strong)
  for (const c of pool) {
    for (const nameWord of words(c.name)) {
      if (/^\d+$/.test(nameWord) || nameWord.length < 2 || GENERIC_NAME_WORDS.has(nameWord)) continue;
      const stem = nameWord.length > 5 ? nameWord.slice(0, Math.max(4, nameWord.length - 2)) : nameWord;
      for (const t of toks) {
        if (stemMatch(t, stem)) {
          scores.set(c.id, (scores.get(c.id) ?? 0) + 3);
          usedTokens.add(t);
        }
      }
    }
  }
  // 2) synonym match
  for (const [keys, nameStems] of CATEGORY_SYNONYMS) {
    const hitToken = toks.find((t) => keys.some((k) => stemMatch(t, k)));
    const phraseHit = !hitToken && keys.some((k) => k.includes(' ') && norm(text).includes(k));
    if (!hitToken && !phraseHit) continue;
    if (hitToken) usedTokens.add(hitToken);
    for (const c of pool) {
      if (words(c.name).some((w) => nameStems.some((s) => stemMatch(w, s)))) scores.set(c.id, (scores.get(c.id) ?? 0) + 2);
    }
  }
  // «продукти» should prefer «Продукти» over «Розробка продукту»: penalise name words nobody said
  for (const [id, sc] of scores) {
    const c = pool.find((x) => x.id === id);
    if (!c || sc >= 10) continue;
    let miss = 0;
    for (const w of words(c.name)) {
      if (/^\d+$/.test(w) || w.length < 3 || GENERIC_NAME_WORDS.has(w)) continue;
      const stem = w.length > 5 ? w.slice(0, Math.max(4, w.length - 2)) : w;
      if (!toks.some((t) => stemMatch(t, stem))) miss++;
    }
    scores.set(id, sc - miss * 0.5);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { id: null as string | null, ambiguous: false, usedTokens };
  const ambiguous = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  return { id: ambiguous ? null : ranked[0][0], ambiguous, usedTokens, candidates: ranked.map((r) => r[0]) };
}

export function matchAccounts(text: string, accounts: ParseAccount[]) {
  const toks = words(text);
  const tl = toks.map(translit);
  const hits = new Map<string, number>();
  const usedTokens = new Set<string>();
  for (const a of accounts.filter((x) => !x.is_archived)) {
    const nameTl = translit(a.name);
    let score = 0;
    // name words (>=3 chars, not currency codes)
    for (const w of words(a.name)) {
      if (w.length < 3 || /^(uah|usd|eur|pln|gbp|грн)$/i.test(w)) continue;
      const wt = translit(w);
      toks.forEach((t, i) => {
        if (tl[i].startsWith(wt) || (wt.length >= 4 && tl[i].length >= 4 && wt.startsWith(tl[i]))) { score += 3; usedTokens.add(t); }
      });
    }
    for (const [nameKeys, phraseKeys] of ACCOUNT_ALIASES) {
      if (!nameKeys.some((k) => nameTl.includes(translit(k)))) continue;
      toks.forEach((t, i) => {
        if (phraseKeys.some((k) => tl[i].startsWith(translit(k)))) { score += 2; usedTokens.add(t); }
      });
    }
    for (const kw of (a.sms_keywords ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
      if (norm(text).includes(norm(kw))) { score += 4; }
    }
    if (score > 0) {
      // «Деп Моно» should lose to «Моно» when only «моно» was said: penalise name words nobody mentioned
      for (const w of words(a.name)) {
        if (w.length < 3 || /^(uah|usd|eur|pln|gbp|грн)$/i.test(w)) continue;
        const wt = translit(w);
        if (!tl.some((t) => t.startsWith(wt) || (wt.length >= 4 && t.length >= 4 && wt.startsWith(t)))) score -= 2;
      }
      hits.set(a.id, Math.max(score, 1));
    }
  }
  const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  const ranked = sorted.map(([id]) => id);
  /** the single best account when it clearly beats the rest */
  const best = sorted.length === 1 || (sorted.length > 1 && sorted[0][1] > sorted[1][1]) ? sorted[0][0] : null;
  return { ranked, usedTokens, best };
}

export function detectCurrency(text: string): string | null {
  for (const [re, code] of CURRENCY_WORDS) if (re.test(text)) return code;
  return null;
}

/** Extracts amounts in major units as decimal strings, e.g. "1,250" -> "1250", "2 тисячі" -> "2000", "99,90" -> "99.90". */
export function extractAmounts(text: string): string[] {
  text = text.replace(OBJECT_CODE_RE, ' ');
  const out: string[] = [];
  const re = /(?<![\d*])(\d{1,3}(?:[  ]\d{3})+|\d{1,3}(?:,\d{3})+(?![\d,])|\d+)(?:[.,](\d{1,2}))?(?!\d)\s*(тис\p{L}*|k\b|thousand)?/giu;
  for (const m of text.matchAll(re)) {
    const intPart = m[1].replace(/[  ,]/g, '');
    let value = m[2] ? `${intPart}.${m[2].padEnd(2, '0')}` : intPart;
    if (m[3]) {
      const [i, f = ''] = value.split('.');
      const frac = (f + '000').slice(0, 3);
      value = String(BigInt(i) * 1000n + BigInt(frac));
    }
    value = value.replace(/^0+(?=\d)/, '');
    if (value !== '0' && !/^0\.00$/.test(value)) out.push(value);
  }
  return out;
}

function detectType(text: string): 'income' | 'expense' | null {
  const toks = words(text);
  let first: { type: 'income' | 'expense'; idx: number } | null = null;
  toks.forEach((t, idx) => {
    if (first) return;
    if (EXPENSE_WORDS.some((w) => t.startsWith(w))) first = { type: 'expense', idx };
    else if (INCOME_WORDS.some((w) => t.startsWith(w))) first = { type: 'income', idx };
  });
  return first ? (first as { type: 'income' | 'expense' }).type : null;
}

function detectDate(text: string, now: Date): Date {
  const t = norm(text);
  const d = new Date(now);
  if (/позавчора|day before yesterday/.test(t)) d.setDate(d.getDate() - 2);
  else if (/вчора|yesterday/.test(t)) d.setDate(d.getDate() - 1);
  return d;
}

// ---------- voice ----------

export function parseVoice(
  text: string,
  accounts: ParseAccount[],
  categories: ParseCategory[],
  opts: { defaultType?: 'income' | 'expense'; now?: Date; lang?: 'uk' | 'en' } = {},
): Draft {
  const en = opts.lang === 'en';
  const q = (uk: string, eng: string) => (en ? eng : uk);
  const missing: Draft['missing'] = [];
  const questions: string[] = [];

  let type = detectType(text);
  const amounts = [...new Set(extractAmounts(text))];
  let currency = detectCurrency(text);
  const accMatch = matchAccounts(text, accounts);
  let catMatch = matchCategory(text, categories, type);
  if (!type && catMatch.id) type = categories.find((c) => c.id === catMatch.id)!.type;
  if (!type) type = opts.defaultType ?? null;
  if (type && !catMatch.id) catMatch = matchCategory(text, categories, type);

  // account
  let accountId: string | null = null;
  let accRanked = accMatch.ranked;
  if (currency) {
    const sameCur = accRanked.filter((id) => accounts.find((a) => a.id === id)?.currency === currency);
    if (sameCur.length) accRanked = sameCur;
  }
  if (accRanked.length === 1) accountId = accRanked[0];
  else if (accRanked.length > 1 && accMatch.best && accRanked.includes(accMatch.best)) accountId = accMatch.best;
  else if (accRanked.length > 1) {
    questions.push(q('Який рахунок використати?', 'Which account should be used?'));
  }
  const account = accounts.find((a) => a.id === accountId);
  if (account && currency && account.currency !== currency) {
    questions.push(
      q(`Рахунок «${account.name}» у ${account.currency}, а у фразі ${currency}. Оберіть рахунок у ${currency} або зробіть переказ з обміном.`,
        `Account "${account.name}" is in ${account.currency} but the phrase says ${currency}. Pick a ${currency} account or use a currency transfer.`),
    );
    accountId = null;
  }
  if (!currency && account) currency = account.currency;

  if (!type) { missing.push('type'); questions.push(q('Це витрата чи дохід?', 'Is this an expense or income?')); }
  if (amounts.length === 0) { missing.push('amount'); questions.push(q('Яка сума?', 'What is the amount?')); }
  else if (amounts.length > 1) { missing.push('amount'); questions.push(q(`Яку суму записати: ${amounts.join(' чи ')}?`, `Which amount: ${amounts.join(' or ')}?`)); }
  if (!accountId) { missing.push('account'); if (!accRanked.length) questions.push(q('З якого рахунку?', 'Which account?')); }
  if (!currency) missing.push('currency');
  if (!catMatch.id) { missing.push('category'); questions.push(q('Яка категорія?', 'Which category?')); }

  // comment: words not consumed by recognition
  const consumed = new Set<string>([...accMatch.usedTokens, ...catMatch.usedTokens]);
  const commentWords = text
    .replace(/(\d[\d\s.,]*)/g, ' ')
    .split(/\s+/)
    .filter((w) => {
      const n = norm(w).replace(/[.,!?]/g, '');
      if (!n) return false;
      if (consumed.has(n) || STOP_WORDS.has(n)) return false;
      if (EXPENSE_WORDS.some((x) => n.startsWith(x)) || INCOME_WORDS.some((x) => n.startsWith(x))) return false;
      if (detectCurrency(n)) return false;
      if (/^(вчора|позавчора|yesterday|сьогодні|today)$/.test(n)) return false;
      return true;
    });

  return {
    type,
    amount: amounts.length === 1 ? amounts[0] : null,
    currency,
    accountId,
    categoryId: catMatch.id,
    comment: commentWords.join(' ').trim(),
    occurredAt: detectDate(text, opts.now ?? new Date()).toISOString(),
    missing,
    questions,
    candidates: {
      accounts: accRanked.length ? accRanked : accounts.filter((a) => !a.is_archived && (!currency || a.currency === currency)).map((a) => a.id),
      amounts,
    },
  };
}

// ---------- SMS ----------

const BALANCE_RE = /(бал(?:\.|анс)?|залишок|доступно|достп|balance|bal\.|avail(?:able)?|ост(?:\.|аток))/iu;
const BANKS: Array<[RegExp, string]> = [
  [/privat|приват/i, 'PrivatBank'],
  [/mono|монобанк/i, 'monobank'],
  [/pumb|пумб/i, 'PUMB'],
  [/oschad|ощад/i, 'Oschadbank'],
  [/a-?bank|а-?банк/i, 'A-Bank'],
  [/sense/i, 'Sense Bank'],
  [/raiffeisen|райф/i, 'Raiffeisen'],
];

interface MoneyMention { index: number; end: number; amount: string; currency: string; sign: '' | '+' | '-' }

function moneyMentions(text: string): MoneyMention[] {
  const cur = '(UAH|грн\\.?|₴|USD|\\$|EUR|€|PLN|GBP|£)';
  const num = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)(?:[.,](\\d{1,2}))?';
  const re1 = new RegExp(`([+\\-−–])?\\s?${num}\\s?${cur}`, 'giu');
  const re2 = new RegExp(`([+\\-−–])?\\s?${cur}\\s?${num}`, 'giu');
  const out: MoneyMention[] = [];
  const toCode = (c: string) => detectCurrency(c) ?? (c === '$' ? 'USD' : 'UAH');
  for (const m of text.matchAll(re1)) {
    const amount = m[3] ? `${m[2].replace(/[  ]/g, '')}.${m[3].padEnd(2, '0')}` : m[2].replace(/[  ]/g, '');
    out.push({ index: m.index!, end: m.index! + m[0].length, amount, currency: toCode(m[4]), sign: m[1] ? (m[1] === '+' ? '+' : '-') : '' });
  }
  for (const m of text.matchAll(re2)) {
    if (out.some((o) => m.index! < o.end && o.index < m.index! + m[0].length)) continue;
    const amount = m[4] ? `${m[3].replace(/[  ]/g, '')}.${m[4].padEnd(2, '0')}` : m[3].replace(/[  ]/g, '');
    out.push({ index: m.index!, end: m.index! + m[0].length, amount, currency: toCode(m[2]), sign: m[1] ? (m[1] === '+' ? '+' : '-') : '' });
  }
  return out.sort((a, b) => a.index - b.index);
}

function parseSmsDate(text: string, now: Date, tzOffsetMinutes: number): Date | null {
  // dd.mm(.yy|yyyy) hh:mm
  let m = text.match(/(\d{2})[./](\d{2})(?:[./](\d{2,4}))?\s*(?:о\s*|at\s*|,\s*)?(\d{1,2}):(\d{2})/);
  let y: number, mo: number, d: number, h = 12, mi = 0;
  if (m) {
    d = +m[1]; mo = +m[2]; y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getUTCFullYear(); h = +m[4]; mi = +m[5];
  } else if ((m = text.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/))) {
    y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4]) { h = +m[4]; mi = +m[5]; }
  } else if ((m = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  // components are local time of the user: UTC = local + offset
  return new Date(Date.UTC(y, mo - 1, d, h, mi) + tzOffsetMinutes * 60000);
}

export function parseSms(
  text: string,
  accounts: ParseAccount[],
  categories: ParseCategory[],
  opts: { now?: Date; tzOffsetMinutes?: number; lang?: 'uk' | 'en' } = {},
): SmsDraft {
  const en = opts.lang === 'en';
  const q = (uk: string, eng: string) => (en ? eng : uk);
  const now = opts.now ?? new Date();
  const missing: Draft['missing'] = [];
  const questions: string[] = [];

  const mentions = moneyMentions(text);
  const isBalance = (m: MoneyMention) => BALANCE_RE.test(text.slice(Math.max(0, m.index - 16), m.index));
  const txMention = mentions.find((m) => !isBalance(m)) ?? null;
  const balMention = mentions.find((m) => isBalance(m) && m !== txMention) ?? null;

  let type: 'income' | 'expense' | null = null;
  if (txMention?.sign === '-') type = 'expense';
  else if (txMention?.sign === '+') type = 'income';
  else type = detectType(text);

  const last4 = text.match(/(?:\*{1,6}|\d{4,6}\*{2,8}|картк\p{L}*\s|card\s)(\d{4})\b/iu)?.[1] ?? null;
  const bank = BANKS.find(([re]) => re.test(text))?.[1] ?? null;
  const currency = txMention?.currency ?? null;

  // account: by sms keywords / last4 / bank / name, narrowed by currency
  let ranked: string[] = [];
  const active = accounts.filter((a) => !a.is_archived);
  if (last4) ranked = active.filter((a) => (a.sms_keywords ?? '').includes(last4) || a.name.includes(last4)).map((a) => a.id);
  if (!ranked.length) ranked = matchAccounts(text, active).ranked;
  if (currency) {
    const same = ranked.filter((id) => active.find((a) => a.id === id)?.currency === currency);
    ranked = same;
  }
  const accountId = ranked.length === 1 ? ranked[0] : null;

  // merchant: text right after the amount up to a sentence break / balance word
  let merchant = '';
  if (txMention) {
    merchant = text
      .slice(txMention.end)
      .split(BALANCE_RE)[0]
      .replace(/(на\s+)?(картк\p{L}*|card)\s*\*?\d{0,6}\*+\d{4}|\*+\d{4}/giu, ' ')
      .replace(/\d{2}[./]\d{2}([./]\d{2,4})?(\s*(о|at|,)?\s*\d{1,2}:\d{2})?/g, ' ')
      .replace(/^[\s.,:;-]+/, '')
      .split(/[.;\n]|\s{2,}/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    if (merchant.length > 60) merchant = merchant.slice(0, 60);
  }
  const textForCategory = balMention ? text.slice(0, balMention.index) : text;
  const cat = matchCategory(textForCategory, categories, type);

  if (!txMention) { missing.push('amount'); questions.push(q('Не вдалося знайти суму операції.', 'Could not find the transaction amount.')); }
  if (!type) { missing.push('type'); questions.push(q('Це витрата чи надходження?', 'Is this an expense or income?')); }
  if (!accountId) {
    missing.push('account');
    questions.push(q(`Оберіть рахунок${currency ? ` у ${currency}` : ''}${last4 ? ` (картка *${last4})` : ''}.`, `Choose the account${currency ? ` in ${currency}` : ''}${last4 ? ` (card *${last4})` : ''}.`));
  }
  if (!cat.id) { missing.push('category'); questions.push(q('Оберіть категорію.', 'Choose a category.')); }

  return {
    type,
    amount: txMention?.amount ?? null,
    currency,
    accountId,
    categoryId: cat.id,
    comment: merchant,
    occurredAt: (parseSmsDate(text, now, opts.tzOffsetMinutes ?? 0) ?? now).toISOString(),
    missing,
    questions,
    candidates: { accounts: ranked, amounts: txMention ? [txMention.amount] : [] },
    balance: balMention?.amount ?? null,
    balanceCurrency: balMention?.currency ?? null,
    cardLast4: last4,
    bank,
    merchant,
  };
}

/** Splits a pasted block containing several SMS into separate messages. */
export function splitMessages(block: string): string[] {
  return block.split(/\n\s*\n|\r\n\s*\r\n/).map((s) => s.trim()).filter((s) => s.length > 3);
}
