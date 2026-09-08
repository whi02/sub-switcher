import {
  applyAccountState,
  backupConfig,
  extractAccountState,
  readConfig,
  restoreConfig,
  writeConfig,
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
 * Called before every switch and periodically while idle. It is a no-op when we
 * cannot tell which profile the config belongs to.
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

  const { oauthAccount, caches } = extractAccountState(config);

  // A config whose identity belongs to some other account would poison the
  // snapshot, so only record what matches (or what we have no way to contradict).
  const expectedUuid = active.oauthAccount?.accountUuid;
  const observedUuid = oauthAccount?.accountUuid;
  if (expectedUuid && observedUuid && expectedUuid !== observedUuid) {
    return false;
  }

  if (oauthAccount) {
    active.oauthAccount = oauthAccount;
  }
  active.accountCaches = caches;

  const utilization = readUtilization(config);
  if (utilization) {
    active.lastSeenUtilization = utilization;
  }
  return true;
}

/**
 * Which profile is live right now.
 *
 * The environment setting is the source of truth, not `activeId` -- the user can
 * edit settings.json by hand, and a stale `activeId` would make us write one
 * account's caches while a different account's token is in use.
 */
export function resolveActiveProfile(state: ProfilesState): Profile | undefined {
  const bySlot = profileForSlotDir(state, getConfiguredSlotDir());
  if (bySlot) {
    return bySlot;
  }
  // No slot configured means the unsuffixed keychain entry, i.e. whichever
  // account was signed in before this extension existed. Fall back to activeId
  // only when it does not contradict an explicitly configured slot.
  return getConfiguredSlotDir() === undefined ? activeProfile(state) : undefined;
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

  // 1. Freshen the outgoing profile's snapshot while its numbers are still live.
  await captureActiveState(state);

  // 2. Swap the account-scoped slice of ~/.claude.json, with a backup to roll back to.
  let backupPath: string | undefined;
  let configPath: string | undefined;
  try {
    const { path, config } = await readConfig();
    configPath = path;
    backupPath = await backupConfig(path);
    const next = applyAccountState(config, {
      oauthAccount: target.oauthAccount,
      caches: target.accountCaches,
    });
    await writeConfig(path, next);
  } catch (err) {
    // Nothing has changed yet apart from a possible backup; surface and stop.
    throw new Error(
      `Failed to update Claude Code's config before switching: ${describeError(err)}`,
    );
  }

  // 3. Point the official extension at the target account's credential slot.
  try {
    await setSlotDir(normalizeSlotDir(target.secureStorageDir));
  } catch (err) {
    if (backupPath && configPath) {
      await restoreConfig(backupPath, configPath).catch(() => undefined);
    }
    throw new Error(`Failed to write the Claude Code environment setting: ${describeError(err)}`);
  }

  // 4. Record the new active profile.
  state.activeId = target.id;
  await saveProfiles(state);

  return { from, to: target, backupPath };
}

/** Remove our environment entry so Claude Code returns to its pre-install behaviour. */
export async function resetToDefaults(): Promise<void> {
  const state = await loadProfiles();
  await captureActiveState(state);
  state.activeId = undefined;
  await saveProfiles(state);
  await setSlotDir(undefined);
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
