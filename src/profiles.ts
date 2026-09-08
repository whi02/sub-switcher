import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OAuthAccount } from "./claudeConfig";
import { normalizeSlotDir, profilesFile, stateDir } from "./paths";

/**
 * Our own state: which credential slots exist and which one is active.
 *
 * IMPORTANT: this file must never hold tokens. It holds directory paths that
 * *name* a keychain slot, plus identity metadata and cached quota numbers we
 * observed in Claude Code's own config. Sign-in always happens through
 * Claude Code's `/login`, never through us.
 */

export const PROFILES_VERSION = 1;

export interface UtilizationSnapshot {
  /** Percent (0-100) of the five-hour window consumed when we last looked. */
  fiveHour?: number;
  /** Percent (0-100) of the seven-day window consumed when we last looked. */
  sevenDay?: number;
  /** ISO timestamp the seven-day window resets, when Claude Code recorded one. */
  resetsAt?: string;
  /** ISO timestamp of when Claude Code fetched these numbers (not when we read them). */
  fetchedAt?: string;
  /** Account the numbers belong to, so we can detect a stale cross-account cache. */
  accountUuid?: string;
}

export interface Profile {
  /** Stable slug used in settings and command arguments. */
  id: string;
  /** What the user sees in the picker and status bar. */
  label: string;
  /**
   * Absolute directory whose SHA-256 prefix selects the keychain entry
   * `Claude Code-credentials-<sha256(dir).slice(0,8)>`.
   */
  secureStorageDir: string;
  /** Identity metadata observed while this profile was active. Not a secret. */
  oauthAccount?: OAuthAccount;
  /** Account-scoped cache keys observed while this profile was active. */
  accountCaches?: Record<string, unknown>;
  lastSeenUtilization?: UtilizationSnapshot;
}

export interface ProfilesState {
  version: number;
  activeId?: string;
  profiles: Profile[];
}

export function emptyState(): ProfilesState {
  return { version: PROFILES_VERSION, profiles: [] };
}

export async function loadProfiles(): Promise<ProfilesState> {
  let raw: string;
  try {
    raw = await fs.readFile(profilesFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${profilesFile()} did not contain a JSON object`);
  }

  const state = parsed as Partial<ProfilesState>;
  return {
    version: typeof state.version === "number" ? state.version : PROFILES_VERSION,
    activeId: typeof state.activeId === "string" ? state.activeId : undefined,
    profiles: Array.isArray(state.profiles) ? state.profiles : [],
  };
}

export async function saveProfiles(state: ProfilesState): Promise<void> {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const dest = profilesFile();
  const tmp = path.join(dir, `.profiles.json.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function findProfile(state: ProfilesState, id: string | undefined): Profile | undefined {
  if (!id) {
    return undefined;
  }
  return state.profiles.find((p) => p.id === id);
}

export function activeProfile(state: ProfilesState): Profile | undefined {
  return findProfile(state, state.activeId);
}

/** Match a profile by the credential slot currently configured in the environment. */
export function profileForSlotDir(
  state: ProfilesState,
  slotDir: string | undefined,
): Profile | undefined {
  if (!slotDir) {
    return undefined;
  }
  const normalized = normalizeSlotDir(slotDir);
  return state.profiles.find((p) => normalizeSlotDir(p.secureStorageDir) === normalized);
}

/** Turn a free-form label into a slug that is unique within the state. */
export function makeProfileId(state: ProfilesState, desired: string): string {
  const base =
    desired
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "account";

  if (!state.profiles.some((p) => p.id === base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!state.profiles.some((p) => p.id === candidate)) {
      return candidate;
    }
  }
}

export function describeProfile(profile: Profile): string {
  const email = profile.oauthAccount?.emailAddress;
  return email ? `${profile.label} (${email})` : profile.label;
}
