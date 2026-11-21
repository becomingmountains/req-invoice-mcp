import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { describeBalance, paymentBalance } from '../src/ledger.js';
import { memoryNotebook } from '../src/notebook.js';
import { createServer } from '../src/server.js';

const pay = (amount: string, extra: Record<string, unknown> = {}) => ({ amount, currency: 'USDC', paymentCurrency: 'USDC', ...extra });

describe('paymentBalance', () => {
  it('flags a short payment and what is still owed', () => {
    const b = paymentBalance({ hasBeenPaid: false, requestAmount: '100', invoiceCurrency: 'USDC', payments: [pay('75')] });
    expect(b).toMatchObject({ state: 'partly_paid', received: '75', remaining: '25' });
    expect(describeBalance(b)).toBe('Short payment: received 75 of 100 USDC, so 25 USDC is still owed.');
  });

  it('adds up several part payments exactly', () => {
    const b = paymentBalance({ hasBeenPaid: false, requestAmount: '1', invoiceCurrency: 'USDC', payments: [pay('0.1'), pay('0.2')] });
    expect(b).toMatchObject({ state: 'partly_paid', received: '0.3', remaining: '0.7' });
  });

  it('prefers the API breakdown when present', () => {
    const b = paymentBalance({
      hasBeenPaid: false,
      requestAmount: '100.00',
      invoiceCurrency: 'USD',
      payments: [{ amount: '75.00', currency: 'USD', paymentCurrency: 'ETH' }],
      conversionBreakdown: { paidAmount: '75.00', remainingAmount: '25.00' },
    });
    expect(b).toMatchObject({ state: 'partly_paid', remaining: '25' });
  });

  it('flags an overpayment', () => {
    const b = paymentBalance({ hasBeenPaid: true, requestAmount: '100', invoiceCurrency: 'USDC', payments: [pay('60'), pay('50')] });
    expect(b).toMatchObject({ state: 'overpaid', over: '10 USDC' });
    expect(describeBalance(b)).toContain('received 10 USDC more than the 100 USDC asked');
  });

  it('flags excess the route delivered above the invoice', () => {
    const b = paymentBalance({
      hasBeenPaid: true,
      requestAmount: '100',
      invoiceCurrency: 'USDC',
      payments: [pay('100', { excessAmount: '3.5', excessCurrency: 'USDC' })],
    });
    expect(b).toMatchObject({ state: 'overpaid', over: '3.5 USDC' });
  });

  it('treats an exact payment as paid, matching the real Sepolia response', () => {
    const b = paymentBalance({
      hasBeenPaid: true,
      requestAmount: '1',
      invoiceCurrency: 'fUSDC',
      payments: [{ amount: '1.0', currency: 'fUSDC', paymentCurrency: 'fUSDC', excessAmount: null, excessCurrency: null }],
    });
    expect(b).toMatchObject({ state: 'paid', received: '1' });
    expect(describeBalance(b)).toBe('');
  });

  it('ignores rounding under 0.5% when the payment was converted', () => {
    const conv = (amount: string) => ({ amount, currency: 'USD', paymentCurrency: 'ETH' });
    expect(paymentBalance({ hasBeenPaid: true, requestAmount: '100', invoiceCurrency: 'USD', payments: [conv('100.3')] })?.state).toBe('paid');
    expect(paymentBalance({ hasBeenPaid: true, requestAmount: '100', invoiceCurrency: 'USD', payments: [conv('101')] })?.state).toBe('overpaid');
  });

  it('does not guess when amounts are in another currency or missing', () => {
    expect(
      paymentBalance({ hasBeenPaid: false, requestAmount: '100', invoiceCurrency: 'USD', payments: [{ amount: '0.03', currency: 'ETH' }] })?.state,
    ).toBe('unpaid');
    expect(paymentBalance({ hasBeenPaid: false, requestAmount: '100', invoiceCurrency: 'USDC', payments: [] })?.state).toBe('unpaid');
    expect(paymentBalance({ hasBeenPaid: true, requestAmount: undefined, invoiceCurrency: 'USDC' })).toBeUndefined();
  });
});

