/**
 * Personal Telegram bot (token from @BotFather). Uses long polling, so no public URL is needed.
 * Forward bank SMS / bank-bot notifications or type "200 на таксі з моно" — the bot replies with a
 * draft and buttons; a transaction is created only when the user presses "Записати".
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { addAttachment, confirmDraft, draftReady, getImported, ignoreImported, ingest, parseContext, patchDraft } from '../services/catalog.js';
import { getSettings, listAccounts } from '../services/ledger.js';
import { quickSummary } from '../services/reports.js';
import { runVoiceCommand } from '../services/voice.js';
import { parseSms, type SmsDraft } from '../engine/parser.js';
import { http, IntegrationError } from './http.js';
import { getIntegration, mergeConfig, secretOf, setStatus, upsertIntegration } from './store.js';

const API = 'https://api.telegram.org';

export class Bot {
  constructor(private token: string) {}
  async call<T = any>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    const res = await http(`${API}/bot${this.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new IntegrationError(data.description ?? `Telegram HTTP ${res.status}`, res.status);
    return data.result as T;
  }
  /** Downloads a file sent to the bot (max 8 MB, the attachment limit). */
  async download(fileId: string): Promise<Buffer> {
    const f = await this.call('getFile', { file_id: fileId });
    if (!f.file_path) throw new IntegrationError('Telegram: file is not available');
    if (f.file_size && f.file_size > 8 * 1024 * 1024) throw new IntegrationError('Файл більший за 8 МБ');
    const res = await http(`${API}/file/bot${this.token}/${f.file_path}`);
    if (!res.ok) throw new IntegrationError(`Telegram file HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}

interface TgFile { fileId: string; mime: string; name: string }
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

function fileOf(m: any): TgFile | null {
  if (m.photo?.length) return { fileId: m.photo[m.photo.length - 1].file_id, mime: 'image/jpeg', name: `telegram-${m.message_id}.jpg` };
  if (m.document && ALLOWED.includes(m.document.mime_type)) return { fileId: m.document.file_id, mime: m.document.mime_type, name: m.document.file_name ?? `telegram-${m.message_id}` };
  return null;
}

async function attachFiles(userId: string, bot: Bot, transactionId: string, files: TgFile[]) {
  for (const f of files) {
    const data = await bot.download(f.fileId);
    await addAttachment(userId, transactionId, { filename: f.name, mimeType: f.mime, dataBase64: data.toString('base64') });
  }
}

// ---------- configuration ----------

export async function configureTelegram(userId: string, token: string) {
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw new IntegrationError('Невірний формат токена бота. Скопіюйте його з @BotFather.');
  const me = await new Bot(token.trim()).call('getMe');
  const linkCode = randomBytes(4).toString('hex');
  await upsertIntegration(userId, 'telegram', {
    secret: token.trim(), enabled: true, status: 'ok', lastError: null,
    config: { username: me.username, botName: me.first_name, linkCode, linkCodeExpires: Date.now() + 30 * 60000, offset: 0 },
  });
  restartPoller(userId);
  return telegramStatus(userId);
}

export async function newLinkCode(userId: string) {
  await mergeConfig(userId, 'telegram', { linkCode: randomBytes(4).toString('hex'), linkCodeExpires: Date.now() + 30 * 60000 });
  return telegramStatus(userId);
}

export async function telegramStatus(userId: string) {
  const row = await getIntegration(userId, 'telegram');
  if (!row) return { configured: false };
  const chats = (await pool.query('SELECT chat_id::text AS "chatId", title, created_at AS "linkedAt" FROM telegram_chats WHERE user_id=$1 ORDER BY created_at', [userId])).rows;
  const c = row.config;
  const codeValid = c.linkCodeExpires > Date.now();
  return {
    configured: true, enabled: row.enabled, status: row.status, lastError: row.last_error, username: c.username, botName: c.botName,
    linkCode: codeValid ? c.linkCode : null, linkUrl: codeValid ? `https://t.me/${c.username}?start=${c.linkCode}` : null, chats,
  };
}

export async function unlinkChat(userId: string, chatId: string) {
  await pool.query('DELETE FROM telegram_chats WHERE user_id=$1 AND chat_id=$2', [userId, chatId]);
}

