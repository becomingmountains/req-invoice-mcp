// Private local notebook: remembers who each invoice is for, a note, and its payment link.
// Request Network payment links can't carry a name or note, so "has Acme paid?" needs this.
// Stored as JSON on this computer only (file mode 600); never sent anywhere.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface NotebookEntry {
  requestId: string;
  /** Who the invoice is for, e.g. "Acme". */
  for?: string;
  note?: string;
  link?: string;
  amount?: string;
  currency?: string;
  createdAt: string;
}

export interface Notebook {
  get(requestId: string): NotebookEntry | undefined;
  save(entry: NotebookEntry): void;
  /** Entries whose "for" or note contains the text (case-insensitive), newest first. */
  search(text: string): NotebookEntry[];
  readonly path?: string;
}

const MAX_ENTRIES = 5000;

export function defaultNotebookPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'req-invoice-mcp', 'invoices.json');
}

/** File-backed notebook. Reads the file on every call so several assistant sessions stay in sync. */
export function fileNotebook(path: string): Notebook {
  const load = (): Record<string, NotebookEntry> => {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as { invoices?: Record<string, NotebookEntry> };
      return data && typeof data.invoices === 'object' && data.invoices ? data.invoices : {};
    } catch {
      return {};
    }
  };
  const store = (invoices: Record<string, NotebookEntry>) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, invoices }, null, 2), { mode: 0o600 });
    renameSync(tmp, path); // atomic replace, so a crash never leaves a half-written file
  };
  return {
    path,
    get: (requestId) => load()[requestId],
    save(entry) {
      const invoices = load();
      invoices[entry.requestId] = { ...invoices[entry.requestId], ...stripEmpty(entry) };
      const ids = Object.keys(invoices);
      if (ids.length > MAX_ENTRIES) {
        ids
          .sort((a, b) => invoices[a].createdAt.localeCompare(invoices[b].createdAt))
          .slice(0, ids.length - MAX_ENTRIES)
          .forEach((id) => delete invoices[id]);
      }
      store(invoices);
    },
    search: (text) => searchEntries(Object.values(load()), text),
  };
}

/** In-memory notebook, used when the file notebook is turned off and in tests. */
export function memoryNotebook(): Notebook {
  const invoices = new Map<string, NotebookEntry>();
  return {
    get: (id) => invoices.get(id),
    save: (entry) => void invoices.set(entry.requestId, { ...invoices.get(entry.requestId), ...stripEmpty(entry) }),
    search: (text) => searchEntries([...invoices.values()], text),
  };
}

function searchEntries(entries: NotebookEntry[], text: string): NotebookEntry[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  return entries
    .filter((e) => e.for?.toLowerCase().includes(q) || e.note?.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function stripEmpty(entry: NotebookEntry): NotebookEntry {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== '')) as unknown as NotebookEntry;
}
