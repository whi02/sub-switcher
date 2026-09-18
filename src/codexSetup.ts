import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  codexLabelFor,
  codexProfileForHome,
  discoverCodexHomes,
  isDefaultCodexHome,
  loadCodexState,
  normalizeCodexHome,
  saveCodexState,
  type CodexState,
} from "./codex";
import { claudeDataDir, home, stateDir } from "./paths";
import { makeProfileId } from "./profiles";
import { validateLabel, validateSlotDir } from "./setup";

/** First run: register the Codex homes that already exist on this machine. */
export async function registerCodexSlotsInteractive(): Promise<CodexState | undefined> {
  const state = loadCodexState();
  const fresh = (await discoverCodexHomes()).filter((dir) => !codexProfileForHome(state, dir));

  if (fresh.length === 0) {
    const action = await vscode.window.showInformationMessage(
      state.profiles.length > 0
        ? "새로 발견된 Codex 디렉터리가 없습니다."
        : "~/.codex 또는 ~/.codex-* 디렉터리를 찾지 못했습니다. Codex 슬롯을 직접 추가할 수 있습니다.",
      "슬롯 직접 추가",
      "닫기",
    );
    return action === "슬롯 직접 추가" ? addCodexAccountInteractive() : undefined;
  }

  const picked = await vscode.window.showQuickPick(
    fresh.map((dir) => ({ label: codexLabelFor(dir), detail: dir, picked: true, dir })),
    {
      canPickMany: true,
      title: "등록할 Codex 계정 슬롯 선택",
      placeHolder: "슬롯마다 Codex 로그인·설정·기록이 따로 저장됩니다",
    },
  );
  if (!picked || picked.length === 0) {
    return undefined;
  }

  for (const item of picked) {
    state.profiles.push({
      id: makeProfileId(state, isDefaultCodexHome(item.dir) ? "default" : item.label),
      label: item.label,
      codexHome: item.dir,
    });
  }
  await saveCodexState(state);
  return state;
}

export async function addCodexAccountInteractive(): Promise<CodexState | undefined> {
  const state = loadCodexState();

  const label = await vscode.window.showInputBox({
    title: "Codex 계정 슬롯 이름",
    prompt: "상태바와 피커에 표시될 이름입니다.",
    placeHolder: "예: work",
    validateInput: validateLabel,
  });
  if (!label) {
    return undefined;
  }
  const cleanLabel = label.trim();

  const dirInput = await vscode.window.showInputBox({
    title: "CODEX_HOME 디렉터리",
    prompt: "이 계정의 Codex 로그인·설정·기록이 저장될 디렉터리입니다. 없으면 새로 만듭니다.",
    value: path.join(home(), `.codex-${cleanLabel.toLowerCase()}`),
    validateInput: validateSlotDir,
  });
  if (!dirInput) {
    return undefined;
  }

  const dir = normalizeCodexHome(dirInput.trim());
  const reserved = [home(), stateDir(), claudeDataDir()].map(normalizeCodexHome);
  if (reserved.includes(dir)) {
    vscode.window.showWarningMessage(`${dir} 는 Codex 슬롯으로 쓸 수 없습니다.`);
    return undefined;
  }
  if (codexProfileForHome(state, dir)) {
    vscode.window.showWarningMessage(`이미 등록된 Codex 슬롯입니다: ${dir}`);
    return undefined;
  }

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  state.profiles.push({
    id: makeProfileId(state, cleanLabel),
    label: cleanLabel,
    codexHome: dir,
  });
  await saveCodexState(state);

  vscode.window.showInformationMessage(
    `Codex 슬롯 "${cleanLabel}"을 등록했습니다. 이 슬롯으로 전환하고 창을 다시 로드한 뒤, ` +
      "Codex 사이드바에서 로그인하세요.",
  );
  return state;
}
