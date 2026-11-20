import type { ApiConfig } from './api.js';
import { parseRouteId, type Route } from './routes.js';

export interface ServerConfig {
  /** Default credentials and API settings. */
  api: ApiConfig;
  /** Default wallet that receives payments, used when an invoice doesn't name one. */
  defaultPayee?: string;
  /** Receiving routes for payment links, in priority order (the first is the default). */
  routes: Route[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const apiKey = clean(env.REQUEST_API_KEY);
  const clientId = clean(env.REQUEST_CLIENT_ID);
  const routes = [
    ...parseRoutes(clean(env.REQUEST_ROUTES), 'REQUEST_ROUTES'),
    ...parseRoutes(clean(env.REQUEST_DESTINATION_ID), 'REQUEST_DESTINATION_ID'),
  ];
  const seen = new Set<string>();
  const uniqueRoutes = routes.filter((r) => !seen.has(r.id) && seen.add(r.id));

  if (!apiKey && !clientId && !(uniqueRoutes.length && uniqueRoutes.every((r) => r.clientId))) {
    throw new Error(
      'Missing credentials: set REQUEST_CLIENT_ID or REQUEST_API_KEY, or give every route in REQUEST_ROUTES its own ' +
        'Client ID (free from https://dashboard.request.network).',
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
      // Without a default Client ID or API key, the first route's Client ID is the default.
      clientId: clientId ?? (apiKey ? undefined : uniqueRoutes[0]?.clientId),
      // Optional Origin header, for Client IDs restricted to specific domains.
      origin: clean(env.REQUEST_ORIGIN),
    },
    defaultPayee,
    routes: uniqueRoutes,
  };
}

/**
 * Parses routes: entries separated by commas, semicolons or new lines. Each entry is a Route ID,
 * optionally followed by "=" and the Client ID generated on that route:
 *   0xWallet@eip155:8453#ABCD1234:0xToken=cli_abc, 0xWallet@eip155:42161#EF567890:0xToken=cli_def
 */
export function parseRoutes(value: string | undefined, name: string): Route[] {
  if (!value) return [];
  return value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [routeId, clientId, ...extra] = entry.split('=').map((s) => s.trim());
      const parsed = parseRouteId(routeId);
      if (!parsed || extra.length || (clientId !== undefined && !/^[A-Za-z0-9_-]{4,200}$/.test(clientId))) {
        const hint = routeId.includes('#')
          ? ''
          : ' It looks cut off before the "#". In a .env file, wrap the value in double quotes, because "#" starts a comment.';
        throw new Error(
          `${name}: "${entry.slice(0, 80)}" should look like 0xWallet@eip155:1#ABCD1234:0xToken, optionally followed by ` +
            `=CLIENT_ID (copy the Route ID from the dashboard).${hint}`,
        );
      }
      return { ...parsed, clientId: clientId || undefined };
    });
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}
