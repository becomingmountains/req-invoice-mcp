import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { canonicalSymbol, chooseRoute, normalizeNetwork, parseRouteId, type Route } from '../src/routes.js';
import { createServer } from '../src/server.js';

const WALLET = '0x6C13b270e84E69fCB4927352f4913f386Cee9775';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_ARB = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const FUSDC_SEP = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

const BASE_ROUTE = `${WALLET}@eip155:8453#AAAA1111:${USDC_BASE}`;
const ARB_ROUTE = `${WALLET}@eip155:42161#BBBB2222:${USDT_ARB}`;
const ARB_USDC_ROUTE = `${WALLET}@eip155:42161#CCCC3333:${USDC_ARB}`;
const SEP_ROUTE = `${WALLET}@eip155:11155111#1436212C:${FUSDC_SEP.toLowerCase()}`;

const ID_A = 'aa'.repeat(32);
const ID_B = 'bb'.repeat(32);

describe('parseRouteId', () => {
  it('reads wallet, network and token from a real Route ID', () => {
    expect(parseRouteId(SEP_ROUTE)).toEqual({
      id: SEP_ROUTE,
      payee: WALLET,
      chain: 'eip155:11155111',
      network: 'sepolia',
      token: FUSDC_SEP.toLowerCase(),
    });
    expect(parseRouteId(BASE_ROUTE)?.network).toBe('base');
    expect(parseRouteId(`${WALLET}@eip155:999999#AB:${USDC_BASE}`)?.network).toBeUndefined();
  });

  it('rejects malformed IDs', () => {
    for (const bad of ['', WALLET, `${WALLET}@eip155:1`, `${WALLET}@eip155:1#XYZ:${USDC_BASE}`, `0x12@eip155:1#AB:${USDC_BASE}`]) {
      expect(parseRouteId(bad)).toBeUndefined();
    }
  });
});

describe('matching what people say', () => {
  it('normalizes network names', () => {
    expect(normalizeNetwork('Arbitrum')).toBe('arbitrum-one');
    expect(normalizeNetwork('ethereum')).toBe('mainnet');
    expect(normalizeNetwork('Polygon')).toBe('matic');
    expect(normalizeNetwork('base')).toBe('base');
    expect(normalizeNetwork('narnia')).toBeUndefined();
  });

  it('treats test and native USDC variants as USDC', () => {
    expect(canonicalSymbol('fUSDC')).toBe('USDC');
    expect(canonicalSymbol('USDCn')).toBe('USDC');
    expect(canonicalSymbol('usdt')).toBe('USDT');
    expect(canonicalSymbol('DAI')).toBe('DAI');
  });

  const routes = [BASE_ROUTE, ARB_ROUTE, ARB_USDC_ROUTE].map((id) => parseRouteId(id)!) as Route[];
  const symbols: Record<string, string> = { [BASE_ROUTE]: 'USDC', [ARB_ROUTE]: 'USDT', [ARB_USDC_ROUTE]: 'USDC' };
  const pick = (hints: { currency?: string; network?: string }) => chooseRoute(routes, hints, (r) => symbols[r.id]);

  it('uses the first route by default', () => {
    expect(pick({}).route?.id).toBe(BASE_ROUTE);
  });

  it('picks by currency, network or both', () => {
    expect(pick({ currency: 'USDT' }).route?.id).toBe(ARB_ROUTE);
    expect(pick({ currency: 'usdc', network: 'arbitrum' }).route?.id).toBe(ARB_USDC_ROUTE);
    expect(pick({ network: 'Base' }).route?.id).toBe(BASE_ROUTE);
  });

  it('asks instead of guessing when it is ambiguous or missing', () => {
    expect(pick({ currency: 'USDC' }).problem).toMatch(/more than one/i);
    expect(pick({ network: 'arbitrum' }).problem).toMatch(/more than one/i);
    expect(pick({ currency: 'DAI' }).problem).toMatch(/No route takes DAI/);
    expect(pick({ network: 'polygon' }).problem).toMatch(/No route on Polygon/);
    expect(pick({ network: 'narnia' }).problem).toMatch(/Unknown network/);
  });
});

describe('REQUEST_ROUTES config', () => {
  it('reads several routes, each with its own Client ID, and keeps v0.1 settings working', () => {
    const c = loadConfig({
      REQUEST_ROUTES: `${BASE_ROUTE}=cli_base,\n ${ARB_ROUTE}=cli_arb ; ${SEP_ROUTE}`,
      REQUEST_DESTINATION_ID: SEP_ROUTE,
      REQUEST_CLIENT_ID: 'cli_default',
    });
    expect(c.routes.map((r) => [r.network, r.clientId])).toEqual([
      ['base', 'cli_base'],
      ['arbitrum-one', 'cli_arb'],
      ['sepolia', undefined],
    ]);
    expect(c.api.clientId).toBe('cli_default');
  });

  it('works with only per-route Client IDs', () => {
    const c = loadConfig({ REQUEST_ROUTES: `${BASE_ROUTE}=cli_base,${ARB_ROUTE}=cli_arb` });
    expect(c.api.clientId).toBe('cli_base');
  });

  it('needs credentials for every route', () => {
    expect(() => loadConfig({ REQUEST_ROUTES: `${BASE_ROUTE}=cli_base,${ARB_ROUTE}` })).toThrow(/credentials/);
  });

  it('explains bad entries', () => {
    expect(() => loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_ROUTES: `${BASE_ROUTE}=bad id!` })).toThrow(/REQUEST_ROUTES/);
    expect(() => loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_ROUTES: BASE_ROUTE.split('#')[0] })).toThrow(/double quotes/);
  });
});

