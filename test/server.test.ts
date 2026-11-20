import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestApi, type FetchLike } from '../src/api.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const PAYEE = '0x6923831ACf5c327260D7ac7C9DfF5b1c3cB3C7D7';
const PAYER = '0xb07d2398d2004378cad234da0ef14f1c94a530e4';
const REQ_ID = '01e273ecc29d4b526df3a0f1f05ffc59372af8752c2b678096e49ac270416a7cdb';
const DEST = `${PAYEE}@eip155:11155111#A1B2C3D4:0x370DE27fdb7D1Ff1e1BaA7D11c5820a324Cf623C`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake Request API: route table of "METHOD /path" -> [status, body]. Records every call. */
function fakeFetch(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url: input,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const hit = routes[`${method} ${url.pathname}`];
    if (!hit) return new Response(JSON.stringify({ statusCode: 404, message: 'Not Found' }), { status: 404 });
    const [status, body] = hit;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(routes: Record<string, [number, unknown]>, overrides: Partial<ServerConfig> = {}) {
  const config: ServerConfig = {
    api: { baseUrl: 'https://api.test', apiKey: 'secret-key' },
    defaultPayee: PAYEE,
    destinationId: DEST,
    ...overrides,
  };
  const fake = fakeFetch(routes);
  const server = createServer(config, new RequestApi(config.api, fake.fetchImpl));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
  return { client, call, calls: fake.calls };
}

describe('tool list', () => {
  it('exposes exactly the six tools, and none of them can spend money', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_invoice',
      'create_invoice',
      'create_payment_link',
      'find_currency',
      'get_payment_transactions',
      'list_invoices',
    ]);
    for (const t of tools) expect(t.annotations?.destructiveHint ?? false).toBe(false);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(['check_invoice', 'find_currency', 'get_payment_transactions', 'list_invoices']);
  });
});

