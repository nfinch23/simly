import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_RETAIL_ROOT = 'C:\\Program Files (x86)\\World of Warcraft\\_retail_';

export interface WowPaths {
  retailRoot: string;
  account: string;
  savedVarsPath: string;
  resultsAddonDir: string;
  resultsLuaPath: string;
}

export interface ResolveOptions {
  /** Override the retail folder root (defaults to the standard install location). */
  retailRoot?: string;
}

/**
 * Resolve the WoW paths Simly needs to read and write. Phase 1
 * auto-detects the account folder under WTF/Account/. If exactly one
 * candidate exists we use it; if multiple exist we take the first
 * lexicographically and warn — the Settings UI in phase 5 lets the user
 * override this. Throws if the install isn't found or no account folder
 * exists yet.
 */
export function resolveWowPaths(options: ResolveOptions = {}): WowPaths {
  const retailRoot = options.retailRoot ?? DEFAULT_RETAIL_ROOT;

  if (!existsSync(retailRoot)) {
    throw new Error(
      `WoW retail folder not found at ${retailRoot}. Pass a custom retailRoot or install WoW at the default path.`,
    );
  }

  const accountsDir = join(retailRoot, 'WTF', 'Account');
  if (!existsSync(accountsDir)) {
    throw new Error(
      `WTF/Account folder not found at ${accountsDir}. Has WoW been launched at least once?`,
    );
  }

  const accounts = readdirSync(accountsDir).filter((name) => {
    if (name === 'SavedVariables') return false;
    return statSync(join(accountsDir, name)).isDirectory();
  });

  if (accounts.length === 0) {
    throw new Error(`No account folders found under ${accountsDir}.`);
  }

  if (accounts.length > 1) {
    console.warn(
      `[wow-paths] Multiple WoW accounts found: ${accounts.join(', ')}. Using "${accounts[0]}". Settings UI in phase 5 will let you choose.`,
    );
  }

  const account = accounts[0]!;

  return {
    retailRoot,
    account,
    savedVarsPath: join(
      accountsDir,
      account,
      'SavedVariables',
      'Simly.lua',
    ),
    resultsAddonDir: join(retailRoot, 'Interface', 'AddOns', 'SimlyResults'),
    resultsLuaPath: join(
      retailRoot,
      'Interface',
      'AddOns',
      'SimlyResults',
      'SimlyResults.lua',
    ),
  };
}
