import * as os from "node:os";
import * as path from "node:path";

/**
 * Path helpers mirroring how the Claude Code CLI resolves its own locations.
 *
 * Derived by reading (never modifying) the published extension bundle. Two
 * things matter and they are NOT the same directory:
 *
 *   data dir    = CLAUDE_CONFIG_DIR ?? ~/.claude
 *   config file = join(CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json")
 *                 (unless join(dataDir, ".config.json") exists, which wins)
 *
 * So setting CLAUDE_CONFIG_DIR=~/.claude is *not* a no-op: it moves the config
 * file from ~/.claude.json to ~/.claude/.claude.json. We therefore never set
 * CLAUDE_CONFIG_DIR ourselves and leave both at their defaults, which is what
 * makes history, memory, CLAUDE.md, settings and plugins shared across accounts.
 */

export const ENV_SECURE_STORAGE_DIR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
export const ENV_CONFIG_DIR = "CLAUDE_CONFIG_DIR";

export function home(): string {
  return os.homedir();
}

/** The shared Claude Code data directory: projects/, memory/, plugins/, CLAUDE.md. */
export function claudeDataDir(): string {
  return path.join(home(), ".claude");
}

/** The shared Claude Code config file. Account caches live in here. */
export function claudeConfigFile(): string {
  return path.join(home(), ".claude.json");
}

/** Preferred config path if the newer layout is in use. */
export function claudeAltConfigFile(): string {
  return path.join(claudeDataDir(), ".config.json");
}

/**
 * The shared Claude Code user settings file. Keys like `remoteControlAtStartup`
 * live here, and because we never move CLAUDE_CONFIG_DIR it is one file both
 * accounts read.
 */
export function claudeSettingsFile(): string {
  return path.join(claudeDataDir(), "settings.json");
}

/** Our own state directory. Holds profiles.json and .claude.json backups. Never secrets. */
export function stateDir(): string {
  return path.join(home(), ".claude-accounts");
}

export function profilesFile(): string {
  return path.join(stateDir(), "profiles.json");
}

export function backupsDir(): string {
  return path.join(stateDir(), "backups");
}

export const ENV_CODEX_HOME = "CODEX_HOME";

/** Where Codex keeps config, sessions and sign-in when CODEX_HOME is unset. */
export function defaultCodexHome(): string {
  return path.join(home(), ".codex");
}

export function codexProfilesFile(): string {
  return path.join(stateDir(), "codex-profiles.json");
}

/** Expand a leading ~ so profiles.json stays readable while env values stay absolute. */
export function expandHome(p: string): string {
  if (p === "~") {
    return home();
  }
  if (p.startsWith("~/")) {
    return path.join(home(), p.slice(2));
  }
  return p;
}

/**
 * The absolute, NFC-normalised form the CLI hashes to pick a credential slot.
 * Must match exactly or the CLI looks in a different keychain entry.
 */
export function normalizeSlotDir(p: string): string {
  return path.resolve(expandHome(p)).normalize("NFC");
}
