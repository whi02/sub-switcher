import type { ClaudeConfig } from "./claudeConfig";
import type { UtilizationSnapshot } from "./profiles";

/**
 * Read-only view of the quota numbers Claude Code caches for itself.
 *
 * We never call Anthropic's usage endpoint. Doing so for an account that is not
 * currently active would mean holding that account's token, which the Claude Code
 * terms forbid for third-party tooling. So the only numbers we can honestly show
 * are the ones Claude Code fetched while a given account was active -- which is
 * why every surface that displays them also displays how old they are.
 */

interface RawWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface RawUtilization {
  fetchedAtMs?: unknown;
  accountUuid?: unknown;
  utilization?: Record<string, RawWindow | null> | null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `new Date(n).toISOString()` throws RangeError for finite but out-of-range
 * values (anything beyond ±8.64e15 ms), and a corrupt or unit-mismatched
 * fetchedAtMs is exactly that. This is called on the switch path, where an
 * exception would abort the switch over a cosmetic timestamp.
 */
function msToIso(value: unknown): string | undefined {
  const ms = asNumber(value);
  if (ms === undefined) {
    return undefined;
  }
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** Pull the five-hour and seven-day windows out of `cachedUsageUtilization`. */
export function readUtilization(config: ClaudeConfig): UtilizationSnapshot | undefined {
  const raw = config["cachedUsageUtilization"] as RawUtilization | undefined;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const windows = raw.utilization ?? {};
  const fiveHour = windows["five_hour"] ?? undefined;
  const sevenDay = windows["seven_day"] ?? undefined;

  const snapshot: UtilizationSnapshot = {
    fiveHour: asNumber(fiveHour?.utilization),
    sevenDay: asNumber(sevenDay?.utilization),
    resetsAt: asString(sevenDay?.resets_at),
    fetchedAt: msToIso(raw.fetchedAtMs),
    accountUuid: asString(raw.accountUuid),
  };

  const hasAnything =
    snapshot.fiveHour !== undefined ||
    snapshot.sevenDay !== undefined ||
    snapshot.accountUuid !== undefined;

  return hasAnything ? snapshot : undefined;
}

/** The headline number for the status bar: whichever window is under more pressure. */
export function peakUtilization(snapshot: UtilizationSnapshot | undefined): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  const values = [snapshot.fiveHour, snapshot.sevenDay].filter(
    (v): v is number => v !== undefined,
  );
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** "3분 전" style relative age, so a stale number never reads as a live one. */
export function formatAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) {
    return "관측 기록 없음";
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "관측 기록 없음";
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) {
    return "방금 관측";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}분 전 관측`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}시간 전 관측`;
  }
  return `${Math.round(hours / 24)}일 전 관측`;
}

export function formatResetsAt(iso: string | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return undefined;
  }
  return at.toLocaleString();
}

/**
 * True when the cached numbers were fetched for a different account than the one
 * the profile represents -- i.e. the cache has not caught up with a switch yet.
 */
export function isCrossAccountStale(
  snapshot: UtilizationSnapshot | undefined,
  expectedAccountUuid: string | undefined,
): boolean {
  if (!snapshot?.accountUuid || !expectedAccountUuid) {
    return false;
  }
  return snapshot.accountUuid !== expectedAccountUuid;
}
