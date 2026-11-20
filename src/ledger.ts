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
