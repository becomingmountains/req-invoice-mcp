import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests must never touch the real notebook in ~/.config: point HOME and XDG_CONFIG_HOME at a throwaway folder.
const sandbox = mkdtempSync(join(tmpdir(), 'req-invoice-test-home-'));

export default defineConfig({
  test: {
    env: { HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, '.config') },
  },
});
