import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { extractAccountState, type OAuthAccount } from "./claudeConfig";
import { home, normalizeSlotDir } from "./paths";
import {
  loadProfiles,
  makeProfileId,
  saveProfiles,
  type Profile,
  type ProfilesState,
} from "./profiles";
import { readUtilization } from "./usage";

/**
 * Discovering and registering credential slots.
 *
 * A "slot" is just a directory path. Its only job is to hash to a keychain entry
 * name, so an empty directory is perfectly valid -- the token that matters was
 * put there by Claude Code's own `/login` and stays in the keychain. That is why
 * adding an account here never asks for a password.
 */

const CANDIDATE_PATTERN = /^\.claude[-_].+/;

export interface Candidate {
  dir: string;
  /** Identity we could read from the slot's own .claude.json, when it has one. */
  oauthAccount?: OAuthAccount;
  accountCaches?: Record<string, unknown>;
  utilization?: Profile["lastSeenUtilization"];
}

/**
 * Look for directories that already act as alternate config dirs, e.g. the
 * `~/.claude-pro2` a `CLAUDE_CONFIG_DIR=... claude` shell alias would have made.
 * Each one's own .claude.json tells us which account signed in there.
 */
export async function discoverCandidates(): Promise<Candidate[]> {
  const root = home();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const candidates: Candidate[] = [];
  for (const name of entries) {
    if (!CANDIDATE_PATTERN.test(name)) {
      continue;
    }
    const dir = path.join(root, name);
    try {
      if (!(await fs.stat(dir)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const candidate: Candidate = { dir: normalizeSlotDir(dir) };
    try {
      const raw = await fs.readFile(path.join(dir, ".claude.json"), "utf8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const { oauthAccount, caches } = extractAccountState(config);
      candidate.oauthAccount = oauthAccount;
      candidate.accountCaches = caches;
      candidate.utilization = readUtilization(config);
    } catch {
      // A slot without its own config is still usable; we just cannot name the account.
    }
    candidates.push(candidate);
  }
  return candidates;
}

function labelFor(candidate: Candidate): string {
  const base = path.basename(candidate.dir).replace(/^\.claude[-_]/, "");
  return base || path.basename(candidate.dir);
}

export function candidateToProfile(state: ProfilesState, candidate: Candidate): Profile {
  const label = labelFor(candidate);
  const profile: Profile = {
    id: makeProfileId(state, label),
    label,
    secureStorageDir: candidate.dir,
  };
  if (candidate.oauthAccount) {
    profile.oauthAccount = candidate.oauthAccount;
  }
  if (candidate.accountCaches) {
    profile.accountCaches = candidate.accountCaches;
  }
  if (candidate.utilization) {
    profile.lastSeenUtilization = candidate.utilization;
  }
  return profile;
}

/** Interactive first-run: pick which discovered slots to register. */
export async function runSetup(): Promise<ProfilesState | undefined> {
  const state = await loadProfiles();
  const candidates = await discoverCandidates();

  const known = new Set(state.profiles.map((p) => normalizeSlotDir(p.secureStorageDir)));
  const fresh = candidates.filter((c) => !known.has(c.dir));

  if (fresh.length === 0) {
    const action = await vscode.window.showInformationMessage(
      state.profiles.length > 0
        ? "새로 발견된 계정 슬롯이 없습니다. 이미 등록된 슬롯만 있습니다."
        : "~/.claude-* 형태의 계정 디렉토리를 찾지 못했습니다. 슬롯을 직접 추가할 수 있습니다.",
      "슬롯 직접 추가",
      "닫기",
    );
    if (action === "슬롯 직접 추가") {
      return addAccountInteractive();
    }
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    fresh.map((candidate) => ({
      label: labelFor(candidate),
      description: candidate.oauthAccount?.emailAddress ?? "계정 미확인",
      detail: candidate.dir,
      picked: true,
      candidate,
    })),
    {
      canPickMany: true,
      title: "등록할 계정 슬롯 선택",
      placeHolder: "각 슬롯은 이미 로그인된 키체인 항목을 가리킵니다 — 재로그인 불필요",
    },
  );

  if (!picked || picked.length === 0) {
    return undefined;
  }

  for (const item of picked) {
    state.profiles.push(candidateToProfile(state, item.candidate));
  }
  await saveProfiles(state);
  return state;
}

/** Register a slot by path, for accounts that do not have a ~/.claude-* directory yet. */
export async function addAccountInteractive(): Promise<ProfilesState | undefined> {
  const state = await loadProfiles();

  const label = await vscode.window.showInputBox({
    title: "계정 슬롯 이름",
    prompt: "상태바와 피커에 표시될 이름입니다.",
    placeHolder: "예: pro2",
    validateInput: (value) => (value.trim().length === 0 ? "이름을 입력하세요." : undefined),
  });
  if (!label) {
    return undefined;
  }

  const defaultDir = path.join(home(), `.claude-${label.trim().toLowerCase()}`);
  const dirInput = await vscode.window.showInputBox({
    title: "자격증명 슬롯 디렉토리",
    prompt:
      "이 경로가 키체인 항목 이름을 결정합니다. 비어 있어도 되며, 토큰은 여기 저장되지 않습니다.",
    value: defaultDir,
    validateInput: (value) =>
      value.trim().length === 0 ? "경로를 입력하세요." : undefined,
  });
  if (!dirInput) {
    return undefined;
  }

  const dir = normalizeSlotDir(dirInput.trim());
  if (state.profiles.some((p) => normalizeSlotDir(p.secureStorageDir) === dir)) {
    vscode.window.showWarningMessage(`이미 등록된 슬롯입니다: ${dir}`);
    return undefined;
  }

  await fs.mkdir(dir, { recursive: true });

  state.profiles.push({
    id: makeProfileId(state, label.trim()),
    label: label.trim(),
    secureStorageDir: dir,
  });
  await saveProfiles(state);

  vscode.window.showInformationMessage(
    `슬롯 "${label.trim()}"을 등록했습니다. 이 계정으로 아직 로그인한 적이 없다면, ` +
      "이 슬롯으로 전환한 뒤 Claude Code에서 /login 을 실행하세요.",
  );
  return state;
}
