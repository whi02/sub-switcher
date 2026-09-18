import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { readConfig, resolveConfigPath } from "./claudeConfig";
import {
  codexProfileForHome,
  effectiveCodexHome,
  findCodexProfile,
  loadCodexState,
  normalizeCodexHome,
  type CodexState,
} from "./codex";
import { pathExists } from "./fsAtomic";
import { getConfiguredConfigDir, getConfiguredSlotDir } from "./envSettings";
import {
  claudeDataDir,
  claudeConfigFile,
  codexProfilesFile,
  normalizeSlotDir,
  profilesFile,
} from "./paths";
import { loadProfiles } from "./profiles";
import { readRemoteControlState } from "./remoteControl";
import { resolveActiveProfile } from "./switcher";
import { readUtilization } from "./usage";

/**
 * A read-only health report.
 *
 * Note what it does NOT do: it never opens the keychain. It reports the service
 * name a slot *would* resolve to so the user can check it themselves with
 * `security find-generic-password -s "<name>"`, but reading credentials is not
 * something this extension is allowed to do.
 */

export type Level = "ok" | "warn" | "error" | "info";

export interface Finding {
  level: Level;
  title: string;
  detail?: string;
}

/**
 * Mirrors the CLI's own derivation:
 *   service = "Claude Code-credentials" + "-" + sha256(dir).hex.slice(0, 8)
 * where `dir` is the NFC-normalised absolute CLAUDE_SECURESTORAGE_CONFIG_DIR.
 */
