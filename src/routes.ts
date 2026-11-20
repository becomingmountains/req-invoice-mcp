// Receiving routes ("destinations" in the Request Network dashboard).
// A Route ID looks like: <payee wallet>@<chain namespace>:<chain id>#<tag>:<token address>
// Each route is one wallet + one network + one token, optionally with its own Client ID.

const ADDRESS = '(0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33})';
export const ROUTE_ID_RE = new RegExp(`^${ADDRESS}@([a-z0-9]+):([0-9A-Za-z]+)#([0-9A-Fa-f]+):${ADDRESS}$`);

/** EVM chain id -> Request Network network name (as used in currency IDs like "USDC-base"). */
const EVM_NETWORKS: Record<string, string> = {
  '1': 'mainnet',
  '10': 'optimism',
  '56': 'bsc',
  '100': 'xdai',
  '137': 'matic',
  '250': 'fantom',
  '324': 'zksyncera',
  '8453': 'base',
  '42161': 'arbitrum-one',
  '42220': 'celo',
  '43114': 'avalanche',
  '59144': 'linea',
  '534352': 'scroll',
  '11155111': 'sepolia',
};

const NETWORK_LABELS: Record<string, string> = {
  mainnet: 'Ethereum',
  optimism: 'Optimism',
  bsc: 'BNB Chain',
  xdai: 'Gnosis',
  matic: 'Polygon',
  fantom: 'Fantom',
  zksyncera: 'zkSync Era',
  base: 'Base',
  'arbitrum-one': 'Arbitrum',
  celo: 'Celo',
  avalanche: 'Avalanche',
  linea: 'Linea',
  scroll: 'Scroll',
  sepolia: 'Sepolia (testnet)',
  tron: 'Tron',
};

/** Words people use for a network -> Request network name. */
const NETWORK_ALIASES: Record<string, string> = {
  ethereum: 'mainnet',
  eth: 'mainnet',
  mainnet: 'mainnet',
  'ethereum mainnet': 'mainnet',
  optimism: 'optimism',
  op: 'optimism',
  bsc: 'bsc',
  bnb: 'bsc',
  'bnb chain': 'bsc',
  binance: 'bsc',
  gnosis: 'xdai',
  xdai: 'xdai',
  polygon: 'matic',
  matic: 'matic',
  pol: 'matic',
  fantom: 'fantom',
  zksync: 'zksyncera',
  'zksync era': 'zksyncera',
  zksyncera: 'zksyncera',
  base: 'base',
  arbitrum: 'arbitrum-one',
  arb: 'arbitrum-one',
  'arbitrum one': 'arbitrum-one',
  'arbitrum-one': 'arbitrum-one',
  celo: 'celo',
  avalanche: 'avalanche',
  avax: 'avalanche',
  linea: 'linea',
  scroll: 'scroll',
  sepolia: 'sepolia',
  'ethereum sepolia': 'sepolia',
  testnet: 'sepolia',
  tron: 'tron',
};

export interface Route {
  /** The full Route ID from the dashboard. */
  id: string;
  /** Client ID used for this route; falls back to the default credentials when absent. */
  clientId?: string;
  payee: string;
  chain: string;
  /** Request network name, e.g. "base"; undefined for chains this server doesn't know. */
  network?: string;
  token: string;
}

export function parseRouteId(id: string): Omit<Route, 'clientId'> | undefined {
  const m = ROUTE_ID_RE.exec(id);
  if (!m) return undefined;
  const [, payee, namespace, chainId, , token] = m;
  const network = namespace === 'eip155' ? EVM_NETWORKS[chainId] : namespace === 'tron' ? 'tron' : undefined;
  return { id, payee, chain: `${namespace}:${chainId}`, network, token };
}

export function networkLabel(network: string | undefined, chain: string): string {
  return (network && NETWORK_LABELS[network]) ?? network ?? `chain ${chain}`;
}

export function normalizeNetwork(input: string): string | undefined {
  const key = input.trim().toLowerCase().replace(/\s+/g, ' ');
  return NETWORK_ALIASES[key] ?? (Object.values(EVM_NETWORKS).includes(key) ? key : undefined);
}

/**
 * Canonical token symbol for matching what people say: "fUSDC" (Request's test USDC) and
 * "USDCn" (native USDC on some chains) both match "USDC".
 */
export function canonicalSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (/^FUSD[CT]$/.test(s)) return s.slice(1);
  if (/^USD[CT]N$/.test(s)) return s.slice(0, -1);
  if (s === 'USDC.E' || s === 'USDBC') return 'USDC';
  return s;
}

export interface RouteChoice<R> {
  route?: R;
  /** Set when no single route could be chosen; explains why. */
  problem?: string;
}

/**
 * Picks the route for a payment link. With no hints, the first route is the default.
 * `symbolOf` returns the route's token symbol when known.
 */
export function chooseRoute<R extends Route>(
  routes: R[],
  hints: { currency?: string; network?: string },
  symbolOf: (route: R) => string | undefined,
): RouteChoice<R> {
  if (!routes.length) return { problem: 'No receiving routes configured.' };
  let candidates = routes;

  if (hints.network) {
    const wanted = normalizeNetwork(hints.network);
    if (!wanted) return { problem: `Unknown network "${hints.network}".` };
    candidates = candidates.filter((r) => r.network === wanted);
    if (!candidates.length) return { problem: `No route on ${networkLabel(wanted, '')}.` };
  }
  if (hints.currency) {
    const wanted = canonicalSymbol(hints.currency);
    const byToken = candidates.filter((r) => {
      const symbol = symbolOf(r);
      return (symbol && canonicalSymbol(symbol) === wanted) || r.token.toLowerCase() === hints.currency!.trim().toLowerCase();
    });
    if (!byToken.length) return { problem: `No route takes ${hints.currency}${hints.network ? ` on ${hints.network}` : ''}.` };
    candidates = byToken;
  }

  if (candidates.length === 1 || (!hints.currency && !hints.network)) return { route: candidates[0] };
  return { problem: 'More than one route matches; say which network.' };
}