describe('create_payment_link', () => {
  it('creates a hosted payment link from the configured route', async () => {
    const { call, calls } = await connect({
      'POST /v2/secure-payments': [
        201,
        { requestIds: [REQ_ID], securePaymentUrl: 'https://pay.request.network/?token=v1.abc', token: '01ABC' },
      ],
    });
    const res = await call('create_payment_link', { amount: '250' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('https://pay.request.network/?token=v1.abc');
    expect(res.text).toContain(REQ_ID);
    expect(calls[0].body).toEqual({ requests: [{ destinationId: DEST, amount: '250' }] });
    expect(calls[0].headers['x-api-key']).toBe('secret-key');
  });

  it('explains what to do when no route is configured, without calling the API', async () => {
    const { call, calls } = await connect({}, { destinationId: undefined });
    const res = await call('create_payment_link', { amount: '10' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('REQUEST_DESTINATION_ID');
    expect(calls).toHaveLength(0);
  });

  it.each(['0', '0.00', '-5', 'abc', '1e6', '10,00', ''])('rejects amount %j before calling the API', async (amount) => {
    const { call, calls } = await connect({});
    const res = await call('create_payment_link', { amount });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('create_invoice', () => {
  it('sends the invoice with the default payee and invoice currency', async () => {
    const { call, calls } = await connect({
      'POST /v2/request': [201, { requestId: REQ_ID, paymentReference: '0xabc' }],
    });
    const res = await call('create_invoice', { amount: '19.99', paymentCurrency: 'USDC-base', reference: 'INV-042' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain(REQ_ID);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.test/v2/request');
    expect(calls[0].body).toEqual({
      amount: '19.99',
      invoiceCurrency: 'USDC-base',
      paymentCurrency: 'USDC-base',
      payee: PAYEE,
      reference: 'INV-042',
    });
  });

  it('bills in USD and lets the caller name payee and payer', async () => {
    const { call, calls } = await connect({ 'POST /v2/request': [201, { requestId: REQ_ID, paymentReference: '0x1' }] });
    await call('create_invoice', {
      amount: '500',
      invoiceCurrency: 'USD',
      paymentCurrency: 'USDC-mainnet',
      payee: PAYER,
      payer: PAYEE,
    });
    expect(calls[0].body).toMatchObject({ invoiceCurrency: 'USD', payee: PAYER, payer: PAYEE });
  });

  it('refuses without any payee when using an API key', async () => {
    const { call, calls } = await connect({}, { defaultPayee: undefined });
    const res = await call('create_invoice', { amount: '1', paymentCurrency: 'USDC-base' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('REQUEST_PAYEE');
    expect(calls).toHaveLength(0);
  });

  it('lets a client ID fall back to its dashboard route as payee', async () => {
    const { call, calls } = await connect(
      { 'POST /v2/request': [201, { requestId: REQ_ID, paymentReference: '0x1' }] },
      { defaultPayee: undefined, api: { baseUrl: 'https://api.test', clientId: 'cid', origin: 'https://example.com' } },
    );
    const res = await call('create_invoice', { amount: '1', paymentCurrency: 'USDC-base' });
    expect(res.isError).toBe(false);
    expect(calls[0].body).not.toHaveProperty('payee');
    expect(calls[0].headers['x-client-id']).toBe('cid');
    expect(calls[0].headers.origin).toBe('https://example.com');
    expect(calls[0].headers).not.toHaveProperty('x-api-key');
  });

  it.each([
    ['bad payee', { payee: '0x123' }],
    ['injection in currency', { paymentCurrency: 'USDC/../../admin' }],
    ['huge reference', { reference: 'x'.repeat(201) }],
  ])('rejects %s', async (_, extra) => {
    const { call, calls } = await connect({});
    const res = await call('create_invoice', { amount: '1', paymentCurrency: 'USDC-base', ...extra });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces API validation errors without leaking the key', async () => {
    const { call } = await connect({
      'POST /v2/request': [400, { statusCode: 400, message: ['paymentCurrency must be a valid currency'] }],
    });
    const res = await call('create_invoice', { amount: '1', paymentCurrency: 'NOPE-base' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('400');
    expect(res.text).toContain('paymentCurrency must be a valid currency');
    expect(res.text).not.toContain('secret-key');
  });
});

describe('check_invoice', () => {
  it('reports a paid invoice with its payment', async () => {
    const { call, calls } = await connect({
      [`GET /v2/request/${REQ_ID}`]: [
        200,
        {
          requestId: REQ_ID,
          hasBeenPaid: true,
          status: 'paid',
          requestAmount: '500',
          invoiceCurrency: 'USDC',
          paymentCurrency: 'USDC',
          payee: PAYEE,
          payments: [{ amount: '500', payerAddress: PAYER, sourceTxHash: '0xfeed', timestamp: '2026-11-20T10:00:00Z' }],
        },
      ],
    });
    const res = await call('check_invoice', { requestId: `0x${REQ_ID}` });
    expect(calls[0].url).toBe(`https://api.test/v2/request/${REQ_ID}`);
    expect(res.text).toContain('PAID');
    expect(res.text).toContain('0xfeed');
    expect(res.text).toContain(PAYER);
  });

  it('reports an unpaid invoice', async () => {
    const { call } = await connect({
      [`GET /v2/request/${REQ_ID}`]: [200, { requestId: REQ_ID, hasBeenPaid: false, requestAmount: '10', invoiceCurrency: 'USD' }],
    });
    const res = await call('check_invoice', { requestId: REQ_ID });
    expect(res.text).toContain('NOT PAID YET');
  });

  it('gives a clear message for an unknown invoice', async () => {
    const { call } = await connect({});
    const res = await call('check_invoice', { requestId: REQ_ID });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no invoice with that ID');
  });

  it('rejects IDs that could change the URL path', async () => {
    const { call, calls } = await connect({});
    for (const bad of ['../client-ids', `${REQ_ID}/pay`, `${REQ_ID}?x=1`]) {
      expect((await call('check_invoice', { requestId: bad })).isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('list_invoices', () => {
  it('lists invoices with paid status and paging', async () => {
    const { call, calls } = await connect({
      'GET /v2/request': [
        200,
        {
          requests: [
            { requestId: 'aa', amount: '10', invoiceCurrency: 'USD', hasBeenPaid: true, reference: 'INV-1', createdAt: '2026-11-19T00:00:00Z' },
            { requestId: 'bb', amount: '20', invoiceCurrency: 'USD', hasBeenPaid: false },
          ],
          pagination: { total: 5, limit: 2, offset: 0 },
        },
      ],
    });
    const res = await call('list_invoices', { limit: 2, walletAddress: PAYEE });
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('2');
    expect(new URL(calls[0].url).searchParams.get('walletAddress')).toBe(PAYEE);
    expect(res.text).toContain('5 invoice(s), showing 1-2');
    expect(res.text).toMatch(/PAID\s+10 USD "INV-1" \(2026-11-19\) id aa/);
    expect(res.text).toMatch(/UNPAID 20 USD id bb/);
  });
});

describe('get_payment_transactions', () => {
  it('returns unsigned transactions and flags approval and balance', async () => {
    const { call, calls } = await connect({
      [`GET /v2/request/${REQ_ID}/pay`]: [
        200,
        {
          transactions: [
            { to: '0xtoken', data: '0x095ea7b3', value: { type: 'BigNumber', hex: '0x00' } },
            { to: '0xproxy', data: '0xc219a14d', value: { type: 'BigNumber', hex: '0x00' } },
          ],
          metadata: { stepsRequired: 2, needsApproval: true, approvalTransactionIndex: 0, hasEnoughBalance: false, hasEnoughGas: true },
        },
      ],
    });
    const res = await call('get_payment_transactions', { requestId: REQ_ID, payerWallet: PAYER });
    expect(new URL(calls[0].url).searchParams.get('wallet')).toBe(PAYER);
    expect(res.text).toContain('2 transaction(s) to sign');
    expect(res.text).toContain('Transaction 1 is a token approval');
    expect(res.text).toContain('not have enough balance');
    expect(res.text).toContain('This server cannot send them');
  });
});

describe('unlimited approval warning', () => {
  const spender = '399f5ee127ce7432e4921a61b8cf52b0af52cbfe';
  const approve = (amountHex: string) => `0x095ea7b3${spender.padStart(64, '0')}${amountHex.padStart(64, '0')}`;

  it('warns on a max-uint approval, as returned by the live API', async () => {
    const { call } = await connect({
      [`GET /v2/request/${REQ_ID}/pay`]: [
        200,
        {
          transactions: [
            { to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', data: approve('f'.repeat(64)), value: 0 },
            { to: '0x399F5EE127ce7432E4921a61b8CF52b0af52cbfE', data: '0xc219a14d', value: 0 },
          ],
          metadata: { stepsRequired: 2, needsApproval: true, approvalTransactionIndex: 0, hasEnoughBalance: true, hasEnoughGas: true },
        },
      ],
    });
    const res = await call('get_payment_transactions', { requestId: REQ_ID });
    expect(res.text).toContain(`transaction 1 approves an UNLIMITED amount to 0x${spender}`);
  });

  it('stays quiet for an exact approval or other calls', async () => {
    const { unlimitedApprovalWarning } = await import('../src/server.js');
    expect(unlimitedApprovalWarning(approve('7a120'), 0)).toBe('');
    expect(unlimitedApprovalWarning('0xc219a14d00', 1)).toBe('');
    expect(unlimitedApprovalWarning('', 0)).toBe('');
  });
});

describe('find_currency', () => {
  it('looks up currency IDs', async () => {
    const { call, calls } = await connect({
      'GET /v2/currencies': [200, [{ id: 'USDC-sepolia', symbol: 'USDC', network: 'sepolia', address: '0x1c7D' }]],
    });
    const res = await call('find_currency', { symbol: 'USDC', network: 'sepolia' });
    expect(calls[0].url).toBe('https://api.test/v2/currencies?symbol=USDC&network=sepolia');
    expect(res.text).toContain('USDC-sepolia (sepolia)');
  });

  it('needs at least one filter', async () => {
    const { call, calls } = await connect({});
    expect((await call('find_currency', {})).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('API failures', () => {
  it('handles a non-JSON error page', async () => {
    const { call } = await connect({ 'POST /v2/request': [502, '<html>Bad Gateway</html>'] });
    const res = await call('create_invoice', { amount: '1', paymentCurrency: 'USDC-base' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('502');
    expect(res.text).not.toContain('<html>');
  });

  it('handles the network being down', async () => {
    const config: ServerConfig = { api: { baseUrl: 'https://api.test', apiKey: 'k' }, defaultPayee: PAYEE };
    const server = createServer(
      config,
      new RequestApi(config.api, async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    clients.push(client);
    const res = (await client.callTool({ name: 'check_invoice', arguments: { requestId: REQ_ID } })) as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('could not be reached');
  });

  it('flags auth problems', async () => {
    const { call } = await connect({ [`GET /v2/request/${REQ_ID}`]: [401, { message: 'API key, Client ID, or session token is required' }] });
    const res = await call('check_invoice', { requestId: REQ_ID });
    expect(res.text).toContain('check REQUEST_API_KEY / REQUEST_CLIENT_ID');
  });
});

describe('loadConfig', () => {
  it('requires credentials', () => {
    expect(() => loadConfig({})).toThrow(/REQUEST_API_KEY or REQUEST_CLIENT_ID/);
  });

  it('reads all settings', () => {
    const c = loadConfig({
      REQUEST_CLIENT_ID: ' cid ',
      REQUEST_ORIGIN: 'https://example.com',
      REQUEST_PAYEE: PAYEE,
      REQUEST_DESTINATION_ID: DEST,
    });
    expect(c.api).toMatchObject({ clientId: 'cid', origin: 'https://example.com', baseUrl: 'https://api.request.network' });
    expect(c.defaultPayee).toBe(PAYEE);
    expect(c.destinationId).toBe(DEST);
  });

  it('accepts a real Route ID and explains a Route ID cut off by "#" in a .env file', () => {
    const real = '0x6C13b270e84E69fCB4927352f4913f386Cee9775@eip155:11155111#1436212C:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
    expect(loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_DESTINATION_ID: real }).destinationId).toBe(real);
    expect(() => loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_DESTINATION_ID: real.split('#')[0] })).toThrow(/double quotes/);
    expect(() => loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_DESTINATION_ID: 'nonsense#1:2' })).toThrow(/Route ID/);
  });

  it('rejects a bad payee and a non-https API URL', () => {
    expect(() => loadConfig({ REQUEST_API_KEY: 'k', REQUEST_PAYEE: 'me' })).toThrow(/REQUEST_PAYEE/);
    expect(() => loadConfig({ REQUEST_API_KEY: 'k', REQUEST_API_URL: 'http://evil.example' })).toThrow(/https/);
  });
});
