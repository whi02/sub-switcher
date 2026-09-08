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
 *
 * Its `scope` is "machine", so it can only be written at the global target.
 */

const SECTION = "claudeCode";
const KEY = "environmentVariables";

export interface EnvEntry {
  name: string;
  value: string;
}

function readEntries(): EnvEntry[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const { name, value } = item as Partial<EnvEntry>;
    return typeof name === "string" ? [{ name, value: typeof value === "string" ? value : "" }] : [];
  });
}

export function getEnvValue(name: string): string | undefined {
  return readEntries().find((entry) => entry.name === name)?.value;
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
 * Set or clear one variable, preserving every other entry the user has added.
 * Passing `undefined` removes the entry entirely rather than setting it empty --
 * an empty CLAUDE_SECURESTORAGE_CONFIG_DIR means "the unsuffixed keychain slot",
 * which is a different account, not "no preference".
 */
export async function setEnvValue(name: string, value: string | undefined): Promise<void> {
  const entries = readEntries().filter((entry) => entry.name !== name);
  if (value !== undefined) {
    entries.push({ name, value });
  }
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(KEY, entries, vscode.ConfigurationTarget.Global);
}

export async function setSlotDir(value: string | undefined): Promise<void> {
  await setEnvValue(ENV_SECURE_STORAGE_DIR, value);
}