// Fake API that answers per Client ID, like the real one (invoices are scoped to the Client ID that made them).
function fakeApi() {
  const calls: { method: string; path: string; clientId: string; body: unknown }[] = [];
  const currencies: Record<string, { id: string; symbol: string; address: string }[]> = {
    base: [{ id: 'USDC-base', symbol: 'USDC', address: USDC_BASE }],
    'arbitrum-one': [
      { id: 'USDT-arbitrum-one', symbol: 'USDT', address: USDT_ARB },
      { id: 'USDC-arbitrum-one', symbol: 'USDC', address: USDC_ARB },
    ],
  };
  const invoices: Record<string, { requestId: string; amount: string; createdAt: string; hasBeenPaid: boolean }[]> = {
    cli_base: [{ requestId: ID_A, amount: '10', createdAt: '2026-11-20T10:00:00Z', hasBeenPaid: true }],
    cli_arb: [{ requestId: ID_B, amount: '20', createdAt: '2026-11-21T10:00:00Z', hasBeenPaid: false }],
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const clientId = (init?.headers as Record<string, string>)['x-client-id'];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, clientId, body });
    if (url.pathname === '/v2/currencies') return json(200, currencies[url.searchParams.get('network') ?? ''] ?? []);
    if (method === 'POST' && url.pathname === '/v2/secure-payments') {
      return json(201, { requestIds: ['cc'.repeat(32)], securePaymentUrl: `https://pay.request.network/?token=${clientId}`, token: 't' });
    }
    if (method === 'POST' && url.pathname === '/v2/request') return json(201, { requestId: 'dd'.repeat(32), paymentReference: '0x1' });
    if (method === 'GET' && url.pathname === '/v2/request') {
      const list = invoices[clientId] ?? [];
      return json(200, { requests: list, pagination: { total: list.length, limit: 20, offset: 0 } });
    }
    const m = /^\/v2\/request\/([0-9a-f]+)$/.exec(url.pathname);
    if (m) {
      const hit = (invoices[clientId] ?? []).find((i) => i.requestId === m[1]);
      return hit ? json(200, { ...hit, requestAmount: hit.amount, invoiceCurrency: 'USDC' }) : json(404, { message: 'Request not found' });
    }
    return json(404, { message: 'Not Found' });
  };
  return { fetchImpl, calls };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connectMulti() {
  const config = loadConfig({
    REQUEST_ROUTES: `${BASE_ROUTE}=cli_base, ${ARB_ROUTE}=cli_arb, ${ARB_USDC_ROUTE}=cli_arb`,
    REQUEST_NOTES_FILE: 'off',
  });
  const fake = fakeApi();
  const server = createServer(config, fake.fetchImpl);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { call, calls: fake.calls };
}

describe('multi-route server', () => {
  it('lists routes with their token and network', async () => {
    const { call } = await connectMulti();
    const res = await call('list_routes');
    expect(res.text).toContain('1. USDC on Base');
    expect(res.text).toContain('(default)');
    expect(res.text).toContain('2. USDT on Arbitrum');
    expect(res.text).toContain('3. USDC on Arbitrum');
    expect(res.text).not.toContain('cli_');
  });

  it('creates the link on the route that matches, with that route’s Client ID', async () => {
    const { call, calls } = await connectMulti();
    const res = await call('create_payment_link', { amount: '50', currency: 'USDT' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('50 USDT on Arbitrum');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.clientId).toBe('cli_arb');
    expect(post.body).toEqual({ requests: [{ destinationId: ARB_ROUTE, amount: '50' }] });
  });

  it('uses the default route when nothing is specified', async () => {
    const { call, calls } = await connectMulti();
    await call('create_payment_link', { amount: '5' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.clientId).toBe('cli_base');
    expect(post.body).toEqual({ requests: [{ destinationId: BASE_ROUTE, amount: '5' }] });
  });

  it('asks which network instead of guessing, and creates nothing', async () => {
    const { call, calls } = await connectMulti();
    const res = await call('create_payment_link', { amount: '5', currency: 'USDC' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/More than one route matches/);
    expect(res.text).toContain('USDC on Base');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('lists invoices from every Client ID, newest first', async () => {
    const { call } = await connectMulti();
    const res = await call('list_invoices');
    expect(res.text).toContain('2 invoice(s)');
    expect(res.text.indexOf(ID_B)).toBeLessThan(res.text.indexOf(ID_A));
  });

  it('finds an invoice whichever Client ID created it', async () => {
    const { call } = await connectMulti();
    const res = await call('check_invoice', { requestId: ID_B });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('NOT PAID YET');
    expect((await call('check_invoice', { requestId: 'ee'.repeat(32) })).text).toContain('no invoice with that ID');
  });

  it('creates invoices with the Client ID and wallet of the matching network', async () => {
    const { call, calls } = await connectMulti();
    const res = await call('create_invoice', { amount: '3', paymentCurrency: 'USDT-arbitrum-one' });
    expect(res.isError).toBe(false);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.clientId).toBe('cli_arb');
    expect(post.body).toMatchObject({ payee: WALLET, paymentCurrency: 'USDT-arbitrum-one' });
  });
});
