import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { applyFilters, formatScaled, periodRange, toScaled, totalsByCurrency } from '../src/ledger.js';
import { memoryNotebook } from '../src/notebook.js';
import { createServer } from '../src/server.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const day = (iso: string) => `${iso}T09:00:00Z`;

describe('exact totals', () => {
  it('adds decimals without floating point errors', () => {
    const { totals } = totalsByCurrency([
      { amount: '0.1', invoiceCurrency: 'USDC' },
      { amount: '0.2', invoiceCurrency: 'USDC' },
    ]);
    expect(totals).toEqual([{ currency: 'USDC', total: '0.3', count: 2 }]);
  });

  it('groups by currency, formats thousands, and skips unreadable amounts', () => {
    const { totals, skipped } = totalsByCurrency([
      { amount: '1000', invoiceCurrency: 'USDC' },
      { amount: '250', invoiceCurrency: 'USDC' },
      { amount: '0.5', invoiceCurrency: 'ETH' },
      { amount: 'n/a', invoiceCurrency: 'USDC' },
    ]);
    expect(totals).toEqual([
      { currency: 'USDC', total: '1,250', count: 2 },
      { currency: 'ETH', total: '0.5', count: 1 },
    ]);
    expect(skipped).toBe(1);
  });

  it('round-trips 18 decimals and big numbers', () => {
    expect(formatScaled(toScaled('1234567.000000000000000001')!)).toBe('1,234,567.000000000000000001');
    expect(toScaled('-1')).toBeUndefined();
    expect(toScaled('1e5')).toBeUndefined();
  });
});

