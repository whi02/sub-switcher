import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Atomic JSON writes, shared by the two files this extension owns or edits.
 *
 * Both ~/.claude.json and profiles.json were being written by near-identical
 * copies of this routine, neither of which fsynced. Without the fsync, rename()
 * can land before the data does, so a crash or power loss leaves a
 * correctly-named but empty or truncated file -- which for ~/.claude.json means
 * the user loses their per-project Claude Code state.
 */

export async function writeJsonAtomic(
  destination: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(destination);
  const tmp = path.join(dir, `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}`);
  const body = `${JSON.stringify(value, null, 2)}\n`;

  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(body, "utf8");
    // Force the bytes out before the rename makes the name point at them.
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tmp, destination);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readJson<T>(source: string): Promise<T> {
  const raw = await fs.readFile(source, "utf8");
  return JSON.parse(raw) as T;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
