import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { writeJsonAtomic } from "./fsAtomic";
import { codexProfilesFile, defaultCodexHome, ENV_CODEX_HOME, expandHome, home } from "./paths";

/**
 * Codex account slots.
 *
 * Codex has no counterpart to CLAUDE_SECURESTORAGE_CONFIG_DIR: its sign-in, in
 * every storage mode, is keyed off CODEX_HOME, and so are its config, sessions
 * and memories. A slot is therefore a whole CODEX_HOME, and switching accounts
 * also switches history. Nothing here opens what Codex stores inside a slot.
 */

export const CODEX_STATE_VERSION = 1;

export interface CodexProfile {
  id: string;
  label: string;
  codexHome: string;
}

export interface CodexState {
  version: number;
  activeId?: string;
  profiles: CodexProfile[];
}

const CANDIDATE_PATTERN = /^\.codex[-_].+/;

export function normalizeCodexHome(p: string): string {
  return path.resolve(expandHome(p));
}

export function isDefaultCodexHome(p: string): boolean {
  return normalizeCodexHome(p) === defaultCodexHome();
}

export function effectiveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[ENV_CODEX_HOME];
  return value ? normalizeCodexHome(value) : defaultCodexHome();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Synchronous so activation can apply the slot before any other extension runs.
export function loadCodexState(): CodexState {
  const file = codexProfilesFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: CODEX_STATE_VERSION, profiles: [] };
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${file} did not contain a JSON object`);
  }
  const version = typeof parsed["version"] === "number" ? parsed["version"] : CODEX_STATE_VERSION;
  if (version > CODEX_STATE_VERSION) {
    throw new Error(
      `${file} was written by a newer version (v${version}; this build reads v${CODEX_STATE_VERSION}). ` +
        "Update the extension.",
    );
  }

  const profiles: CodexProfile[] = [];
  const seen = new Set<string>();
  const rawProfiles = Array.isArray(parsed["profiles"]) ? parsed["profiles"] : [];
  for (const entry of rawProfiles) {
    if (!isRecord(entry)) {
      continue;
    }
    const { id, label, codexHome } = entry;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      continue;
    }
    if (typeof codexHome !== "string" || codexHome.length === 0) {
      continue;
    }
    seen.add(id);
    profiles.push({
      id,
      label: typeof label === "string" && label.length > 0 ? label : id,
      codexHome,
    });
  }

  const state: CodexState = { version: CODEX_STATE_VERSION, profiles };
  const activeId = parsed["activeId"];
  if (typeof activeId === "string" && seen.has(activeId)) {
    state.activeId = activeId;
  }
  return state;
}

export async function saveCodexState(state: CodexState): Promise<void> {
  await writeJsonAtomic(codexProfilesFile(), { ...state, version: CODEX_STATE_VERSION });
}

export function findCodexProfile(state: CodexState, id: string | undefined): CodexProfile | undefined {
  return id ? state.profiles.find((p) => p.id === id) : undefined;
}

export function codexProfileForHome(state: CodexState, dir: string): CodexProfile | undefined {
  const target = normalizeCodexHome(dir);
  return state.profiles.find((p) => normalizeCodexHome(p.codexHome) === target);
}

/**
 * Put the saved slot into this extension host's environment, which the Codex
 * extension's app-server inherits when it starts. Returns the applied profile,
 * or undefined when no slot is selected and the environment is left alone.
 */
export function applyActiveCodexHome(
  state: CodexState,
  env: NodeJS.ProcessEnv = process.env,
): CodexProfile | undefined {
  const active = findCodexProfile(state, state.activeId);
  if (!active) {
    return undefined;
  }
  if (isDefaultCodexHome(active.codexHome)) {
    delete env[ENV_CODEX_HOME];
    return active;
  }
  const dir = normalizeCodexHome(active.codexHome);
  // Codex refuses to start when CODEX_HOME names a missing directory.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  env[ENV_CODEX_HOME] = dir;
  return active;
}

/** Record the choice for the next activation; the running app-server keeps its account. */
export async function selectCodexProfile(id: string): Promise<CodexProfile> {
  const state = loadCodexState();
  const target = findCodexProfile(state, id);
  if (!target) {
    throw new Error(`Unknown Codex account slot: ${id}`);
  }
  await fsp.mkdir(normalizeCodexHome(target.codexHome), { recursive: true, mode: 0o700 });
  state.activeId = target.id;
  await saveCodexState(state);
  return target;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** ~/.codex first when it exists, then any ~/.codex-* or ~/.codex_* directories. */
export async function discoverCodexHomes(): Promise<string[]> {
  const found: string[] = [];
  if (await isDirectory(defaultCodexHome())) {
    found.push(defaultCodexHome());
  }
  let names: string[];
  try {
    names = await fsp.readdir(home());
  } catch {
    return found;
  }
  for (const name of names.sort()) {
    if (!CANDIDATE_PATTERN.test(name)) {
      continue;
    }
    const dir = path.join(home(), name);
    if (await isDirectory(dir)) {
      found.push(dir);
    }
  }
  return found;
}

export function codexLabelFor(dir: string): string {
  if (isDefaultCodexHome(dir)) {
    return "기본";
  }
  const base = path.basename(dir);
  return base.replace(/^\.codex[-_]/, "") || base;
}