// Fake API with one invoice of each kind.
const ID = { short: 'a1'.repeat(32), over: 'b2'.repeat(32), exact: 'c3'.repeat(32), none: 'd4'.repeat(32) };
const DETAILS: Record<string, unknown> = {
  [ID.short]: { hasBeenPaid: false, requestAmount: '100', invoiceCurrency: 'USDC', payments: [pay('75')] },
  [ID.over]: { hasBeenPaid: true, requestAmount: '50', invoiceCurrency: 'USDC', payments: [pay('55')] },
  [ID.exact]: { hasBeenPaid: true, requestAmount: '20', invoiceCurrency: 'USDC', payments: [pay('20')] },
  [ID.none]: { hasBeenPaid: false, requestAmount: '10', invoiceCurrency: 'USDC', payments: [] },
};

function fakeFetch(): FetchLike {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  return async (input) => {
    const url = new URL(input);
    if (url.pathname === '/v2/request') {
      const requests = Object.entries(DETAILS).map(([requestId, d], i) => {
        const detail = d as { hasBeenPaid: boolean; requestAmount: string; invoiceCurrency: string };
        return { requestId, amount: detail.requestAmount, invoiceCurrency: detail.invoiceCurrency, hasBeenPaid: detail.hasBeenPaid, createdAt: `2026-11-1${i}T00:00:00Z` };
      });
      return json(200, { requests, pagination: { total: requests.length, limit: 100, offset: 0 } });
    }
    const id = url.pathname.split('/')[3];
    return DETAILS[id] ? json(200, { requestId: id, ...(DETAILS[id] as object) }) : json(404, { message: 'Request not found' });
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect() {
  const config = loadConfig({ REQUEST_API_KEY: 'k', REQUEST_NOTES_FILE: 'off' });
  const notebook = memoryNotebook();
  notebook.save({ requestId: ID.short, for: 'Acme', createdAt: '2026-11-10T00:00:00Z' });
  const server = createServer(config, fakeFetch(), notebook, () => new Date('2026-11-20T12:00:00Z'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return res.content.map((c) => c.text).join('\n');
  };
}

describe('wrong amounts in the tools', () => {
  it('"did Acme pay?" says what is still owed', async () => {
    const call = await connect();
    const text = await call('check_invoice', { who: 'Acme' });
    expect(text).toContain('PART-PAID');
    expect(text).toContain('so 25 USDC is still owed');
  });

  it('check_invoice flags an overpayment', async () => {
    const call = await connect();
    const text = await call('check_invoice', { requestId: ID.over });
    expect(text).toContain('PAID (OVERPAID)');
    expect(text).toContain('5 USDC more than the 50 USDC asked');
  });

  it('list_invoices totals only what is still owed and marks each row', async () => {
    const call = await connect();
    const text = await call('list_invoices');
    expect(text).toContain("You're owed 35 USDC across 2 invoices."); // 25 left on the short one + 10 unpaid
    expect(text).toContain("1 invoice(s) were part-paid; only what's still owed on them is counted.");
    expect(text).toContain('1 invoice(s) were overpaid.');
    expect(text).toContain(`PART-PAID 100 USDC (75 received, 25 still owed) for Acme`);
    expect(text).toContain(`OVERPAID 50 USDC (5 USDC over)`);
  });

  it('filters to invoices paid a different amount', async () => {
    const call = await connect();
    const part = await call('list_invoices', { status: 'partly_paid' });
    expect(part).toMatch(/^1 invoice\(s\) \(partly paid\)\./);
    expect(part).toContain(ID.short);
    const over = await call('list_invoices', { status: 'overpaid' });
    expect(over).toMatch(/^1 invoice\(s\) \(overpaid\)\./);
    expect(over).toContain(ID.over);
    expect(over).not.toContain(ID.exact);
  });
});
