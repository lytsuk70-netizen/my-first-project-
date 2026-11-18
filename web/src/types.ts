export type TxType = 'income' | 'expense';

export interface Account {
  id: string; name: string; type: 'cash' | 'bank' | 'card' | 'savings' | 'debt' | 'other'; currency: string;
  balance: string; initialBalance: string; baseValue: string | null; baseRate: string | null; baseRateDate: string | null; baseRateApproximate: boolean;
  description: string; smsKeywords: string; isArchived: boolean; sortOrder: number; txCount: number; createdAt: string;
}
export interface Category { id: string; name: string; type: TxType; icon: string; color: string; parentId: string | null; isArchived: boolean; sortOrder: number; usage: number }
export interface Project { id: string; name: string; description: string; isArchived: boolean; usage: number }
export interface Currency { code: string; decimals: number; symbol: string; name_uk: string; name_en: string }
export interface Settings { base_currency: string; language: 'uk' | 'en'; timezone: string }

export interface FeedItem {
  id: string; kind: 'income' | 'expense' | 'transfer' | 'correction'; type: string; accountId: string; accountName: string; amount: string; currency: string;
  categoryId: string | null; categoryName: string | null; categoryIcon: string | null; categoryColor: string | null; projectId: string | null; projectName: string | null;
  transferId: string | null; toAccountId: string | null; toAccountName: string | null; amountReceived: string | null; toCurrency: string | null;
  rate: string | null; rateBase: string | null; rateQuote: string | null; occurredAt: string; localDate: string; comment: string; details: string; source: string;
  attachmentCount: number; deletedAt: string | null;
}

export interface Transfer {
  id: string; fromAccountId: string; fromAccountName: string; fromCurrency: string; toAccountId: string; toAccountName: string; toCurrency: string;
  amountSent: string; amountReceived: string; rate: string; rateBase: string; rateQuote: string; occurredAt: string; comment: string; deletedAt: string | null;
}

export interface Draft {
  type: TxType | null; amount: string | null; currency: string | null; accountId: string | null; categoryId: string | null; comment: string; occurredAt: string | null;
  missing: string[]; questions: string[]; candidates: { accounts: string[]; amounts: string[] };
  balance?: string | null; balanceCurrency?: string | null; cardLast4?: string | null; bank?: string | null;
}
