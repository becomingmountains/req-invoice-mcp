// Thin client for the Request Network REST API (https://api.request.network).
// Read and create only: this module never signs or sends a blockchain transaction.

export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  clientId?: string;
  origin?: string;
  timeoutMs?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class RequestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RequestApiError';
  }
}

export interface CreatedRequest {
  requestId: string;
  paymentReference: string;
}

export interface CreatedPaymentLink {
  requestIds: string[];
  securePaymentUrl: string;
  token: string;
}

export interface RequestPayment {
  amount?: string;
  sourceNetwork?: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
  payerAddress?: string;
  /** Wallet behind a smart-account payer, when reported. */
  payerEoaAddress?: string;
  timestamp?: string;
  paymentCurrency?: string;
}

export interface RequestStatus {
  requestId: string;
  paymentReference?: string;
  hasBeenPaid: boolean;
  status?: string;
  payee?: string;
  requestAmount?: string;
  invoiceCurrency?: string;
  paymentCurrency?: string;
  amountInUsd?: string;
  reference?: string;
  txHash?: string | null;
  payments?: RequestPayment[];
}

export interface RequestListItem {
  requestId: string;
  paymentReference?: string;
  amount?: string;
  invoiceCurrency?: string;
  paymentCurrency?: string;
  hasBeenPaid?: boolean;
  status?: string;
  reference?: string;
  createdAt?: string;
  txHash?: string | null;
  payee?: string;
  payer?: string;
}

export interface RequestList {
  requests: RequestListItem[];
  pagination: { total: number; limit: number; offset: number };
}

export interface UnsignedTransaction {
  to: string;
  data: string;
  value: unknown;
}

export interface PaymentCalldata {
  transactions: UnsignedTransaction[];
  metadata: Record<string, unknown>;
}

export interface Currency {
  id: string;
  symbol: string;
  network?: string;
  address?: string;
  decimals?: number;
  type?: string;
}

export interface CreateRequestInput {
  amount: string;
  invoiceCurrency: string;
  paymentCurrency: string;
  payee?: string;
  payer?: string;
  reference?: string;
}

export class RequestApi {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: ApiConfig,
    fetchImpl?: FetchLike,
  ) {
    if (!config.apiKey && !config.clientId) {
      throw new Error('Set REQUEST_API_KEY or REQUEST_CLIENT_ID');
    }
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  createRequest(input: CreateRequestInput): Promise<CreatedRequest> {
    return this.send('POST', '/v2/request', compact(input));
  }

  createPaymentLink(destinationId: string, amount: string): Promise<CreatedPaymentLink> {
    return this.send('POST', '/v2/secure-payments', { requests: [{ destinationId, amount }] });
  }

  getRequest(requestId: string): Promise<RequestStatus> {
    return this.send('GET', `/v2/request/${encodeURIComponent(requestId)}`);
  }

  listRequests(params: { walletAddress?: string; limit?: number; offset?: number }): Promise<RequestList> {
    return this.send('GET', `/v2/request${query(params)}`);
  }

  getPaymentCalldata(requestId: string, wallet?: string): Promise<PaymentCalldata> {
    return this.send('GET', `/v2/request/${encodeURIComponent(requestId)}/pay${query({ wallet })}`);
  }

  async findCurrencies(params: { network?: string; symbol?: string }): Promise<Currency[]> {
    const result = await this.send<Currency[] | Currency>('GET', `/v2/currencies${query(params)}`);
    return Array.isArray(result) ? result : [result];
  }

  private async send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey;
    else if (this.config.clientId) headers['x-client-id'] = this.config.clientId;
    if (this.config.origin) headers.origin = this.config.origin;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(this.config.baseUrl.replace(/\/+$/, '') + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new RequestApiError(`Request Network API ${reason}`, 0);
    }

    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body; handled below.
    }
    if (!res.ok) throw new RequestApiError(errorMessage(res.status, json), res.status);
    if (json === undefined) throw new RequestApiError('Request Network API returned an empty or invalid response', res.status);
    return json as T;
  }
}

function errorMessage(status: number, json: unknown): string {
  const raw = (json as { message?: unknown } | undefined)?.message;
  const detail = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : '';
  const hint =
    status === 401 || status === 403
      ? ' (check REQUEST_API_KEY / REQUEST_CLIENT_ID)'
      : status === 404
        ? ' (no invoice with that ID)'
        : status === 429
          ? ' (rate limited, try again shortly)'
          : '';
  // Cap the length so an unexpected response body can't flood the conversation.
  return `Request Network API error ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}${hint}`;
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}