/** Receipts sent to the bot with a draft are attached when the draft is confirmed in the app. */
export async function attachDraftFiles(userId: string, messageId: string, transactionId: string) {
  const msg = await getImported(userId, messageId);
  const files: TgFile[] = msg.parsed?.files ?? [];
  if (!files.length) return;
  const row = await getIntegration(userId, 'telegram');
  if (!row) return;
  await attachFiles(userId, new Bot(secretOf(row)!), transactionId, files);
}

// ---------- message rendering ----------

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

async function renderDraft(userId: string, msgId: string, d: SmsDraft, duplicates: any[] = []) {
  const settings = await getSettings(userId);
  const en = settings.language === 'en';
  const ctx = await parseContext(userId);
  const acc = ctx.accounts.find((a) => a.id === d.accountId);
  const cat = ctx.categories.find((c) => c.id === d.categoryId);
  const lines = [
    d.type === 'income' ? (en ? '💰 <b>Income</b>' : '💰 <b>Дохід</b>') : d.type === 'expense' ? (en ? '💸 <b>Expense</b>' : '💸 <b>Витрата</b>') : '❔',
    `${d.amount ? `<b>${esc(d.amount)} ${esc(d.currency ?? '')}</b>` : '❔ ' + (en ? 'amount?' : 'сума?')}`,
    `🏦 ${acc ? esc(acc.name) : '❔ ' + (en ? 'account?' : 'рахунок?')}`,
    `🏷 ${cat ? esc(cat.name) : '❔ ' + (en ? 'category?' : 'категорія?')}`,
  ];
  if (d.comment) lines.push(`📝 ${esc(d.comment)}`);
  if (d.balance) lines.push(`${en ? 'Bank balance' : 'Баланс за повідомленням'}: ${esc(d.balance)} ${esc(d.balanceCurrency ?? '')}`);
  if (duplicates.length) lines.push(en ? '⚠️ <b>Possible duplicate</b> of an existing operation' : '⚠️ <b>Можливий дублікат</b> уже записаної операції');
  for (const q of d.questions ?? []) if (!/категор|рахунок|account|category/i.test(q)) lines.push(`❓ ${esc(q)}`);

  const kb: Array<Array<{ text: string; callback_data: string }>> = [];
  const short = (id: string) => id.slice(0, 8);
  if (!d.type) kb.push([{ text: en ? 'Expense' : 'Витрата', callback_data: `t:${msgId}:e` }, { text: en ? 'Income' : 'Дохід', callback_data: `t:${msgId}:i` }]);
  else if (!d.accountId) {
    const list = ctx.accounts.filter((a) => !a.is_archived && (!d.currency || a.currency === d.currency)).slice(0, 12);
    for (let i = 0; i < list.length; i += 2) kb.push(list.slice(i, i + 2).map((a) => ({ text: a.name, callback_data: `a:${msgId}:${short(a.id)}` })));
    if (!list.length) lines.push(en ? `No account in ${d.currency}. Create it in the app.` : `Немає рахунку у ${d.currency}. Створіть його в застосунку.`);
  } else if (!d.categoryId) {
    const list = ctx.categories.filter((c) => c.type === d.type && !c.is_archived).slice(0, 15);
    for (let i = 0; i < list.length; i += 3) kb.push(list.slice(i, i + 3).map((c) => ({ text: c.name, callback_data: `k:${msgId}:${short(c.id)}` })));
  }
  const ready = draftReady(d);
  kb.push([
    ...(ready ? [{ text: en ? '✅ Save' : '✅ Записати', callback_data: `c:${msgId}` }] : []),
    { text: en ? '✖️ Skip' : '✖️ Пропустити', callback_data: `x:${msgId}` },
  ]);
  if (!d.amount) lines.push(en ? 'Open the app inbox to fix the amount.' : 'Суму виправте у «Вхідних» у застосунку.');
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

const HELP_UK = `Я записую ваші витрати й доходи в «Гроші ОК».

• Перешліть мені SMS або сповіщення банку (Приват, mono, ПУМБ…) — я розпізнаю суму, рахунок і категорію.
• Або напишіть: «витратив 200 на таксі з моно», «зарплата 30000 на приват».
• Питання: «скільки я витратив цього місяця», «баланс на моно».
• Команди: /balance /today /month /inbox

Нічого не записується без вашого «✅ Записати».`;
const HELP_EN = `I record your expenses and income in Groshi OK.

• Forward a bank SMS or notification — I detect amount, account and category.
• Or type: "spent 200 on taxi with Mono".
• Ask: "how much did I spend this month", "balance on Mono".
• Commands: /balance /today /month /inbox

Nothing is saved until you press "✅ Save".`;

// ---------- update handling ----------

export async function handleUpdate(userId: string, bot: Bot, update: any) {
  const row = await getIntegration(userId, 'telegram');
  if (!row) return;
  const settings = await getSettings(userId);
  const en = settings.language === 'en';

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const linked = chatId && (await pool.query('SELECT 1 FROM telegram_chats WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rowCount;
    if (!linked) { await bot.call('answerCallbackQuery', { callback_query_id: cq.id }); return; }
    const [op, msgId, arg] = String(cq.data ?? '').split(':');
    let toast = '';
    if (op === 'p') {
      try {
        const pending = (row.config.pendingPhotos ?? {})[msgId] as TgFile | undefined;
        const tx = (await pool.query("SELECT t.id, t.amount_minor, t.currency, t.comment FROM transactions t WHERE t.user_id=$1 AND t.deleted_at IS NULL AND t.id::text LIKE $2 LIMIT 1", [userId, `${arg}%`])).rows[0];
        if (!pending || !tx) throw new Error(en ? 'Photo or operation not found' : 'Фото або операцію не знайдено');
        await attachFiles(userId, bot, tx.id, [pending]);
        const rest = { ...(row.config.pendingPhotos ?? {}) }; delete rest[msgId];
        await mergeConfig(userId, 'telegram', { pendingPhotos: rest });
        await bot.call('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: en ? '📎 Receipt attached.' : '📎 Чек прикріплено до операції.' });
        toast = en ? 'Attached' : 'Прикріплено';
      } catch (e: any) { toast = String(e.message).slice(0, 180); }
      await bot.call('answerCallbackQuery', { callback_query_id: cq.id, text: toast || undefined });
      return;
    }
    try {
      const msg = await getImported(userId, msgId);
      if (msg.status !== 'pending') {
        toast = en ? 'Already processed' : 'Вже оброблено';
      } else if (op === 'c') {
        const txId = await confirmDraft(userId, msgId);
        const d = (await getImported(userId, msgId)).parsed as SmsDraft & { files?: TgFile[] };
        if (d.files?.length) await attachFiles(userId, bot, txId, d.files).catch((e) => console.error('attach failed', e));
        const acc = (await listAccounts(userId)).find((a) => a.id === d.accountId);
        await bot.call('editMessageText', {
          chat_id: chatId, message_id: cq.message.message_id, parse_mode: 'HTML',
          text: `✅ ${en ? 'Saved' : 'Записано'}: ${d.type === 'expense' ? '−' : '+'}${esc(d.amount!)} ${esc(d.currency ?? '')}${d.comment ? ' · ' + esc(d.comment) : ''}${d.files?.length ? ' 🧾' : ''}\n${acc ? `🏦 ${esc(acc.name)}: ${esc(acc.balance)} ${esc(acc.currency)}` : ''}`,
        });
        toast = en ? 'Saved' : 'Записано';
      } else if (op === 'x') {
        await ignoreImported(userId, msgId);
        await bot.call('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: en ? '✖️ Skipped' : '✖️ Пропущено' });
      } else {
        const ctx = await parseContext(userId);
        const patch: Partial<SmsDraft> = {};
        if (op === 't') patch.type = arg === 'i' ? 'income' : 'expense';
        if (op === 'a') { const a = ctx.accounts.find((x) => x.id.startsWith(arg)); if (a) { patch.accountId = a.id; patch.currency = a.currency; } }
        if (op === 'k') { const c = ctx.categories.find((x) => x.id.startsWith(arg)); if (c) patch.categoryId = c.id; }
        if (op === 't') patch.categoryId = null;
        const d = await patchDraft(userId, msgId, patch);
        const view = await renderDraft(userId, msgId, d);
        await bot.call('editMessageText', { chat_id: chatId, message_id: cq.message.message_id, parse_mode: 'HTML', ...view });
      }
    } catch (e: any) {
      toast = (e.message ?? 'Error').slice(0, 180);
    }
    await bot.call('answerCallbackQuery', { callback_query_id: cq.id, text: toast || undefined });
    return;
  }

  const m = update.message ?? update.channel_post;
  if (!m) return;
  const chatId = m.chat.id;
  const text: string = (m.text ?? m.caption ?? '').trim();
  const reply = (t: string, extra: object = {}) => bot.call('sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML', reply_to_message_id: m.message_id, ...extra });

  const linked = (await pool.query('SELECT 1 FROM telegram_chats WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rowCount;
  if (!linked) {
    const code = text.match(/^\/start(?:@\w+)?\s+([0-9a-f]{8})$/i)?.[1];
    const c = row.config;
    if (code && code === c.linkCode && c.linkCodeExpires > Date.now()) {
      const title = m.chat.title ?? [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') ?? '';
      await pool.query('INSERT INTO telegram_chats (chat_id, user_id, title) VALUES ($1,$2,$3) ON CONFLICT (chat_id) DO UPDATE SET user_id=$2, title=$3', [chatId, userId, title]);
      await mergeConfig(userId, 'telegram', { linkCode: null, linkCodeExpires: 0 });
      await reply(`✅ ${en ? 'Connected to Groshi OK.' : 'Підключено до «Гроші ОК».'}\n\n${en ? HELP_EN : HELP_UK}`);
    } else {
      await reply(en ? 'This bot is private. Open Groshi OK → Menu → Bank connections and send the /start code shown there.' : 'Це приватний бот. Відкрийте «Гроші ОК» → Меню → Підключення банків і надішліть показаний там код /start.');
    }
    return;
  }

  if (m.voice || m.audio) {
    await reply(en
      ? 'I cannot transcribe Telegram voice notes. Use the microphone on your keyboard to dictate text, or the voice button in the app.'
      : 'Голосові повідомлення Telegram я не розшифровую. Надиктуйте текст мікрофоном на клавіатурі або скористайтеся голосовою кнопкою в застосунку.');
    return;
  }
  const file = fileOf(m);
  if (m.document && !file) { await reply(en ? 'Supported files: photos, JPEG/PNG/WEBP/HEIC images and PDF.' : 'Підтримуються фото, зображення JPEG/PNG/WEBP/HEIC і PDF.'); return; }
  if (file && !/\d/.test(text)) {
    // A receipt without an amount: offer to attach it to one of the recent operations.
    const recent = (await pool.query(
      `SELECT t.id, t.type, t.amount_minor, t.currency, t.comment, c.name AS category FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
        WHERE t.user_id=$1 AND t.deleted_at IS NULL AND t.type IN ('income','expense') ORDER BY t.created_at DESC LIMIT 6`, [userId])).rows;
    const pending = { ...(row.config.pendingPhotos ?? {}), [m.message_id]: file };
    const keys = Object.keys(pending); for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete pending[k];
    await mergeConfig(userId, 'telegram', { pendingPhotos: pending });
    if (!recent.length) { await reply(en ? 'Add a caption with the amount, e.g. "250 АТБ", to create an operation with this receipt.' : 'Додайте підпис із сумою, напр. «250 АТБ», щоб створити операцію з цим чеком.'); return; }
    const cur = await import('../services/ledger.js').then((x) => x.currencies());
    const label = (t: any) => {
      const d = cur[t.currency].decimals; const s = String(t.amount_minor).padStart(d + 1, '0');
      return `${t.type === 'expense' ? '−' : '+'}${d ? s.slice(0, -d) + ',' + s.slice(-d) : s} ${t.currency} · ${(t.comment || t.category || '').slice(0, 24)}`;
    };
    await reply(en ? '🧾 Attach this receipt to which operation? Or resend it with a caption like "250 АТБ" to create a new one.' : '🧾 До якої операції прикріпити чек? Або надішліть його з підписом, напр. «250 АТБ», щоб створити нову.', {
      reply_markup: { inline_keyboard: recent.map((t) => [{ text: label(t), callback_data: `p:${m.message_id}:${String(t.id).slice(0, 8)}` }]) },
    });
    return;
  }
  if (!text) return;
  if (/^\/(start|help)\b/.test(text)) { await reply(en ? HELP_EN : HELP_UK); return; }
  if (/^\/balance\b/.test(text)) { await reply(esc((await runVoiceCommand(userId, en ? 'balance' : 'баланс')).answer)); return; }
  if (/^\/(today|month)\b/.test(text)) {
    const s = await quickSummary(userId, 'expense');
    const inc = await quickSummary(userId, 'income');
    const isToday = text.startsWith('/today');
    await reply(en
      ? `${isToday ? 'Today' : 'This month'}: spent <b>${isToday ? s.today : s.month} ${s.baseCurrency}</b>, earned <b>${isToday ? inc.today : inc.month} ${s.baseCurrency}</b>`
      : `${isToday ? 'Сьогодні' : 'Цього місяця'}: витрачено <b>${isToday ? s.today : s.month} ${s.baseCurrency}</b>, отримано <b>${isToday ? inc.today : inc.month} ${s.baseCurrency}</b>`);
    return;
  }
  if (/^\/inbox\b/.test(text)) {
    const n = (await pool.query("SELECT count(*)::int AS n FROM imported_messages WHERE user_id=$1 AND status='pending'", [userId])).rows[0].n;
    await reply(en ? `Pending in the inbox: ${n}` : `Очікують підтвердження у «Вхідних»: ${n}`);
    return;
  }

  // A bank notification (amount with a currency) goes straight to the inbox; anything else is a command or phrase.
  const bankLike = !!parseSms(text, [], []).amount;
  const voice = bankLike ? null : await runVoiceCommand(userId, text);
  const intent = voice?.command.intent ?? 'transaction';
  if (voice && (intent === 'balance' || intent === 'total')) { await reply(esc(voice.answer)); return; }
  if (intent === 'transfer') {
    await reply(en ? 'Transfers are confirmed in the app (Accounts → Transfers) or with the app voice button.' : 'Перекази підтверджуйте в застосунку (Рахунки → Перекази) або голосовою кнопкою в застосунку.');
    return;
  }

  const item = await ingest(userId, text, { source: 'telegram', externalId: `tg:${chatId}:${m.message_id}` });
  if (file && item.status === 'pending') item.draft = await patchDraft(userId, item.id, { files: [file] } as any);
  if (!item.draft.amount && intent !== 'transaction') {
    await reply(en ? 'I could not find an amount. Forward a bank message or write e.g. "200 taxi mono".' : 'Не знайшов суми. Перешліть повідомлення банку або напишіть, напр., «200 таксі моно».');
    return;
  }
  const view = await renderDraft(userId, item.id, item.draft, item.duplicates);
  await reply(view.text, { reply_markup: view.reply_markup });
}

// ---------- long-polling worker ----------

const pollers = new Map<string, { stop: () => void }>();

export function restartPoller(userId: string) {
  pollers.get(userId)?.stop();
  pollers.delete(userId);
  startPoller(userId);
}

export function stopPoller(userId: string) {
  pollers.get(userId)?.stop();
  pollers.delete(userId);
}

function startPoller(userId: string) {
  let stopped = false;
  const ctrl = new AbortController();
  pollers.set(userId, { stop: () => { stopped = true; ctrl.abort(); } });
  (async () => {
    let backoff = 5000;
    while (!stopped) {
      const row = await getIntegration(userId, 'telegram').catch(() => null);
      if (!row || !row.enabled) return;
      const bot = new Bot(secretOf(row)!);
      try {
        const updates: any[] = await bot.call('getUpdates', { offset: row.config.offset ?? 0, timeout: 25, allowed_updates: ['message', 'callback_query', 'channel_post'] }, ctrl.signal);
        for (const u of updates) {
          try { await handleUpdate(userId, bot, u); } catch (e) { console.error('telegram update failed', e); }
          await mergeConfig(userId, 'telegram', { offset: u.update_id + 1 });
        }
        if (row.status !== 'ok') await setStatus(userId, 'telegram', 'ok', null, true);
        backoff = 5000;
      } catch (e: any) {
        if (stopped) return;
        const fatal = e instanceof IntegrationError && (e.status === 401 || e.status === 404);
        await setStatus(userId, 'telegram', fatal ? 'invalid_token' : 'error', String(e.message ?? e)).catch(() => {});
        if (fatal) return;
        if (e instanceof IntegrationError && e.status === 409) {
          // A webhook is set on this bot: remove it so long polling can work.
          await bot.call('deleteWebhook').catch(() => {});
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 5 * 60000);
      }
    }
  })();
}

export async function startAllTelegram() {
  const rows = (await pool.query("SELECT user_id FROM integrations WHERE kind='telegram' AND enabled")).rows;
  for (const r of rows) startPoller(r.user_id);
}
