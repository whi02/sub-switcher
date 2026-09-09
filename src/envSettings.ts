import * as vscode from "vscode";
import { ENV_CONFIG_DIR, ENV_SECURE_STORAGE_DIR } from "./paths";

/**
 * Reads and writes `claudeCode.environmentVariables` -- the setting the official
 * Claude Code extension consults every time it spawns a Claude process.
 *
 * Two properties of that setting make this whole approach work:
 *   1. It is read at spawn time, not cached, so a new conversation picks up a
 *      change immediately and no window reload is needed.
 *   2. Conversations already running keep their own process, and therefore their
 *      own account, so switching never interrupts work in flight.
 */

const SECTION = "claudeCode";
const KEY = "environmentVariables";

/** One entry as the official extension defines it, plus anything it may add later. */
export interface EnvEntry {
  name: string;
  value: string;
  [key: string]: unknown;
}

function toEntries(raw: unknown): EnvEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (item): item is EnvEntry =>
      typeof item === "object" && item !== null && typeof (item as EnvEntry).name === "string",
  );
}

/**
 * The effective value -- defaults merged with every scope. Correct for reading
 * what Claude Code will actually use, wrong to write back (see setEnvValue).
 */
function effectiveEntries(): EnvEntry[] {
  return toEntries(vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY));
}

export function getEnvValue(name: string): string | undefined {
  const entry = effectiveEntries().find((e) => e.name === name);
  return entry && typeof entry.value === "string" ? entry.value : undefined;
}

/** The credential slot the official extension will use for the next conversation. */
export function getConfiguredSlotDir(): string | undefined {
  return getEnvValue(ENV_SECURE_STORAGE_DIR);
}

/**
 * True when the user has pinned CLAUDE_CONFIG_DIR themselves. That splits the
 * data directory per account and defeats the shared history this extension
 * exists to provide, so `doctor` surfaces it rather than silently overriding it.
 */
export function getConfiguredConfigDir(): string | undefined {
  return getEnvValue(ENV_CONFIG_DIR);
}

/**
 * Set or clear one variable in the user's own settings.
 *
 * Reads `inspect().globalValue`, not the merged effective value: `get()` returns
 * defaults ∪ global ∪ workspace, so writing that back to the global target would
 * freeze the official extension's contributed defaults into the user's
 * settings.json (where they stop tracking upstream) and promote any
 * workspace-level entries machine-wide.
 *
 * Entries are carried across by reference so that any per-entry field the
 * official extension adds later survives; rebuilding them as `{name, value}`
 * would silently strip it from every entry on each switch.
 *
 * Passing `undefined` removes the entry entirely rather than setting it empty --
 * an empty CLAUDE_SECURESTORAGE_CONFIG_DIR means "the unsuffixed keychain slot",
 * which is a different account, not "no preference".
 */
export async function setEnvValue(name: string, value: string | undefined): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const existing = toEntries(config.inspect<unknown>(KEY)?.globalValue);

  const next = existing.filter((entry) => entry.name !== name);
  if (value !== undefined) {
    const previous = existing.find((entry) => entry.name === name);
    next.push(previous ? { ...previous, value } : { name, value });
  }

  // An empty array is still a meaningful "user has set this to nothing"; only
  // drop back to undefined when we never had a global value to begin with.
  const shouldClear = next.length === 0 && existing.length > 0 && value === undefined;
  await config.update(
    KEY,
    shouldClear ? undefined : next,
    vscode.ConfigurationTarget.Global,
  );
}

export async function setSlotDir(value: string | undefined): Promise<void> {
  await setEnvValue(ENV_SECURE_STORAGE_DIR, value);
}
