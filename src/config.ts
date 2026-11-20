import type { ApiConfig } from './api.js';

export interface ServerConfig {
  api: ApiConfig;
  /** Default wallet that receives payments, used when an invoice doesn't name one. */
  defaultPayee?: string;
  /** Dashboard "Route ID" (destination ID). Enables hosted payment links. */
  destinationId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const apiKey = clean(env.REQUEST_API_KEY);
  const clientId = clean(env.REQUEST_CLIENT_ID);
  if (!apiKey && !clientId) {
    throw new Error(
      'Missing credentials: set REQUEST_API_KEY or REQUEST_CLIENT_ID (free from https://dashboard.request.network).',
    );
  }
  const defaultPayee = clean(env.REQUEST_PAYEE);
  if (defaultPayee && !/^0x[0-9a-fA-F]{40}$/.test(defaultPayee) && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(defaultPayee)) {
    throw new Error('REQUEST_PAYEE must be a 0x… EVM address or a T… Tron address');
  }
  const baseUrl = clean(env.REQUEST_API_URL) ?? 'https://api.request.network';
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(baseUrl)) {
    throw new Error('REQUEST_API_URL must use https');
  }
  return {
    api: {
      baseUrl,
      apiKey,
      clientId,
      // Client ID auth requires an Origin header that matches the client ID's allowed domains.
      origin: clean(env.REQUEST_ORIGIN),
    },
    defaultPayee,
    destinationId: clean(env.REQUEST_DESTINATION_ID),
  };
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
