import type { OAuthAccount } from "./claudeConfig";
import { readJson, writeJsonAtomic } from "./fsAtomic";
import { normalizeSlotDir, profilesFile } from "./paths";

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
  /**
   * The account-scoped slice of ~/.claude.json as it was before this extension
   * first touched it, so Reset can put it back instead of leaving whichever
   * account was switched to last advertised in a shared config.
   */
  preInstallAccount?: { oauthAccount?: OAuthAccount; caches?: Record<string, unknown> };
}

export function emptyState(): ProfilesState {
  return { version: PROFILES_VERSION, profiles: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one entry from disk.
 *
 * profiles.json is a path the doctor report points users at, so hand edits are
 * expected. A missing `secureStorageDir` used to reach normalizeSlotDir and
 * throw a TypeError out of the status bar refresh, which rejects activate() and
 * leaves the extension with no UI at all -- so malformed entries are dropped
 * rather than trusted.
 */
function parseProfile(value: unknown): Profile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, label, secureStorageDir } = value;
  if (typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  if (typeof secureStorageDir !== "string" || secureStorageDir.length === 0) {
    return undefined;
  }

  const profile: Profile = {
    id,
    label: typeof label === "string" && label.length > 0 ? label : id,
    secureStorageDir,
  };
  if (isRecord(value["oauthAccount"])) {
    profile.oauthAccount = value["oauthAccount"] as OAuthAccount;
  }
  if (isRecord(value["accountCaches"])) {
    profile.accountCaches = value["accountCaches"];
  }
  if (isRecord(value["lastSeenUtilization"])) {
    profile.lastSeenUtilization = value["lastSeenUtilization"] as UtilizationSnapshot;
  }
  return profile;
}

export async function loadProfiles(): Promise<ProfilesState> {
  let parsed: unknown;
  try {
    parsed = await readJson(profilesFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }

  if (!isRecord(parsed)) {
    throw new Error(`${profilesFile()} did not contain a JSON object`);
  }

  // A newer file means a schema this build does not know how to read. Failing
  // loudly beats silently reinterpreting it as v1 and writing that back.
  const version = typeof parsed["version"] === "number" ? parsed["version"] : PROFILES_VERSION;
  if (version > PROFILES_VERSION) {
    throw new Error(
      `${profilesFile()} was written by a newer version (v${version}; this build reads v${PROFILES_VERSION}). ` +
        "Update the extension.",
    );
  }

  const rawProfiles = Array.isArray(parsed["profiles"]) ? parsed["profiles"] : [];
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  for (const raw of rawProfiles) {
    const profile = parseProfile(raw);
    if (profile && !seen.has(profile.id)) {
      seen.add(profile.id);
      profiles.push(profile);
    }
  }

  const state: ProfilesState = { version: PROFILES_VERSION, profiles };
  const activeId = parsed["activeId"];
  if (typeof activeId === "string" && seen.has(activeId)) {
    state.activeId = activeId;
  }
  if (isRecord(parsed["preInstallAccount"])) {
    state.preInstallAccount = parsed["preInstallAccount"] as ProfilesState["preInstallAccount"];
  }
  return state;
}

export async function saveProfiles(state: ProfilesState): Promise<void> {
  await writeJsonAtomic(profilesFile(), { ...state, version: PROFILES_VERSION });
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
