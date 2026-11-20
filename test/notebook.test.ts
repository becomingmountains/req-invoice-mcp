import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { defaultNotebookPath, fileNotebook, memoryNotebook, type Notebook } from '../src/notebook.js';
import { createServer } from '../src/server.js';

const WALLET = '0x6C13b270e84E69fCB4927352f4913f386Cee9775';
const ROUTE = `${WALLET}@eip155:8453#AAAA1111:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
const ID_1 = '11'.repeat(32);
const ID_2 = '22'.repeat(32);
const ID_3 = '33'.repeat(32);

const dirs: string[] = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'req-notes-'));
  dirs.push(dir);
  return join(dir, 'nested', 'invoices.json');
};
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('file notebook', () => {
  it('saves, merges and searches entries, in a private file', () => {
    const path = tempFile();
    const nb = fileNotebook(path);
    nb.save({ requestId: ID_1, for: 'Acme Corp', note: 'logo', createdAt: '2026-11-01T00:00:00Z' });
    nb.save({ requestId: ID_2, for: 'Bob', note: 'Acme subcontract', createdAt: '2026-11-02T00:00:00Z' });
    nb.save({ requestId: ID_1, link: 'https://pay.request.network/?token=x', createdAt: '2026-11-01T00:00:00Z' });
    expect(nb.get(ID_1)).toMatchObject({ for: 'Acme Corp', note: 'logo', link: 'https://pay.request.network/?token=x' });
    expect(nb.search('acme').map((e) => e.requestId)).toEqual([ID_2, ID_1]);
    expect(nb.search('nobody')).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A second process sees the same data.
    expect(fileNotebook(path).get(ID_2)?.for).toBe('Bob');
  });

  it('survives a missing or corrupt file', () => {
    const path = tempFile();
    expect(fileNotebook(path).get(ID_1)).toBeUndefined();
    const nb = fileNotebook(path);
    nb.save({ requestId: ID_1, for: 'A', createdAt: '2026-11-01T00:00:00Z' });
    writeFileSync(path, '{not json');
    expect(nb.search('A')).toEqual([]);
    nb.save({ requestId: ID_2, for: 'B', createdAt: '2026-11-01T00:00:00Z' });
    expect(JSON.parse(readFileSync(path, 'utf8')).invoices[ID_2].for).toBe('B');
  });

  it('lives under ~/.config by default and can be turned off', () => {
    expect(defaultNotebookPath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/req-invoice-mcp/invoices.json');
    expect(loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_NOTES_FILE: 'off' }).notebookPath).toBeUndefined();
    expect(loadConfig({ REQUEST_CLIENT_ID: 'c', REQUEST_NOTES_FILE: '/tmp/n.json' }).notebookPath).toBe('/tmp/n.json');
  });
});

// Fake API with three invoices; payment links get sequential IDs.
function fakeApi() {
  const paid = new Set([ID_1]);
  let next = [ID_1, ID_2, ID_3];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v2/currencies') return json(200, [{ id: 'USDC-base', symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }]);
    if (method === 'POST' && url.pathname === '/v2/secure-payments') {
      const id = next.shift()!;
      return json(201, { requestIds: [id], securePaymentUrl: `https://pay.request.network/?token=${id.slice(0, 4)}`, token: 't' });
    }
    if (method === 'POST' && url.pathname === '/v2/request') return json(201, { requestId: ID_3, paymentReference: '0x3' });
    if (method === 'GET' && url.pathname === '/v2/request') {
      const requests = [ID_3, ID_2, ID_1].map((id, i) => ({ requestId: id, amount: String(10 * (i + 1)), invoiceCurrency: 'USDC', hasBeenPaid: paid.has(id), createdAt: `2026-11-2${3 - i}T00:00:00Z` }));
      return json(200, { requests, pagination: { total: 3, limit: 20, offset: 0 } });
    }
    const m = /^\/v2\/request\/([0-9a-f]+)$/.exec(url.pathname);
    if (m) return json(200, { requestId: m[1], hasBeenPaid: paid.has(m[1]), requestAmount: '10', invoiceCurrency: 'USDC' });
    return json(404, { message: 'Not Found' });
  };
  return fetchImpl;
}

