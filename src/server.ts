import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RequestApi, RequestApiError, type RequestPayment, type RequestStatus } from './api.js';
import type { ServerConfig } from './config.js';

export const VERSION = '0.1.0';

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

export function createServer(config: ServerConfig, api: RequestApi): McpServer {
  const server = new McpServer({ name: 'req-invoice-mcp', version: VERSION });

  server.registerTool(
    'create_payment_link',
    {
      title: 'Create a payment link',
      description:
        'Bill someone and get a link they can open to pay in their own wallet. Uses the network and token of the ' +
        "receiving route set up in the Request Network dashboard (REQUEST_DESTINATION_ID). The amount is in that route's token. " +
        'This is the easiest way to get paid.',
      inputSchema: { amount },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ amount }) =>
      run(async () => {
        if (!config.destinationId) {
          return fail(
            'No receiving route configured. Copy the Route ID from https://dashboard.request.network into ' +
              'REQUEST_DESTINATION_ID, or use create_invoice instead.',
          );
        }
        const link = await api.createPaymentLink(config.destinationId, amount);
        return ok(
          `Payment link created for ${amount}. Send this to the payer:\n${link.securePaymentUrl}\n` +
            `Invoice ID: ${link.requestIds.join(', ')} (use check_invoice to see when it's paid).`,
          link,
        );
      }),
  );

  server.registerTool(
    'create_invoice',
    {
      title: 'Create an invoice',
      description:
        'Create an on-chain invoice (a "request") for a specific amount, currency and network. ' +
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
        const payee = args.payee ?? config.defaultPayee;
        if (!payee && !config.api.clientId) {
          return fail('No payee: pass payee, or set REQUEST_PAYEE to the wallet that should receive payments.');
        }
        const created = await api.createRequest({
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
      description: 'Check whether an invoice has been paid, with the payment transaction(s) if it has.',
      inputSchema: { requestId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ requestId }) =>
      run(async () => {
        const status = await api.getRequest(requestId);
        return ok(describeStatus(status), status);
      }),
  );

  server.registerTool(
    'list_invoices',
    {
      title: 'List invoices',
      description: 'List invoices created with these credentials, newest first, with paid/unpaid status.',
      inputSchema: {
        walletAddress: address.optional().describe('Only invoices paid to this wallet.'),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      run(async () => {
        const list = await api.listRequests({ walletAddress: args.walletAddress, limit: args.limit ?? 20, offset: args.offset });
        const lines = list.requests.map(
          (r) =>
            `- ${r.hasBeenPaid ? 'PAID  ' : 'UNPAID'} ${r.amount ?? '?'} ${r.invoiceCurrency ?? ''}` +
            `${r.reference ? ` "${r.reference}"` : ''}${r.createdAt ? ` (${r.createdAt.slice(0, 10)})` : ''} id ${r.requestId}`,
        );
        const { total, offset } = list.pagination;
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
        const calldata = await api.getPaymentCalldata(requestId, payerWallet);
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
