import {
  commitAccountState,
  extractAccountState,
  readConfig,
  restoreConfig,
  type AccountState,
} from "./claudeConfig";
import { getConfiguredSlotDir, setSlotDir } from "./envSettings";
import { normalizeSlotDir } from "./paths";
import {
  activeProfile,
  loadProfiles,
  profileForSlotDir,
  saveProfiles,
  type Profile,
  type ProfilesState,
} from "./profiles";
import { readUtilization } from "./usage";

/**
 * The switch itself.
 *
 * All it changes is which keychain slot the official extension points at, plus
 * the account-scoped caches in ~/.claude.json so the UI does not show the
 * previous account's email and quota. Credentials are never read, copied or
 * moved -- each account signs in once through Claude Code's own `/login` and its
 * token stays where Claude Code put it.
 */

export interface SwitchResult {
  from?: Profile;
  to: Profile;
  backupPath?: string;
}

/**
 * Capture what ~/.claude.json currently says about the active account, so the
 * numbers survive a round trip through another account.
 *
 * Returns true only when something actually changed. The caller runs this on a
 * 60-second timer, and returning true unconditionally meant a full parse of
 * ~/.claude.json plus a rewrite of profiles.json every minute forever, against
 * a file nobody had read.
 */
export async function captureActiveState(state: ProfilesState): Promise<boolean> {
  const active = resolveActiveProfile(state);
  if (!active) {
    return false;
  }

  let config;
  try {
    ({ config } = await readConfig());
  } catch {
    return false;
  }

  let changed = false;
  const { oauthAccount, caches } = extractAccountState(config);

  // A config whose identity belongs to some other account would poison the
  // snapshot, so only record what matches (or what we have no way to contradict).
  const expectedUuid = active.oauthAccount?.accountUuid;
  const observedUuid = oauthAccount?.accountUuid;
  if (expectedUuid && observedUuid && expectedUuid !== observedUuid) {
    return changed;
  }

  if (oauthAccount && !deepEqual(active.oauthAccount, oauthAccount)) {
    active.oauthAccount = oauthAccount;
    changed = true;
  }
  if (!deepEqual(active.accountCaches, caches)) {
    active.accountCaches = caches;
    changed = true;
  }

  const utilization = readUtilization(config);
  if (utilization && !deepEqual(active.lastSeenUtilization, utilization)) {
    active.lastSeenUtilization = utilization;
    changed = true;
  }
  return changed;
}

/**
 * Record what the shared config said about the account before this extension
 * ever changed it, so Reset can put that back.
 *
 * This cannot live inside captureActiveState: on the very first switch no
 * profile is active yet, so that function returns early and the snapshot would
 * only be taken on the *second* switch -- by which point it captures an account
 * we already switched to, and Reset restores the wrong identity.
 *
 * Returns true when it recorded something.
 */
export async function rememberPreInstallAccount(state: ProfilesState): Promise<boolean> {
  if (state.preInstallAccount) {
    return false;
  }
  try {
    const { config } = await readConfig();
    const { oauthAccount, caches } = extractAccountState(config);
    state.preInstallAccount = { oauthAccount, caches };
    return true;
  } catch {
    return false;
  }
}

/** Structural comparison via canonical JSON; these values come from JSON anyway. */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Which profile is live right now, and why.
 *
 * The environment setting is the source of truth, not `activeId` -- the user can
 * edit settings.json by hand, and a stale `activeId` would make us write one
 * account's caches while a different account's token is in use.
 */
export type ActiveResolution =
  | { kind: "profile"; profile: Profile }
  /** No slot configured: Claude Code uses the unsuffixed keychain entry. */
  | { kind: "unconfigured" }
  /** A slot is configured but matches no registered profile. */
  | { kind: "unknown-slot"; slotDir: string };

export function resolveActive(state: ProfilesState): ActiveResolution {
  const slotDir = getConfiguredSlotDir();
  if (slotDir === undefined) {
    const fallback = activeProfile(state);
    return fallback ? { kind: "profile", profile: fallback } : { kind: "unconfigured" };
  }
  const matched = profileForSlotDir(state, slotDir);
  return matched ? { kind: "profile", profile: matched } : { kind: "unknown-slot", slotDir };
}

export function resolveActiveProfile(state: ProfilesState): Profile | undefined {
  const resolution = resolveActive(state);
  return resolution.kind === "profile" ? resolution.profile : undefined;
}

export async function switchTo(profileId: string): Promise<SwitchResult> {
  const state = await loadProfiles();
  const target = state.profiles.find((p) => p.id === profileId);
  if (!target) {
    throw new Error(`Unknown account slot: ${profileId}`);
  }

  const from = resolveActiveProfile(state);
  if (from?.id === target.id) {
    return { from, to: target };
  }

  // 1. Preserve the pre-install identity before anything is modified, then
  //    freshen the outgoing profile's snapshot while its numbers are still live.
  let dirty = await rememberPreInstallAccount(state);
  dirty = (await captureActiveState(state)) || dirty;
  if (dirty) {
    await saveProfiles(state);
  }

  // 2. Swap the account-scoped slice of ~/.claude.json. commitAccountState
  //    restores its own backup if it cannot land the change, so a throw here
  //    genuinely means the config is untouched.
  const { backupPath, configPath } = await commitAccountState({
    oauthAccount: target.oauthAccount,
    caches: target.accountCaches,
  });

  // 3. Point the official extension at the target account's credential slot.
  try {
    await setSlotDir(normalizeSlotDir(target.secureStorageDir));
  } catch (err) {
    // Undo step 2, or the config would advertise an account whose token is not in use.
    await restoreConfig(backupPath, configPath).catch(() => undefined);
    throw new Error(`Failed to write the Claude Code environment setting: ${describeError(err)}`);
  }

  // 4. Record the new active profile.
  state.activeId = target.id;
  await saveProfiles(state);

  return { from, to: target, backupPath };
}

/**
 * Remove our environment entry so Claude Code returns to its pre-install
 * behaviour -- which means the unsuffixed keychain entry, a different account
 * from whichever slot was last selected. The account-scoped slice of
 * ~/.claude.json has to go back with it, or the UI would keep showing the last
 * switched-to account while a different token is in use: exactly the mismatch
 * this extension exists to prevent.
 */
export async function resetToDefaults(): Promise<void> {
  const state = await loadProfiles();
  let dirty = await rememberPreInstallAccount(state);
  dirty = (await captureActiveState(state)) || dirty;
  if (dirty) {
    await saveProfiles(state);
  }

  // Fall back to clearing the managed keys when we never recorded a pre-install
  // slice; Claude Code repopulates them from its next response.
  const restoreTo: AccountState = state.preInstallAccount ?? {};
  await commitAccountState(restoreTo);

  state.activeId = undefined;
  await saveProfiles(state);
  await setSlotDir(undefined);
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
