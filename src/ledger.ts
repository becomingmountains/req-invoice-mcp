// Pure helpers for "who owes me what": filters by status and date, and exact per-currency totals.

export type StatusFilter = 'unpaid' | 'paid' | 'all';
export type Period = 'this_month' | 'last_month' | 'last_30_days' | 'this_year';

export interface LedgerItem {
  amount?: string;
  invoiceCurrency?: string;
  hasBeenPaid?: boolean;
  createdAt?: string;
}

export interface Filters {
  status?: StatusFilter;
  period?: Period;
  /** Only invoices created at least this many days ago (e.g. 14 for "older than 2 weeks"). */
  olderThanDays?: number;
}

/** [start, end) of a period in UTC. */
export function periodRange(period: Period, now: Date): [Date, Date] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case 'this_month':
      return [new Date(Date.UTC(y, m, 1)), new Date(Date.UTC(y, m + 1, 1))];
    case 'last_month':
      return [new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1))];
    case 'last_30_days':
      return [new Date(now.getTime() - 30 * 86_400_000), new Date(now.getTime() + 1)];
    case 'this_year':
      return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1))];
  }
}

export function applyFilters<T extends LedgerItem>(items: T[], filters: Filters, now: Date): T[] {
  const range = filters.period ? periodRange(filters.period, now) : undefined;
  const cutoff = filters.olderThanDays !== undefined ? now.getTime() - filters.olderThanDays * 86_400_000 : undefined;
  return items.filter((item) => {
    if (filters.status === 'unpaid' && item.hasBeenPaid) return false;
    if (filters.status === 'paid' && !item.hasBeenPaid) return false;
    if (range || cutoff !== undefined) {
      const t = item.createdAt ? Date.parse(item.createdAt) : NaN;
      if (Number.isNaN(t)) return false;
      if (range && (t < range[0].getTime() || t >= range[1].getTime())) return false;
      if (cutoff !== undefined && t > cutoff) return false;
    }
    return true;
  });
}

const SCALE = 18;

/** Parses a human decimal string into an integer scaled by 10^18. Returns undefined for anything else. */
export function toScaled(amount: string | undefined): bigint | undefined {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(amount ?? '');
  if (!m) return undefined;
  const frac = (m[2] ?? '').slice(0, SCALE).padEnd(SCALE, '0');
  return BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt(frac);
}

/** Formats a scaled integer as "1,250.5". */
export function formatScaled(value: bigint): string {
  const whole = value / 10n ** BigInt(SCALE);
  const frac = (value % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

export interface CurrencyTotal {
  currency: string;
  total: string;
  count: number;
}

/** Exact sums per invoice currency, largest count first. Items with unreadable amounts are counted as skipped. */
export function totalsByCurrency(items: LedgerItem[]): { totals: CurrencyTotal[]; skipped: number } {
  const sums = new Map<string, { value: bigint; count: number }>();
  let skipped = 0;
  for (const item of items) {
    const value = toScaled(item.amount);
    if (value === undefined) {
      skipped++;
      continue;
    }
    const currency = item.invoiceCurrency || '?';
    const cur = sums.get(currency) ?? { value: 0n, count: 0 };
    sums.set(currency, { value: cur.value + value, count: cur.count + 1 });
  }
  const totals = [...sums]
    .map(([currency, { value, count }]) => ({ currency, total: formatScaled(value), count }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
  return { totals, skipped };
}

/** "1,250 USDC across 4 invoices and 0.5 ETH across 1 invoice" */
export function describeTotals(totals: CurrencyTotal[]): string {
  return totals
    .map((t) => `${t.total} ${t.currency} across ${t.count} invoice${t.count === 1 ? '' : 's'}`)
    .join(' and ');
}

export type PaymentState = 'unpaid' | 'partly_paid' | 'paid' | 'overpaid';

export interface BalanceInput {
  hasBeenPaid?: boolean;
  requestAmount?: string | null;
  invoiceCurrency?: string | null;
  payments?: { amount?: string; currency?: string; paymentCurrency?: string; excessAmount?: string | null; excessCurrency?: string | null }[];
  conversionBreakdown?: { paidAmount?: string; remainingAmount?: string } | null;
}

export interface Balance {
  state: PaymentState;
  currency: string;
  asked: string;
  /** Amount received toward the invoice, in the invoice currency. */
  received?: string;
  /** Still owed, when part-paid. */
  remaining?: string;
  /** Amount above what was asked, e.g. "10 USDC". */
  over?: string;
}

/**
 * Compares what was received with what was asked. Payment amounts are in the invoice currency.
 * When a payment was converted from another currency, differences under 0.5% count as exact.
 */
export function paymentBalance(s: BalanceInput): Balance | undefined {
  const asked = toScaled(s.requestAmount ?? undefined);
  if (asked === undefined || asked === 0n) return undefined;
  const currency = s.invoiceCurrency || '?';
  const same = (c?: string | null) => !c || c.toLowerCase() === currency.toLowerCase();
  const payments = s.payments ?? [];
  const base = { currency, asked: formatScaled(asked) };

  let received: bigint | undefined = toScaled(s.conversionBreakdown?.paidAmount);
  if (received === undefined && payments.length) {
    received = 0n;
    for (const p of payments) {
      const v = toScaled(p.amount);
      if (v === undefined || !same(p.currency)) return { ...base, state: s.hasBeenPaid ? 'paid' : 'unpaid' };
      received += v;
    }
  }
  if (received === undefined || received === 0n) return { ...base, state: s.hasBeenPaid ? 'paid' : 'unpaid' };

  const converted = payments.some((p) => p.paymentCurrency && !same(p.paymentCurrency));
  const tolerance = converted ? asked / 200n : 0n;
  const excess = payments
    .map((p) => ({ v: toScaled(p.excessAmount ?? undefined), c: p.excessCurrency || currency }))
    .filter((e): e is { v: bigint; c: string } => e.v !== undefined && e.v > 0n);

  if (received > asked + tolerance) {
    return { ...base, state: 'overpaid', received: formatScaled(received), over: `${formatScaled(received - asked)} ${currency}` };
  }
  if (excess.length) {
    const over = excess.map((e) => `${formatScaled(e.v)} ${e.c}`).join(' and ');
    return { ...base, state: 'overpaid', received: formatScaled(received), over };
  }
  if (!s.hasBeenPaid && received + tolerance < asked) {
    const remaining = toScaled(s.conversionBreakdown?.remainingAmount) ?? asked - received;
    return { ...base, state: 'partly_paid', received: formatScaled(received), remaining: formatScaled(remaining) };
  }
  return { ...base, state: s.hasBeenPaid ? 'paid' : 'unpaid', received: formatScaled(received) };
}

/** One line for check_invoice, or '' when the amount received matches. */
export function describeBalance(b: Balance | undefined): string {
  if (b?.state === 'partly_paid') {
    return `Short payment: received ${b.received} of ${b.asked} ${b.currency}, so ${b.remaining} ${b.currency} is still owed.`;
  }
  if (b?.state === 'overpaid') {
    return `Overpaid: received ${b.over} more than the ${b.asked} ${b.currency} asked. You may want to refund or credit it.`;
  }
  return '';
}
