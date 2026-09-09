import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathExists, readJson, writeJsonAtomic } from "./fsAtomic";
import { backupsDir, claudeAltConfigFile, claudeConfigFile } from "./paths";

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

/**
 * Resolve the config file inside a Claude data directory.
 *
 * Claude Code prefers `<dataDir>/.config.json` when it exists and otherwise
 * falls back to `<dataDir>/.claude.json`. Every place that reads a config --
 * the shared one and each slot's own -- must apply the same precedence, or a
 * machine on the newer layout silently reads nothing.
 */
export async function resolveConfigPathIn(
  dataDir: string,
  fallbackFile: string,
): Promise<string> {
  const preferred = path.join(dataDir, ".config.json");
  return (await pathExists(preferred)) ? preferred : fallbackFile;
}

/** The shared config the official extension uses when CLAUDE_CONFIG_DIR is unset. */
export async function resolveConfigPath(): Promise<string> {
  return resolveConfigPathIn(path.dirname(claudeAltConfigFile()), claudeConfigFile());
}

function assertObject(value: unknown, source: string): ClaudeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} did not contain a JSON object`);
  }
  return value as ClaudeConfig;
}

export async function readConfig(): Promise<{ path: string; config: ClaudeConfig }> {
  const configPath = await resolveConfigPath();
  return { path: configPath, config: assertObject(await readJson(configPath), configPath) };
}

/**
 * Read the config belonging to some other data directory, e.g. a slot's own
 * `~/.claude-pro2/.claude.json`, honouring the same `.config.json` precedence.
 * Returns undefined when the slot has no config yet, which is normal.
 */
export async function readConfigIn(dataDir: string): Promise<ClaudeConfig | undefined> {
  const configPath = await resolveConfigPathIn(dataDir, path.join(dataDir, ".claude.json"));
  try {
    return assertObject(await readJson(configPath), configPath);
  } catch {
    return undefined;
  }
}

export async function writeConfig(configPath: string, config: ClaudeConfig): Promise<void> {
  await writeJsonAtomic(configPath, config);
}

/** Snapshot the config before we modify it. Returns the backup path. */
export async function backupConfig(configPath: string, keep = 10): Promise<string> {
  const dir = backupsDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `claude.json.${stamp}`);
  await fs.copyFile(configPath, dest);
  await pruneBackups(dir, keep, dest);
  return dest;
}

/** Keep the most recent `keep` backups, never deleting the one just taken. */
async function pruneBackups(dir: string, keep: number, protect: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const backups = entries.filter((name) => name.startsWith("claude.json.")).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
    const full = path.join(dir, stale);
    if (full === protect) {
      continue;
    }
    await fs.rm(full, { force: true }).catch(() => undefined);
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

export interface AccountState {
  oauthAccount?: OAuthAccount;
  caches?: Record<string, unknown>;
}

export interface CommitResult {
  /** The config as it stood before this call. Restore from here to undo. */
  backupPath: string;
  configPath: string;
}

/**
 * Read, swap the account-scoped slice, write, and confirm it landed.
 *
 * Claude Code rewrites ~/.claude.json on its own schedule and does not take a
 * lock around it (its proper-lockfile usage covers credential storage, not this
 * file), so a running Claude process can overwrite us between our write and our
 * read-back.
 *
 * The backup is taken once, before the first write, so it is always the true
 * pre-switch state -- taking it inside the loop would snapshot our own
 * half-applied change and make the caller's rollback restore that instead. If
 * every attempt loses the race we restore from that backup ourselves, so a
 * thrown error really does mean the config is untouched.
 */
export async function commitAccountState(
  state: AccountState,
  attempts = 3,
): Promise<CommitResult> {
  const { path: configPath, config: original } = await readConfig();
  const backupPath = await backupConfig(configPath);
  let lastMismatch: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Re-read each time: a racing writer may have added unrelated keys we must keep.
    const { config } = attempt === 1 ? { config: original } : await readConfig();
    await writeConfig(configPath, applyAccountState(config, state));

    const { config: verified } = await readConfig();
    const observed = (verified[OAUTH_ACCOUNT_KEY] as OAuthAccount | undefined)?.accountUuid;
    const expected = state.oauthAccount?.accountUuid;

    if (observed === expected) {
      return { backupPath, configPath };
    }
    lastMismatch = `expected ${expected ?? "(none)"}, found ${observed ?? "(none)"}`;
  }

  // Leave the config exactly as we found it rather than half-switched.
  await restoreConfig(backupPath, configPath).catch(() => undefined);
  throw new Error(
    `Another process kept rewriting Claude Code's config while switching (${lastMismatch}). ` +
      "Close running Claude conversations and try again.",
  );
}

/**
 * Apply a profile's snapshot onto the config.
 *
 * When a profile has no snapshot yet (a freshly added slot) we *delete* the
 * account-scoped keys rather than leaving the other account's values behind,
 * so Claude Code repopulates them from its own next API response.
 */
export function applyAccountState(config: ClaudeConfig, state: AccountState): ClaudeConfig {
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
