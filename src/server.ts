import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  RequestApi,
  RequestApiError,
  type FetchLike,
  type RequestListItem,
  type RequestPayment,
  type RequestStatus,
} from './api.js';
import type { ServerConfig } from './config.js';
import { chooseRoute, networkLabel, type Route } from './routes.js';

export const VERSION = '0.2.0';

const address = z
  .string()
  .trim()
  .refine((v) => /^0x[0-9a-fA-F]{40}$/.test(v) || /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v), {
    message: 'Must be a 0x… EVM address or a T… Tron address',
  });

const amount = z
  .string()
  .trim()
  .regex(/^\d{1,30}(\.\d{1,36})?$/, 'Use a plain decimal like "250" or "19.99"')
  .refine((v) => /[1-9]/.test(v), { message: 'Amount must be greater than zero' });

const requestId = z
  .string()
  .trim()
  .regex(/^(0x)?[0-9a-fA-F]{16,80}$/, 'Request IDs are long hex strings, e.g. 01e273ec…')
  .transform((v) => v.replace(/^0x/, ''));

const currencyId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{2,64}$/, 'Currency IDs look like "USDC-base", "USDC-mainnet", "fUSDC-sepolia" or "USD"');

const reference = z.string().trim().max(200);

export function createServer(config: ServerConfig, fetchImpl?: FetchLike): McpServer {
  const api = new RequestApi(config.api, fetchImpl);
  const routeApis = new Map<string, RequestApi>();
  /** API client for a route: its own Client ID when it has one, otherwise the default credentials. */
  const apiFor = (route?: Route): RequestApi => {
    if (!route?.clientId || route.clientId === config.api.clientId) return api;
    let client = routeApis.get(route.clientId);
    if (!client) {
      client = new RequestApi({ ...config.api, apiKey: undefined, clientId: route.clientId }, fetchImpl);
      routeApis.set(route.clientId, client);
    }
    return client;
  };
  /** Every distinct set of credentials, so invoices created under any route can be found. */
  const allApis = (): RequestApi[] => [api, ...config.routes.map(apiFor)].filter((a, i, list) => list.indexOf(a) === i);

  // Token symbols per route, looked up once from the currency list for the route's network.
  const symbols = new Map<string, string | undefined>();
  const symbolFor = async (route: Route): Promise<string | undefined> => {
    if (symbols.has(route.id)) return symbols.get(route.id);
    let symbol: string | undefined;
    if (route.network) {
      try {
        const list = await apiFor(route).findCurrencies({ network: route.network });
        symbol = list.find((c) => c.address?.toLowerCase() === route.token.toLowerCase())?.symbol;
      } catch {
        // Unknown symbol is fine: the route still works, it's just described by its token address.
      }
    }
    symbols.set(route.id, symbol);
    return symbol;
  };
  const describeRoute = (route: Route, symbol: string | undefined) =>
    `${symbol ?? `token ${route.token}`} on ${networkLabel(route.network, route.chain)} to ${route.payee}`;

  /** Tries each credential set until one knows the invoice (invoices are scoped to the Client ID that created them). */
  async function findAcrossApis<T>(fn: (a: RequestApi) => Promise<T>): Promise<T> {
    let notFound: unknown;
    for (const a of allApis()) {
      try {
        return await fn(a);
      } catch (e) {
        if (e instanceof RequestApiError && e.status === 404) {
          notFound = e;
          continue;
        }
        throw e;
      }
    }
    throw notFound;
  }

  const server = new McpServer(
    { name: 'req-invoice-mcp', version: VERSION },
    {
      instructions:
        "This server manages the user's crypto invoices on Request Network: billing people, payment links, and " +
        'tracking who has paid. Whenever the user asks about money owed to them, unpaid or outstanding invoices, ' +
        'receivables or whether someone has paid, check list_invoices here in addition to any other billing tools. ' +
        'Payment links can be in any of the configured routes (list_routes shows which currencies and networks). ' +
        'It cannot send or sign payments.',
    },
  );

  server.registerTool(
    'create_payment_link',
    {
      title: 'Create a payment link',
      description:
        'Use when the user wants to bill, charge, invoice or request money from someone, or asks for a payment link. ' +
        'Returns a link the payer opens to pay in their own wallet. Each receiving route set up in the Request Network ' +
        'dashboard is one network and token; pass currency and/or network to pick one (see list_routes), or omit both ' +
        "to use the default route. The amount is in the chosen route's token. This is the easiest way to get paid.",
      inputSchema: {
        amount,
        currency: z.string().trim().max(20).optional().describe('Token to be paid in, e.g. "USDC" or "USDT".'),
        network: z.string().trim().max(40).optional().describe('Network, e.g. "base", "arbitrum", "ethereum", "sepolia".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, currency, network }) =>
      run(async () => {
        if (!config.routes.length) {
          return fail(
            'No receiving route configured. Copy a Route ID from https://dashboard.request.network into ' +
              'REQUEST_ROUTES (or REQUEST_DESTINATION_ID), or use create_invoice instead.',
          );
        }
        if (currency) await Promise.all(config.routes.map(symbolFor));
        const choice = chooseRoute(config.routes, { currency, network }, (r) => symbols.get(r.id));
        if (!choice.route) {
          const available = await Promise.all(config.routes.map(async (r) => `- ${describeRoute(r, await symbolFor(r))}`));
          return fail(`${choice.problem} Available routes:\n${available.join('\n')}`);
        }
        const route = choice.route;
        const link = await apiFor(route).createPaymentLink(route.id, amount);
        const symbol = await symbolFor(route);
        return ok(
          `Payment link created for ${amount} ${symbol ?? ''} on ${networkLabel(route.network, route.chain)}. ` +
            `Send this to the payer:\n${link.securePaymentUrl}\n` +
            `Invoice ID: ${link.requestIds.join(', ')} (use check_invoice to see when it's paid).`,
          { ...link, route: { id: route.id, network: route.network, token: route.token, symbol } },
        );
      }),
  );

  server.registerTool(
    'list_routes',
    {
      title: 'List receiving routes',
      description:
        'Use when the user asks what currencies or networks they can be paid in, or before create_payment_link when ' +
        'it is unclear which route to use. Lists the configured receiving routes (network, token, wallet); the first ' +
        'is the default.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        if (!config.routes.length) return ok('No receiving routes configured. Payment links are off; create_invoice still works.', []);
        const rows = await Promise.all(
          config.routes.map(async (r, i) => {
            const symbol = await symbolFor(r);
            return { text: `${i + 1}. ${describeRoute(r, symbol)}${i === 0 ? ' (default)' : ''}`, data: { ...r, clientId: undefined, symbol } };
          }),
        );
        return ok(`${rows.length} route(s):\n${rows.map((r) => r.text).join('\n')}`, rows.map((r) => r.data));
      }),
  );

  server.registerTool(
    'create_invoice',
    {
      title: 'Create an invoice',
      description:
        'Use when the user wants to invoice someone in a specific token or network, bill in USD, or add an invoice ' +
        'number or note. Creates an on-chain invoice (a "request") for a specific amount, currency and network. ' +
        'paymentCurrency picks the token and network, e.g. "USDC-base", "USDC-mainnet", "USDC-arbitrum-one", "fUSDC-sepolia" (test USDC) ' +
        '(use find_currency to look IDs up). invoiceCurrency is what the amount is denominated in; it defaults to ' +
        'paymentCurrency, or use "USD" to bill a dollar amount paid in crypto. Returns the invoice ID.',
      inputSchema: {
        amount,
        paymentCurrency: currencyId,
        invoiceCurrency: currencyId.optional(),
        payee: address.optional().describe('Wallet that gets paid. Defaults to REQUEST_PAYEE.'),
        payer: address.optional().describe('Wallet expected to pay (optional).'),
        reference: reference.optional().describe('Your own note or invoice number, e.g. "INV-042 website".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        // Prefer the route on the same network, so its Client ID and wallet are used.
        const pc = args.paymentCurrency.toLowerCase();
        const route = config.routes.find((r) => r.network && pc.endsWith(`-${r.network}`));
        const payee = args.payee ?? config.defaultPayee ?? route?.payee;
        if (!payee && !config.api.clientId) {
          return fail('No payee: pass payee, or set REQUEST_PAYEE to the wallet that should receive payments.');
        }
        const created = await apiFor(route).createRequest({
          amount: args.amount,
          invoiceCurrency: args.invoiceCurrency ?? args.paymentCurrency,
          paymentCurrency: args.paymentCurrency,
          payee,
          payer: args.payer,
          reference: args.reference,
        });
        return ok(
          `Invoice created: ${args.amount} ${args.invoiceCurrency ?? args.paymentCurrency}, paid in ${args.paymentCurrency}` +
            `${payee ? ` to ${payee}` : ''}.\nInvoice ID: ${created.requestId}\n` +
            'The payer can get the transactions to sign with get_payment_transactions. Use check_invoice to see when it is paid.',
          created,
        );
      }),
  );

  server.registerTool(
    'check_invoice',
    {
      title: 'Check an invoice',
      description:
        'Use when the user asks whether a specific invoice or person has paid ("has Acme paid?", "did that invoice ' +
        'go through?"). Returns paid/unpaid with the payment transaction(s). Needs the invoice ID; if the user names a ' +
        'person or reference instead, call list_invoices first to find it.',
      inputSchema: { requestId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ requestId }) =>
      run(async () => {
        const status = await findAcrossApis((a) => a.getRequest(requestId));
        return ok(describeStatus(status), status);
      }),
  );

  server.registerTool(
    'list_invoices',
    {
      title: 'List invoices',
      description:
        'Use when the user asks who owes them money, what is unpaid or outstanding, what they have billed, or for ' +
        'their crypto invoices or receivables. Lists Request Network invoices created with these credentials, newest ' +
        'first, marked PAID or UNPAID. Check this alongside any other billing tools (e.g. Stripe) the user has.',
      inputSchema: {
        walletAddress: address.optional().describe('Only invoices paid to this wallet.'),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;
        const apis = allApis();
        const list =
          apis.length === 1
            ? await api.listRequests({ walletAddress: args.walletAddress, limit, offset: args.offset })
            : await mergeLists(apis, args.walletAddress, limit, offset);
        const lines = list.requests.map(
          (r) =>
            `- ${r.hasBeenPaid ? 'PAID  ' : 'UNPAID'} ${r.amount ?? '?'} ${r.invoiceCurrency ?? ''}` +
            `${r.reference ? ` "${r.reference}"` : ''}${r.createdAt ? ` (${r.createdAt.slice(0, 10)})` : ''} id ${r.requestId}`,
        );
        const { total } = list.pagination;
        const header = `${total} invoice(s)${total > lines.length ? `, showing ${offset + 1}-${offset + lines.length}` : ''}.`;
        return ok([header, ...lines].join('\n'), list);
      }),
  );

  server.registerTool(
    'get_payment_transactions',
    {
      title: 'Get transactions to pay an invoice',
      description:
        'For the PAYER: returns the unsigned transaction(s) needed to pay an invoice (a token approval, if needed, then ' +
        'the payment). This server never signs or sends anything; the payer reviews and signs them in their own wallet.',
      inputSchema: {
        requestId,
        payerWallet: address.optional().describe('Payer wallet, used to check balance and approval.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ requestId, payerWallet }) =>
      run(async () => {
        const calldata = await findAcrossApis((a) => a.getPaymentCalldata(requestId, payerWallet));
        const m = calldata.metadata;
        const notes = [
          `${calldata.transactions.length} transaction(s) to sign, in order.`,
          m.needsApproval ? `Transaction ${Number(m.approvalTransactionIndex ?? 0) + 1} is a token approval.` : '',
          ...calldata.transactions.map((tx, i) => unlimitedApprovalWarning(tx.data, i)),
          m.hasEnoughBalance === false ? 'Warning: the payer wallet does not have enough balance.' : '',
          m.hasEnoughGas === false ? 'Warning: the payer wallet does not have enough gas.' : '',
          'Unsigned: review and sign in your own wallet. This server cannot send them.',
        ].filter(Boolean);
        return ok(notes.join('\n'), calldata);
      }),
  );

  server.registerTool(
    'find_currency',
    {
      title: 'Find a currency ID',
      description:
        'Look up Request Network currency IDs to use as paymentCurrency, e.g. symbol "USDC" on network "base" or "sepolia".',
      inputSchema: {
        symbol: z.string().trim().max(20).optional(),
        network: z.string().trim().max(40).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, network }) =>
      run(async () => {
        if (!symbol && !network) return fail('Pass a symbol, a network, or both.');
        const currencies = await api.findCurrencies({ symbol, network });
        const shown = currencies.slice(0, 50);
        const lines = shown.map((c) => `- ${c.id}${c.network ? ` (${c.network})` : ''}${c.address ? ` ${c.address}` : ''}`);
        const more = currencies.length > shown.length ? `\n…and ${currencies.length - shown.length} more; narrow the search.` : '';
        return ok(`${currencies.length} match(es):\n${lines.join('\n')}${more}`, shown);
      }),
  );

  return server;
}

/** Lists invoices from several Client IDs, merged newest first. */
async function mergeLists(apis: RequestApi[], walletAddress: string | undefined, limit: number, offset: number) {
  const window = Math.min(100, offset + limit);
  const lists = await Promise.all(apis.map((a) => a.listRequests({ walletAddress, limit: window, offset: 0 })));
  const byId = new Map<string, RequestListItem>();
  for (const l of lists) for (const r of l.requests) byId.set(r.requestId, r);
  const merged = [...byId.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return {
    requests: merged.slice(offset, offset + limit),
    pagination: { total: lists.reduce((n, l) => n + (l.pagination?.total ?? l.requests.length), 0), limit, offset },
  };
}

export function describeStatus(s: RequestStatus): string {
  const amountText = `${s.requestAmount ?? '?'} ${s.invoiceCurrency ?? ''}`.trim();
  const lines = [
    `Invoice ${s.requestId}: ${s.hasBeenPaid ? 'PAID' : 'NOT PAID YET'}${s.status ? ` (status: ${s.status})` : ''}.`,
    `Amount: ${amountText}${s.paymentCurrency ? `, paid in ${s.paymentCurrency}` : ''}${Number(s.amountInUsd) > 0 ? ` (~$${s.amountInUsd})` : ''}.`,
  ];
  if (s.payee) lines.push(`Payee: ${s.payee}`);
  if (s.reference) lines.push(`Reference: ${s.reference}`);
  for (const p of s.payments ?? []) {
    lines.push(
      `Payment: ${p.amount ?? '?'}${p.paymentCurrency ? ` ${p.paymentCurrency}` : ''}` +
        `${payerText(p)}${p.timestamp ? ` at ${p.timestamp}` : ''}` +
        `${p.sourceTxHash ? `, tx ${p.sourceTxHash}` : ''}`,
    );
  }
  if (!s.payments?.length && s.txHash) lines.push(`Payment tx: ${s.txHash}`);
  return lines.join('\n');
}

/** Flags ERC-20 approve(spender, amount) calls that grant the maximum possible allowance. */
export function unlimitedApprovalWarning(data: string, index: number): string {
  const m = /^0x095ea7b3([0-9a-fA-F]{64})([0-9a-fA-F]{64})$/.exec(data ?? '');
  if (!m) return '';
  const amount = BigInt('0x' + m[2]);
  if (amount < 2n ** 128n) return '';
  const spender = '0x' + m[1].slice(24);
  return (
    `Warning: transaction ${index + 1} approves an UNLIMITED amount to ${spender}. ` +
    'Most wallets let you edit the approval down to the invoice amount before signing.'
  );
}

function payerText(p: RequestPayment): string {
  if (!p.payerAddress) return '';
  const eoa = p.payerEoaAddress?.toLowerCase() !== p.payerAddress.toLowerCase() ? p.payerEoaAddress : undefined;
  return eoa ? ` from ${eoa} (via smart account ${p.payerAddress})` : ` from ${p.payerAddress}`;
}

function ok(text: string, data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RequestApiError) return fail(e.message);
    return fail(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
