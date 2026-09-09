import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathExists, readJson, writeJsonAtomic } from "./fsAtomic";
import { claudeSettingsFile } from "./paths";

/**
 * Remote Control awareness.
 *
 * Remote Control (the claude.ai/code bridge, `claude remote-control`, the
 * in-session toggle) binds a conversation to the account that started it: the
 * cloud session is owned server-side, so resuming it under a different account
 * cannot revive that bridge -- the native binary reports `account_mismatch` and
 * the session stays with its owner.
 *
 * When Remote Control starts automatically for every session -- which a
 * server-side default currently does for this user, visible as `bridge-session`
 * records in every transcript -- every conversation becomes account-bound, and
 * work started on one subscription cannot be continued on the other. Setting
 * `remoteControlAtStartup: false` in the shared user settings makes new
 * conversations plain local sessions, which resume under either account. Remote
 * Control can still be switched on by hand for a specific session.
 *
 * This module only ever reads and writes that one boolean key, merged into the
 * existing settings file. It never touches credentials or the bridge itself.
 */

export const REMOTE_CONTROL_KEY = "remoteControlAtStartup";

export interface RemoteControlState {
  /** The explicit value in ~/.claude/settings.json, or undefined when absent. */
  configured: boolean | undefined;
  /**
   * True when new conversations are account-bound: either explicitly on, or
   * left to the server default (which we cannot read, but which is on whenever
   * the key is unset -- the safe assumption for the resume warning).
   */
  bindsNewConversations: boolean;
  settingsPath: string;
}

export async function readRemoteControlState(): Promise<RemoteControlState> {
  const settingsPath = claudeSettingsFile();
  let configured: boolean | undefined;
  try {
    const settings = await readJson<Record<string, unknown>>(settingsPath);
    const value = settings[REMOTE_CONTROL_KEY];
    configured = typeof value === "boolean" ? value : undefined;
  } catch {
    configured = undefined;
  }
  return {
    configured,
    bindsNewConversations: configured !== false,
    settingsPath,
  };
}

/**
 * Set `remoteControlAtStartup` in the shared user settings, preserving every
 * other key and the file's order. settings.json is world-readable by
 * convention, so keep that mode rather than tightening it.
 */
export async function setRemoteControlAtStartup(value: boolean): Promise<void> {
  const settingsPath = claudeSettingsFile();
  let settings: Record<string, unknown> = {};

  if (await pathExists(settingsPath)) {
    try {
      settings = await readJson<Record<string, unknown>>(settingsPath);
    } catch {
      throw new Error(
        `${settingsPath} is not valid JSON. Fix it by hand before changing Remote Control from here.`,
      );
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      throw new Error(`${settingsPath} does not contain a JSON object.`);
    }
  } else {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  }

  settings[REMOTE_CONTROL_KEY] = value;
  await writeJsonAtomic(settingsPath, settings, 0o644);
}