async function connect(notebook: Notebook = memoryNotebook()) {
  const config = loadConfig({ REQUEST_CLIENT_ID: 'cli_x', REQUEST_DESTINATION_ID: ROUTE, REQUEST_NOTES_FILE: 'off' });
  const server = createServer(config, fakeApi(), notebook);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  clients.push(client);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
  };
}

describe('who each invoice is for', () => {
  it('"bill Acme" then "has Acme paid?" and "resend Acme\'s link"', async () => {
    const call = await connect();
    const created = await call('create_payment_link', { amount: '10', for: 'Acme', note: 'logo' });
    expect(created.text).toContain('for Acme (logo)');

    const status = await call('check_invoice', { who: 'acme' });
    expect(status.isError).toBe(false);
    expect(status.text).toContain(`Invoice ${ID_1} for Acme (logo): PAID`);

    const link = await call('get_payment_link', { who: 'Acme' });
    expect(link.text).toContain('10 USDC for Acme (logo)');
    expect(link.text).toContain(`https://pay.request.network/?token=${ID_1.slice(0, 4)}`);
  });

  it('checks every invoice for the same person', async () => {
    const call = await connect();
    await call('create_payment_link', { amount: '10', for: 'Acme' });
    await call('create_payment_link', { amount: '20', for: 'Acme' });
    const res = await call('check_invoice', { who: 'Acme' });
    expect(res.text).toContain(`${ID_1} for Acme: PAID`);
    expect(res.text).toContain(`${ID_2} for Acme: NOT PAID YET`);
  });

  it('shows names in the list and filters by name', async () => {
    const call = await connect();
    await call('create_payment_link', { amount: '10', for: 'Acme' });
    await call('create_payment_link', { amount: '20', for: 'Bob', note: 'website' });
    const all = await call('list_invoices');
    expect(all.text).toMatch(/UNPAID 20 USDC for Bob "website"/);
    expect(all.text).toMatch(/PAID\s+30 USDC for Acme/);
    const bob = await call('list_invoices', { who: 'bob' });
    expect(bob.text).toContain('1 invoice(s) for "bob"');
    expect(bob.text).not.toContain('for Acme');
  });

  it('remembers create_invoice names, which have no hosted link', async () => {
    const call = await connect();
    await call('create_invoice', { amount: '5', paymentCurrency: 'USDC-base', for: 'Carol', reference: 'INV-9' });
    expect((await call('check_invoice', { who: 'carol' })).text).toContain(`${ID_3} for Carol (INV-9)`);
    const link = await call('get_payment_link', { who: 'Carol' });
    expect(link.isError).toBe(true);
    expect(link.text).toContain('no hosted link');
  });

  it('explains unknown names and missing input without calling the API', async () => {
    const call = await connect();
    expect((await call('check_invoice', { who: 'Zed' })).text).toContain('No saved invoices for "Zed"');
    expect((await call('check_invoice', {})).isError).toBe(true);
    expect((await call('get_payment_link', {})).isError).toBe(true);
  });

  it('still creates the invoice if the notebook cannot be written', async () => {
    const broken: Notebook = { get: () => undefined, search: () => [], save: () => { throw new Error('disk full'); } };
    const call = await connect(broken);
    const res = await call('create_payment_link', { amount: '10', for: 'Acme' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('pay.request.network');
  });
});

describe('test safety', () => {
  it('never points the default notebook at the real home folder', () => {
    expect(defaultNotebookPath({})).toContain('req-invoice-test-home-');
    expect(loadConfig({ REQUEST_CLIENT_ID: 'c' }).notebookPath).toContain('req-invoice-test-home-');
  });
});