describe('filters', () => {
  const items = [
    { id: 'a', hasBeenPaid: false, createdAt: day('2026-11-18') },
    { id: 'b', hasBeenPaid: true, createdAt: day('2026-11-02') },
    { id: 'c', hasBeenPaid: false, createdAt: day('2026-10-15') },
    { id: 'd', hasBeenPaid: false, createdAt: day('2026-01-03') },
    { id: 'e', hasBeenPaid: false },
  ];
  const ids = (f: Parameters<typeof applyFilters>[1]) => applyFilters(items, f, NOW).map((i) => i.id);

  it('filters by status', () => {
    expect(ids({ status: 'unpaid' })).toEqual(['a', 'c', 'd', 'e']);
    expect(ids({ status: 'paid' })).toEqual(['b']);
    expect(ids({})).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters by period', () => {
    expect(ids({ period: 'this_month' })).toEqual(['a', 'b']);
    expect(ids({ period: 'last_month' })).toEqual(['c']);
    expect(ids({ period: 'last_30_days' })).toEqual(['a', 'b']);
    expect(ids({ period: 'this_year' })).toEqual(['a', 'b', 'c', 'd']);
  });

  it('"unpaid and older than 2 weeks"', () => {
    expect(ids({ status: 'unpaid', olderThanDays: 14 })).toEqual(['c', 'd']);
  });

  it('handles month boundaries in January', () => {
    const [start, end] = periodRange('last_month', new Date('2027-01-10T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

// Fake API: 230 invoices to exercise paging, plus recurring create/stop.
function fakeApi() {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const invoices = Array.from({ length: 230 }, (_, i) => ({
    requestId: i.toString(16).padStart(64, '0'),
    amount: i % 2 ? '100' : '0.5',
    invoiceCurrency: i % 2 ? 'USDC' : 'ETH',
    hasBeenPaid: i % 3 === 0,
    createdAt: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
  }));
  const recurring: Record<string, { frequency: string; stopped: boolean }> = {
    ['ab'.repeat(32)]: { frequency: 'MONTHLY', stopped: false },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.search, body });
    if (method === 'GET' && url.pathname === '/v2/request') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return json(200, { requests: invoices.slice(offset, offset + limit), pagination: { total: invoices.length, limit, offset } });
    }
    if (method === 'POST' && url.pathname === '/v2/request') return json(201, { requestId: 'ab'.repeat(32), paymentReference: '0x1' });
    const m = /^\/v2\/request\/([0-9a-f]+)$/.exec(url.pathname);
    if (m && method === 'PATCH') {
      if (!recurring[m[1]]) return json(404, { message: 'Request not found' });
      recurring[m[1]].stopped = body.isRecurrenceStopped;
      return json(200, {});
    }
    if (m) {
      const rec = recurring[m[1]];
      return json(200, {
        requestId: m[1],
        hasBeenPaid: false,
        requestAmount: '500',
        invoiceCurrency: 'USDC',
        recurrence: rec ? { frequency: rec.frequency, startDate: '2026-11-20' } : null,
        isRecurrenceStopped: rec?.stopped ?? false,
      });
    }
    return json(404, { message: 'Not Found' });
  };
  return { fetchImpl, calls, recurring };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect() {
  const config = loadConfig({ REQUEST_API_KEY: 'k', REQUEST_PAYEE: '0x6C13b270e84E69fCB4927352f4913f386Cee9775', REQUEST_NOTES_FILE: 'off' });
  const fake = fakeApi();
  const notebook = memoryNotebook();
  const server = createServer(config, fake.fetchImpl, notebook, () => NOW);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { call, ...fake, notebook };
}

describe('list_invoices totals and filters', () => {
  it('reads every page and totals what is owed', async () => {
    const { call, calls } = await connect();
    const res = await call('list_invoices', { status: 'unpaid' });
    expect(calls.filter((c) => c.path === '/v2/request').length).toBe(3); // 230 invoices = 3 pages of 100
    // Unpaid = i % 3 != 0 → 153 invoices; odd i are 100 USDC, even i are 0.5 ETH.
    expect(res.text).toContain('153 invoice(s) (unpaid), showing 1-20.');
    expect(res.text).toContain("You're owed 7,700 USDC across 77 invoices and 38 ETH across 76 invoices.");
    expect(res.text).not.toContain('Paid:');
  });

  it('"unpaid, older than 2 weeks, this year"', async () => {
    const { call } = await connect();
    const res = await call('list_invoices', { status: 'unpaid', olderThanDays: 14, period: 'this_year', limit: 3 });
    expect(res.text).toMatch(/^\d+ invoice\(s\) \(unpaid, this year, older than 14 days\), showing 1-3\./);
    const dates = [...res.text.matchAll(/\((2026-\d\d-\d\d)\)/g)].map((m) => m[1]);
    expect(dates.every((d) => d <= '2026-11-06' && d >= '2026-01-01')).toBe(true);
  });

  it('says so when nothing matches', async () => {
    const { call } = await connect();
    const res = await call('list_invoices', { who: 'Nobody' });
    expect(res.text).toContain('0 invoice(s) (for "Nobody").');
  });
});

describe('recurring invoices', () => {
  it('"bill Acme 500 USDC every month"', async () => {
    const { call, calls } = await connect();
    const res = await call('create_invoice', { amount: '500', paymentCurrency: 'USDC-base', for: 'Acme', repeat: 'monthly' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Recurring invoice created (monthly, starting 2026-11-20) for Acme');
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ recurrence: { startDate: '2026-11-20', frequency: 'MONTHLY' } });
  });

  it('rejects a start date in the past or without a schedule', async () => {
    const { call, calls } = await connect();
    expect((await call('create_invoice', { amount: '5', paymentCurrency: 'USDC-base', repeat: 'weekly', startDate: '2026-11-19' })).text).toContain("can't be in the past");
    expect((await call('create_invoice', { amount: '5', paymentCurrency: 'USDC-base', startDate: '2026-12-01' })).text).toContain('only for repeating invoices');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows the schedule when checking', async () => {
    const { call } = await connect();
    expect((await call('check_invoice', { requestId: 'ab'.repeat(32) })).text).toContain('Repeats monthly.');
  });

  it('stops and resumes by name', async () => {
    const { call, recurring } = await connect();
    await call('create_invoice', { amount: '500', paymentCurrency: 'USDC-base', for: 'Acme', repeat: 'monthly' });
    const stop = await call('stop_recurring_invoice', { who: 'acme' });
    expect(stop.text).toContain(`Stopped the monthly invoice ${'ab'.repeat(32)}`);
    expect(recurring['ab'.repeat(32)].stopped).toBe(true);
    const resume = await call('stop_recurring_invoice', { requestId: 'ab'.repeat(32), resume: true });
    expect(resume.text).toContain('Resumed');
    expect(recurring['ab'.repeat(32)].stopped).toBe(false);
  });

  it('refuses to stop an invoice that does not repeat', async () => {
    const { call, calls } = await connect();
    const res = await call('stop_recurring_invoice', { requestId: 'cd'.repeat(32) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("isn't recurring");
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('asks which one when a name matches several recurring invoices', async () => {
    const { call, calls, notebook, recurring } = await connect();
    recurring['ef'.repeat(32)] = { frequency: 'WEEKLY', stopped: false };
    notebook.save({ requestId: 'ab'.repeat(32), for: 'Acme', createdAt: '2026-11-01T00:00:00Z' });
    notebook.save({ requestId: 'ef'.repeat(32), for: 'Acme', createdAt: '2026-11-02T00:00:00Z' });
    const res = await call('stop_recurring_invoice', { who: 'Acme' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Several recurring invoices match');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});
