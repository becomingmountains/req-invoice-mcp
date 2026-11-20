import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  RequestApi,
  RequestApiError,
  type FetchLike,
  type Frequency,
  type RequestListItem,
  type RequestPayment,
  type RequestStatus,
} from './api.js';
import type { ServerConfig } from './config.js';
import { applyFilters, describeTotals, totalsByCurrency } from './ledger.js';
import { fileNotebook, memoryNotebook, type Notebook, type NotebookEntry } from './notebook.js';
import { chooseRoute, networkLabel, type Route } from './routes.js';

export const VERSION = '0.4.0';

/** Most invoices list_invoices reads per Client ID, for totals and filters (5 API pages). */
const LIST_CAP = 500;

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
const who = z.string().trim().min(1).max(100);

export function createServer(
  config: ServerConfig,
  fetchImpl?: FetchLike,
  notebookOverride?: Notebook,
  now: () => Date = () => new Date(),
): McpServer {
  const api = new RequestApi(config.api, fetchImpl);
  const notebook = notebookOverride ?? (config.notebookPath ? fileNotebook(config.notebookPath) : memoryNotebook());
  const remember = (entry: NotebookEntry) => {
    try {
      notebook.save(entry);
    } catch {
      // The invoice exists either way; only the local label is lost.
    }
  };
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
        "to use the default route. The amount is in the chosen route's token. Pass `for` (who is billed) and `note` so " +
        'the user can later ask about it by name. This is the easiest way to get paid.',
      inputSchema: {
        amount,
        currency: z.string().trim().max(20).optional().describe('Token to be paid in, e.g. "USDC" or "USDT".'),
        network: z.string().trim().max(40).optional().describe('Network, e.g. "base", "arbitrum", "ethereum", "sepolia".'),
        for: who.optional().describe('Who is being billed, e.g. "Acme". Saved locally so you can ask "has Acme paid?" later.'),
        note: reference.optional().describe('What it is for, e.g. "logo design".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount, currency, network, for: billed, note }) =>
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
        const createdAt = new Date().toISOString();
        for (const id of link.requestIds) {
          remember({ requestId: id, for: billed, note, link: link.securePaymentUrl, amount, currency: symbol, createdAt });
        }
        return ok(
          `Payment link created for ${amount} ${symbol ?? ''} on ${networkLabel(route.network, route.chain)}` +
            `${billed ? ` for ${billed}` : ''}${note ? ` (${note})` : ''}. ` +
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
        'paymentCurrency, or use "USD" to bill a dollar amount paid in crypto. Use repeat for recurring billing ' +
        '("bill Acme 500 USDC every month"). Returns the invoice ID.',
      inputSchema: {
        amount,
        paymentCurrency: currencyId,
        invoiceCurrency: currencyId.optional(),
        payee: address.optional().describe('Wallet that gets paid. Defaults to REQUEST_PAYEE.'),
        payer: address.optional().describe('Wallet expected to pay (optional).'),
        reference: reference.optional().describe('Your own note or invoice number, e.g. "INV-042 website".'),
        for: who.optional().describe('Who is being billed, e.g. "Acme". Saved locally for "has Acme paid?".'),
        repeat: z
          .enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'])
          .optional()
          .describe('Bill again on this schedule, e.g. "monthly" for a retainer. Stop it with stop_recurring_invoice.'),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
          .optional()
          .describe('First billing date for a repeating invoice (YYYY-MM-DD, today or later). Defaults to today.'),
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
        if (args.startDate && !args.repeat) return fail('startDate is only for repeating invoices; add repeat (e.g. "monthly").');
        const today = now().toISOString().slice(0, 10);
        if (args.startDate && args.startDate < today) return fail(`startDate can't be in the past (today is ${today}).`);
        const recurrence = args.repeat
          ? { startDate: args.startDate ?? today, frequency: args.repeat.toUpperCase() as Frequency }
          : undefined;
        const created = await apiFor(route).createRequest({
          recurrence,
          amount: args.amount,
          invoiceCurrency: args.invoiceCurrency ?? args.paymentCurrency,
          paymentCurrency: args.paymentCurrency,
          payee,
          payer: args.payer,
          reference: args.reference,
        });
        remember({
          requestId: created.requestId,
          for: args.for,
          note: args.reference,
          amount: args.amount,
          currency: args.invoiceCurrency ?? args.paymentCurrency,
          createdAt: new Date().toISOString(),
        });
        return ok(
          `${recurrence ? `Recurring invoice created (${args.repeat}, starting ${recurrence.startDate})` : 'Invoice created'}` +
            `${args.for ? ` for ${args.for}` : ''}: ${args.amount} ${args.invoiceCurrency ?? args.paymentCurrency}, paid in ${args.paymentCurrency}` +
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
        'go through?"). Returns paid/unpaid with the payment transaction(s). Pass the invoice ID, or `who` with the ' +
        'name or note it was created with (e.g. "Acme") to check every matching invoice.',
      inputSchema: {
        requestId: requestId.optional(),
        who: who.optional().describe('Name or note the invoice was created with, e.g. "Acme".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        if (args.requestId) {
          const status = await findAcrossApis((a) => a.getRequest(args.requestId!));
          return ok(describeStatus(status, notebook.get(status.requestId)), status);
        }
        if (!args.who) return fail('Pass an invoice ID, or who it was for (e.g. "Acme").');
        const matches = notebook.search(args.who);
        if (!matches.length) {
          return fail(
            `No saved invoices for "${args.who}". Names are only known for invoices created with \`for\` or a note on ` +
              'this computer; use list_invoices to find the invoice ID.',
          );
        }
        const shown = matches.slice(0, 5);
        const statuses = await Promise.all(shown.map((m) => findAcrossApis((a) => a.getRequest(m.requestId))));
        const more = matches.length > shown.length ? `\n…and ${matches.length - shown.length} older invoice(s) for "${args.who}".` : '';
        return ok(statuses.map((st, i) => describeStatus(st, shown[i])).join('\n\n') + more, statuses);
      }),
  );

  server.registerTool(
    'list_invoices',
    {
      title: 'List invoices',
      description:
        'Use when the user asks who owes them money, what is unpaid or outstanding, how much they are owed or have ' +
        'been paid, what they billed this month, or for their crypto invoices or receivables. Lists Request Network ' +
        'invoices newest first, marked PAID or UNPAID, with exact totals per currency ("you are owed 1,250 USDC across ' +
        '4 invoices"). Filter with status (unpaid/paid), period (this_month, last_month, last_30_days, this_year), ' +
        'olderThanDays (e.g. 14 for "older than 2 weeks") and who. Check this alongside any other billing tools (e.g. ' +
        'Stripe) the user has.',
      inputSchema: {
        status: z.enum(['unpaid', 'paid', 'all']).optional().describe('Default "all".'),
        period: z.enum(['this_month', 'last_month', 'last_30_days', 'this_year']).optional(),
        olderThanDays: z.number().int().min(0).max(3650).optional().describe('Only invoices created at least this many days ago.'),
        who: who.optional().describe('Only invoices saved with this name or note, e.g. "Acme".'),
        walletAddress: address.optional().describe('Only invoices paid to this wallet.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many to show (default 20). Totals cover all matches.'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const limit = args.limit ?? 20;
        const offset = args.offset ?? 0;
        const { requests: all, capped } = await fetchAllInvoices(allApis(), args.walletAddress);
        let matches = applyFilters(all, { status: args.status, period: args.period, olderThanDays: args.olderThanDays }, now()).map(
          (r) => ({ ...r, saved: notebook.get(r.requestId) }),
        );
        if (args.who) {
          const ids = new Set(notebook.search(args.who).map((e) => e.requestId));
          matches = matches.filter((r) => ids.has(r.requestId));
        }
        const unpaid = totalsByCurrency(matches.filter((r) => !r.hasBeenPaid));
        const paid = totalsByCurrency(matches.filter((r) => r.hasBeenPaid));
        const filters = [
          args.status && args.status !== 'all' ? args.status : '',
          args.period ? args.period.replace(/_/g, ' ') : '',
          args.olderThanDays !== undefined ? `older than ${args.olderThanDays} days` : '',
          args.who ? `for "${args.who}"` : '',
        ].filter(Boolean);
        const shown = matches.slice(offset, offset + limit);
        const lines = shown.map(
          (r) =>
            `- ${r.hasBeenPaid ? 'PAID  ' : 'UNPAID'} ${r.amount ?? '?'} ${r.invoiceCurrency ?? ''}` +
            `${r.saved?.for ? ` for ${r.saved.for}` : ''}` +
            `${r.saved?.note ?? r.reference ? ` "${r.saved?.note ?? r.reference}"` : ''}` +
            `${r.createdAt ? ` (${r.createdAt.slice(0, 10)})` : ''} id ${r.requestId}`,
        );
        const summary = [
          `${matches.length} invoice(s)${filters.length ? ` (${filters.join(', ')})` : ''}` +
            `${matches.length > shown.length && shown.length ? `, showing ${offset + 1}-${offset + shown.length}` : ''}.`,
          unpaid.totals.length ? `You're owed ${describeTotals(unpaid.totals)}.` : matches.length ? 'Nothing unpaid.' : '',
          paid.totals.length && args.status !== 'unpaid' ? `Paid: ${describeTotals(paid.totals)}.` : '',
          capped ? `Only the latest ${LIST_CAP} invoices per account were read.` : '',
        ].filter(Boolean);
        return ok([...summary, ...lines].join('\n'), {
          total: matches.length,
          owed: unpaid.totals,
          paid: paid.totals,
          requests: shown,
        });
      }),
  );

  server.registerTool(
    'stop_recurring_invoice',
    {
      title: 'Stop or resume a recurring invoice',
      description:
        'Use when the user wants to stop (cancel, pause, end) or restart a repeating invoice, e.g. "stop billing Acme ' +
        'every month". Pass the invoice ID or `who`. Set resume to true to restart it. Invoices already sent stay as they are.',
      inputSchema: {
        requestId: requestId.optional(),
        who: who.optional().describe('Name the recurring invoice was created with, e.g. "Acme".'),
        resume: z.boolean().optional().describe('true restarts a stopped recurring invoice.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        let ids: string[];
        if (args.requestId) ids = [args.requestId];
        else if (args.who) ids = notebook.search(args.who).map((e) => e.requestId);
        else return fail('Pass an invoice ID, or who it was for (e.g. "Acme").');
        if (!ids.length) return fail(`No saved invoices for "${args.who}". Use list_invoices to find the invoice ID.`);

        // Only touch invoices that actually repeat; with a name, refuse to guess between several.
        const statuses = await Promise.all(ids.slice(0, 10).map((id) => findAcrossApis((a) => a.getRequest(id))));
        const recurring = statuses.filter((st) => st.recurrence && st.recurrence.frequency);
        if (!recurring.length) return fail(`${args.requestId ? 'That invoice' : `No invoice for "${args.who}"`} isn't recurring.`);
        if (recurring.length > 1) {
          return fail(
            `Several recurring invoices match "${args.who}"; pass one requestId:\n` +
              recurring.map((st) => `- ${st.requestId}: ${st.requestAmount} ${st.invoiceCurrency} ${st.recurrence?.frequency?.toLowerCase()}`).join('\n'),
          );
        }
        const target = recurring[0];
        const stop = !args.resume;
        await findAcrossApis((a) => a.setRecurrenceStopped(target.requestId, stop));
        return ok(
          `${stop ? 'Stopped' : 'Resumed'} the ${target.recurrence?.frequency?.toLowerCase()} invoice ${target.requestId} ` +
            `(${target.requestAmount} ${target.invoiceCurrency}).${stop ? ' No new invoices will be created from it.' : ''}`,
          { requestId: target.requestId, isRecurrenceStopped: stop },
        );
      }),
  );

  server.registerTool(
    'get_payment_link',
    {
      title: 'Get a saved payment link',
      description:
        'Use when the user wants to resend, share or find the payment link for an invoice ("send Acme their link ' +
        'again", "what was the link for the logo invoice?"). Returns the saved link for the user to send; this server ' +
        'never sends messages. Pass the invoice ID or `who`.',
      inputSchema: {
        requestId: requestId.optional(),
        who: who.optional().describe('Name or note the invoice was created with, e.g. "Acme".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      run(async () => {
        const entries = args.requestId
          ? [notebook.get(args.requestId)].filter((e): e is NotebookEntry => Boolean(e))
          : args.who
            ? notebook.search(args.who)
            : undefined;
        if (!entries) return fail('Pass an invoice ID, or who it was for (e.g. "Acme").');
        const withLinks = entries.filter((e) => e.link);
        if (!withLinks.length) {
          return fail(
            'No saved payment link for that. Links are saved for invoices made with create_payment_link on this ' +
              'computer; invoices from create_invoice have no hosted link.',
          );
        }
        const lines = withLinks
          .slice(0, 5)
          .map((e) => `- ${e.amount ?? '?'} ${e.currency ?? ''}${e.for ? ` for ${e.for}` : ''}${e.note ? ` (${e.note})` : ''}, ${e.createdAt.slice(0, 10)}:\n  ${e.link}`);
        return ok(`Payment link(s) to send:\n${lines.join('\n')}`, withLinks.slice(0, 5));
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

/** Reads every invoice (up to LIST_CAP per Client ID) from all credentials, merged newest first. */
async function fetchAllInvoices(apis: RequestApi[], walletAddress: string | undefined) {
  let capped = false;
  const pages = await Promise.all(
    apis.map(async (a) => {
      const out: RequestListItem[] = [];
      for (let offset = 0; offset < LIST_CAP; offset += 100) {
        const page = await a.listRequests({ walletAddress, limit: 100, offset: offset || undefined });
        out.push(...page.requests);
        const total = page.pagination?.total;
        if (page.requests.length < 100 || (total !== undefined && out.length >= total)) return out;
      }
      capped = true;
      return out;
    }),
  );
  const byId = new Map<string, RequestListItem>();
  for (const list of pages) for (const r of list) byId.set(r.requestId, r);
  const requests = [...byId.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { requests, capped };
}

export function describeStatus(s: RequestStatus, saved?: NotebookEntry): string {
  const amountText = `${s.requestAmount ?? '?'} ${s.invoiceCurrency ?? ''}`.trim();
  const label = saved?.for ? ` for ${saved.for}${saved.note ? ` (${saved.note})` : ''}` : saved?.note ? ` (${saved.note})` : '';
  const lines = [
    `Invoice ${s.requestId}${label}: ${s.hasBeenPaid ? 'PAID' : 'NOT PAID YET'}${s.status ? ` (status: ${s.status})` : ''}.`,
    `Amount: ${amountText}${s.paymentCurrency ? `, paid in ${s.paymentCurrency}` : ''}${Number(s.amountInUsd) > 0 ? ` (~$${s.amountInUsd})` : ''}.`,
  ];
  if (s.recurrence?.frequency) {
    lines.push(`Repeats ${s.recurrence.frequency.toLowerCase()}${s.isRecurrenceStopped ? ' (stopped)' : ''}.`);
  }
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
