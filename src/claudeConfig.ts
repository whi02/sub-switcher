import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  backupsDir,
  claudeAltConfigFile,
  claudeConfigFile,
} from "./paths";

/**
 * Read/write access to Claude Code's shared config file (~/.claude.json).
 *
 * We only ever touch the account-scoped *cache* keys listed below. These are
 * identity metadata and cached quota numbers -- not credentials. Tokens live in
 * the OS keychain and this extension never reads or writes them.
 */

/** Identity metadata for the signed-in account. Not a secret. */
export const OAUTH_ACCOUNT_KEY = "oauthAccount";

/**
 * Cache keys whose contents belong to whichever account was last active.
 * Leaving a previous account's values in place after a switch shows stale
 * quota and model availability, so we swap them alongside the credential slot.
 */
export const ACCOUNT_SCOPED_CACHE_KEYS = [
  "cachedUsageUtilization",
  "passesEligibilityCache",
  "passesLastSeenRemaining",
  "modelAccessCache",
  "orgModelDefaultCache",
  "additionalModelOptionsCache",
  "additionalModelCostsCache",
  "clientDataCacheSlots",
  "cachedExtraUsageDisabledReason",
  "claudeCodeFirstTokenDate",
] as const;

export type ClaudeConfig = Record<string, unknown>;

export interface OAuthAccount {
  emailAddress?: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
  displayName?: string;
  organizationType?: string;
  [key: string]: unknown;
}

/** Resolve the config file the CLI actually uses, honouring the newer .config.json layout. */
export async function resolveConfigPath(): Promise<string> {
  const alt = claudeAltConfigFile();
  try {
    await fs.access(alt);
    return alt;
  } catch {
    return claudeConfigFile();
  }
}

export async function readConfig(): Promise<{ path: string; config: ClaudeConfig }> {
  const configPath = await resolveConfigPath();
  const raw = await fs.readFile(configPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} did not contain a JSON object`);
  }
  return { path: configPath, config: parsed as ClaudeConfig };
}

/**
 * Write the config back atomically: temp file in the same directory, then rename.
 * A crashed write must never leave the user with a truncated ~/.claude.json.
 */
export async function writeConfig(configPath: string, config: ClaudeConfig): Promise<void> {
  const dir = path.dirname(configPath);
  const tmp = path.join(dir, `.claude.json.tmp-${process.pid}-${Date.now()}`);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(tmp, body, { mode: 0o600 });
  try {
    await fs.rename(tmp, configPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Snapshot the config before we modify it. Returns the backup path. */
export async function backupConfig(configPath: string, keep = 10): Promise<string> {
  const dir = backupsDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `claude.json.${stamp}`);
  await fs.copyFile(configPath, dest);
  await pruneBackups(dir, keep);
  return dest;
}

async function pruneBackups(dir: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const backups = entries.filter((name) => name.startsWith("claude.json.")).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
    await fs.rm(path.join(dir, stale), { force: true }).catch(() => undefined);
  }
}

export async function restoreConfig(backupPath: string, configPath: string): Promise<void> {
  await fs.copyFile(backupPath, configPath);
}

/** Pull the account-scoped slice out of a config, for storing in a profile snapshot. */
export function extractAccountState(config: ClaudeConfig): {
  oauthAccount: OAuthAccount | undefined;
  caches: Record<string, unknown>;
} {
  const oauthAccount = config[OAUTH_ACCOUNT_KEY] as OAuthAccount | undefined;
  const caches: Record<string, unknown> = {};
  for (const key of ACCOUNT_SCOPED_CACHE_KEYS) {
    if (key in config) {
      caches[key] = config[key];
    }
  }
  return { oauthAccount, caches };
}

/**
 * Apply a profile's snapshot onto the config.
 *
 * When a profile has no snapshot yet (a freshly added slot) we *delete* the
 * account-scoped keys rather than leaving the other account's values behind,
 * so Claude Code repopulates them from its own next API response.
 */
/**
 * Read, swap the account-scoped slice, write, and confirm it landed.
 *
 * Claude Code rewrites ~/.claude.json on its own schedule and does not take a
 * lock around it (its proper-lockfile usage covers credential storage, not this
 * file), so a running Claude process can overwrite us between our read and our
 * write. The window is milliseconds and the consequence is cosmetic -- the UI
 * would show the previous account's email while the correct token is in use --
 * but it is cheap to notice and retry, so we do.
 *
 * Returns the backup path taken before the first successful write.
 */
export async function commitAccountState(
  state: { oauthAccount?: OAuthAccount; caches?: Record<string, unknown> },
  attempts = 3,
): Promise<{ backupPath: string; configPath: string }> {
  let lastMismatch: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { path: configPath, config } = await readConfig();
    const backupPath = await backupConfig(configPath);
    await writeConfig(configPath, applyAccountState(config, state));

    const { config: verified } = await readConfig();
    const observed = (verified[OAUTH_ACCOUNT_KEY] as OAuthAccount | undefined)?.accountUuid;
    const expected = state.oauthAccount?.accountUuid;

    if (observed === expected) {
      return { backupPath, configPath };
    }
    lastMismatch = `expected ${expected ?? "(none)"}, found ${observed ?? "(none)"}`;
  }

  throw new Error(
    `Another process kept rewriting Claude Code's config while switching (${lastMismatch}). ` +
      "Close running Claude conversations and try again.",
  );
}

export function applyAccountState(
  config: ClaudeConfig,
  state: { oauthAccount?: OAuthAccount; caches?: Record<string, unknown> },
): ClaudeConfig {
  const caches = state.caches ?? {};

  // What each managed key should become: a value, or absent.
  const incoming = new Map<string, unknown>();
  if (state.oauthAccount) {
    incoming.set(OAUTH_ACCOUNT_KEY, state.oauthAccount);
  }
  for (const key of ACCOUNT_SCOPED_CACHE_KEYS) {
    if (key in caches) {
      incoming.set(key, caches[key]);
    }
  }

  const managed = new Set<string>([OAUTH_ACCOUNT_KEY, ...ACCOUNT_SCOPED_CACHE_KEYS]);

  // Rebuild in the original key order. Deleting and re-adding would shuffle
  // roughly two thirds of the file on every switch, which makes the backups
  // we keep useless for eyeballing what actually changed.
  const next: ClaudeConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (!managed.has(key)) {
      next[key] = value;
    } else if (incoming.has(key)) {
      next[key] = incoming.get(key);
    }
    // A managed key with no incoming value is dropped, so Claude Code refetches it.
  }
  // Managed keys the previous account did not have yet go on the end.
  for (const [key, value] of incoming) {
    if (!(key in next)) {
      next[key] = value;
    }
  }
  return next;
}