export function keychainServiceName(slotDir: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(normalizeSlotDir(slotDir))
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

export async function runDoctor(): Promise<Finding[]> {
  const findings: Finding[] = [];

  // --- Shared data directory -------------------------------------------------
  const dataDir = claudeDataDir();
  const dataDirExists = await pathExists(dataDir);
  findings.push({
    level: dataDirExists ? "ok" : "error",
    title: dataDirExists ? "공유 데이터 디렉토리" : "공유 데이터 디렉토리 없음",
    detail: dataDir,
  });

  const configPath = await resolveConfigPath();
  const configExists = await pathExists(configPath);
  findings.push({
    level: configExists ? "ok" : "error",
    title: configExists ? "공유 설정 파일" : "공유 설정 파일 없음",
    detail: configPath,
  });

  // --- The setting that would break sharing ---------------------------------
  const pinnedConfigDir = getConfiguredConfigDir();
  if (pinnedConfigDir === undefined) {
    findings.push({
      level: "ok",
      title: "CLAUDE_CONFIG_DIR 미설정",
      detail: `기본값 사용 — 데이터 ${dataDir}, 설정 ${claudeConfigFile()}`,
    });
  } else {
    findings.push({
      level: "warn",
      title: "CLAUDE_CONFIG_DIR가 설정되어 있습니다",
      detail:
        `현재 값: ${pinnedConfigDir}\n` +
        "이 값이 설정되면 설정 파일 경로가 ~/.claude.json 에서 " +
        "<CLAUDE_CONFIG_DIR>/.claude.json 로 바뀌고, 계정 간 히스토리·메모리 공유가 깨집니다. " +
        "claudeCode.environmentVariables 에서 이 항목을 제거하는 것을 권장합니다.",
    });
  }

  // --- Remote Control binds conversations to their creating account ---------
  const rc = await readRemoteControlState();
  if (rc.configured === false) {
    findings.push({
      level: "ok",
      title: "Remote Control 자동 시작 꺼짐",
      detail:
        "새 대화가 로컬 세션으로 시작되어, 어느 계정으로도 이어서 작업할 수 있습니다.\n" +
        `설정 위치: ${rc.settingsPath}`,
    });
  } else {
    findings.push({
      level: "warn",
      title:
        rc.configured === true
          ? "Remote Control 자동 시작이 켜져 있습니다"
          : "Remote Control 자동 시작이 켜져 있을 수 있습니다 (서버 기본값)",
      detail:
        "Remote Control 브리지 세션은 만든 계정에 서버 측에서 묶입니다. 다른 계정으로 전환한 뒤 " +
        "그 대화를 열면 원래 계정으로 되돌아갑니다 (대화 내용 자체는 이어짐).\n" +
        "계정 간에 대화를 자유롭게 이어받으려면 자동 시작을 끄세요: " +
        "SubSwitcher: Disable Remote Control Autostart\n" +
        `설정 위치: ${rc.settingsPath} 의 "remoteControlAtStartup"`,
    });
  }

  // --- Profiles --------------------------------------------------------------
  const state = await loadProfiles();
  if (state.profiles.length === 0) {
    findings.push({
      level: "warn",
      title: "등록된 계정 슬롯 없음",
      detail: "SubSwitcher: Run Setup 을 실행하세요.",
    });
  } else {
    findings.push({
      level: "info",
      title: `계정 슬롯 ${state.profiles.length}개`,
      detail: profilesFile(),
    });
  }

  for (const profile of state.profiles) {
    const dir = normalizeSlotDir(profile.secureStorageDir);
    const service = keychainServiceName(dir);
    const dirExists = await pathExists(dir);
    findings.push({
      level: dirExists ? "ok" : "warn",
      title: `슬롯 "${profile.label}"`,
      detail:
        `디렉토리: ${dir}${dirExists ? "" : "  (없음)"}\n` +
        `키체인 항목: ${service}\n` +
        `확인 명령: security find-generic-password -s "${service}"`,
    });
  }

  // --- Active slot -----------------------------------------------------------
  const slotDir = getConfiguredSlotDir();
  const active = resolveActiveProfile(state);
  if (slotDir === undefined) {
    findings.push({
      level: "info",
      title: "자격증명 슬롯 미지정",
      detail:
        "CLAUDE_SECURESTORAGE_CONFIG_DIR 가 설정되어 있지 않아, Claude Code는 접미사 없는 " +
        '기본 키체인 항목("Claude Code-credentials")을 사용합니다.',
    });
  } else if (active) {
    findings.push({
      level: "ok",
      title: `활성 계정: ${active.label}`,
      detail: `${active.oauthAccount?.emailAddress ?? "이메일 미관측"}\n슬롯: ${slotDir}`,
    });
  } else {
    findings.push({
      level: "warn",
      title: "활성 슬롯이 등록된 계정과 일치하지 않음",
      detail: `설정된 슬롯: ${slotDir}\n등록된 슬롯 중 이 경로와 일치하는 것이 없습니다.`,
    });
  }

  // --- Cross-account cache staleness ----------------------------------------
  try {
    const { config } = await readConfig();
    const utilization = readUtilization(config);
    const expected = active?.oauthAccount?.accountUuid;
    if (utilization?.accountUuid && expected && utilization.accountUuid !== expected) {
      findings.push({
        level: "warn",
        title: "사용량 캐시가 다른 계정 기준입니다",
        detail:
          "전환 직후에는 정상입니다. Claude Code가 다음 요청에서 갱신합니다.\n" +
          `캐시 계정: ${utilization.accountUuid}\n활성 계정: ${expected}`,
      });
    }
  } catch {
    // The config problems are already reported above.
  }

  findings.push(...(await codexFindings()));
  return findings;
}

async function codexFindings(): Promise<Finding[]> {
  let state: CodexState;
  try {
    state = loadCodexState();
  } catch (err) {
    return [
      {
        level: "error",
        title: "Codex 슬롯 정보를 읽지 못했습니다",
        detail: `${codexProfilesFile()}\n${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  if (state.profiles.length === 0) {
    return [
      {
        level: "info",
        title: "Codex 슬롯 없음",
        detail: "Codex 계정을 전환하려면 SubSwitcher: Switch Codex Account 를 실행하세요.",
      },
    ];
  }

  const findings: Finding[] = [
    { level: "info", title: `Codex 슬롯 ${state.profiles.length}개`, detail: codexProfilesFile() },
  ];

  // Two slots resolving to one directory would share one sign-in.
  const ownerOf = new Map<string, string>();
  for (const profile of state.profiles) {
    const dir = normalizeCodexHome(profile.codexHome);
    const exists = await pathExists(dir);
    const real = exists ? await fs.realpath(dir).catch(() => dir) : dir;
    const clash = ownerOf.get(real);
    if (!clash) {
      ownerOf.set(real, profile.label);
    }
    findings.push({
      level: exists && !clash ? "ok" : "warn",
      title: `Codex 슬롯 "${profile.label}"`,
      detail:
        `CODEX_HOME: ${dir}${exists ? "" : "  (없음 — 전환하면 새로 만듭니다)"}` +
        (clash ? `\n"${clash}" 슬롯과 같은 디렉터리라서 로그인도 공유됩니다.` : ""),
    });
  }

  const home = effectiveCodexHome();
  const current = codexProfileForHome(state, home);
  const saved = findCodexProfile(state, state.activeId);
  if (saved && saved.id !== current?.id) {
    findings.push({
      level: "warn",
      title: "Codex 전환이 아직 이 창에 적용되지 않았습니다",
      detail: `선택한 슬롯: ${saved.label}\n이 창의 CODEX_HOME: ${home}\n창을 다시 로드하면 적용됩니다.`,
    });
  } else if (current) {
    findings.push({
      level: "ok",
      title: `이 창의 Codex 계정: ${current.label}`,
      detail: `CODEX_HOME: ${home}`,
    });
  } else {
    findings.push({
      level: "info",
      title: "이 창의 CODEX_HOME은 등록된 슬롯이 아닙니다",
      detail: `CODEX_HOME: ${home}`,
    });
  }
  return findings;
}

export function renderReport(findings: Finding[]): string {
  const icon: Record<Level, string> = { ok: "✅", warn: "⚠️", error: "❌", info: "ℹ️" };
  const lines = ["SubSwitcher — 진단 리포트", "=".repeat(40), ""];
  for (const f of findings) {
    lines.push(`${icon[f.level]}  ${f.title}`);
    if (f.detail) {
      for (const line of f.detail.split("\n")) {
        lines.push(`      ${line}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
