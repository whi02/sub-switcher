import * as vscode from "vscode";
import {
  applyActiveCodexHome,
  codexProfileForHome,
  effectiveCodexHome,
  findCodexProfile,
  loadCodexState,
  normalizeCodexHome,
  selectCodexProfile,
  type CodexProfile,
  type CodexState,
} from "./codex";
import { addCodexAccountInteractive, registerCodexSlotsInteractive } from "./codexSetup";
import { renderReport, runDoctor } from "./doctor";
import { loadProfiles, saveProfiles, type Profile } from "./profiles";
import { readRemoteControlState, setRemoteControlAtStartup } from "./remoteControl";
import { addAccountInteractive, runSetup } from "./setup";
import { AccountStatusBar, CodexStatusBar } from "./statusBar";
import { captureActiveState, describeError, resetToDefaults, resolveActiveProfile, switchTo } from "./switcher";
import { peakUtilization } from "./usage";

/**
 * SubSwitcher -- switch between your own Claude subscriptions in VS Code.
 *
 * What this extension does: it sets one environment variable
 * (CLAUDE_SECURESTORAGE_CONFIG_DIR) that the official Claude Code extension
 * passes to the Claude process it spawns, and it keeps the account-scoped caches
 * in ~/.claude.json in sync with that choice. For Codex it selects CODEX_HOME in
 * this extension host's environment when the window loads.
 *
 * What it deliberately does not do, per Claude Code's and OpenAI's terms:
 *   - read, write, copy or store credentials of any kind (sign-in happens only
 *     through Claude Code's /login and Codex's own sign-in)
 *   - modify the official extensions or their bundled binaries
 *   - call Anthropic's or OpenAI's API on the user's behalf
 *   - rotate accounts automatically when a limit is reached
 */

/** How often to refresh the last-observed quota numbers while idle. */
const CAPTURE_INTERVAL_MS = 60_000;

let statusBar: AccountStatusBar | undefined;
let codexStatusBar: CodexStatusBar | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Must stay first and synchronous: the Codex extension activates onStartupFinished
  // and its app-server inherits whatever CODEX_HOME is set when it spawns.
  try {
    applyActiveCodexHome(loadCodexState());
  } catch {
    // The Codex status bar item and the doctor report the unreadable state.
  }

  statusBar = new AccountStatusBar();
  codexStatusBar = new CodexStatusBar();
  context.subscriptions.push(statusBar, codexStatusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("subSwitcher.switch", () => commandSwitch()),
    vscode.commands.registerCommand("subSwitcher.setup", () => commandSetup()),
    vscode.commands.registerCommand("subSwitcher.addAccount", () => commandAddAccount()),
    vscode.commands.registerCommand("subSwitcher.doctor", () => commandDoctor()),
    vscode.commands.registerCommand("subSwitcher.reset", () => commandReset()),
    vscode.commands.registerCommand("subSwitcher.disableRemoteControlAutostart", () =>
      commandDisableRemoteControlAutostart(),
    ),
    vscode.commands.registerCommand("subSwitcher.switchCodex", () => commandSwitchCodex()),
    vscode.commands.registerCommand("subSwitcher.addCodexAccount", () => commandAddCodexAccount()),
  );

  // The user can edit the environment setting by hand, and the status bar's own
  // options live in our section, so watch both.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("claudeCode.environmentVariables") ||
        event.affectsConfiguration("subSwitcher")
      ) {
        void statusBar?.refresh();
        codexStatusBar?.refresh();
      }
    }),
  );
  codexStatusBar.refresh();

  // Keep each profile's snapshot fresh so the picker can show meaningful numbers
  // for the account you are about to leave.
  const timer = setInterval(() => {
    void captureAndRefresh();
  }, CAPTURE_INTERVAL_MS);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));

  await captureAndRefresh();
}

export function deactivate(): void {
  statusBar = undefined;
  codexStatusBar = undefined;
}

async function captureAndRefresh(): Promise<void> {
  try {
    const state = await loadProfiles();
    if (await captureActiveState(state)) {
      await saveProfiles(state);
    }
  } catch {
    // A snapshot refresh is best-effort; the status bar reports real problems.
  }
  await statusBar?.refresh();
}

async function commandSwitch(): Promise<void> {
  let state = await loadProfiles();

  if (state.profiles.length === 0) {
    const next = await runSetup();
    if (!next) {
      return;
    }
    state = next;
  }

  // Freshen numbers first so the picker does not show the outgoing account stale.
  if (await captureActiveState(state)) {
    await saveProfiles(state);
  }

  const active = resolveActiveProfile(state);
  const items: (vscode.QuickPickItem & { profile?: Profile })[] = state.profiles.map((profile) => {
    const peak = peakUtilization(profile.lastSeenUtilization);
    return {
      label: profile.id === active?.id ? `$(check) ${profile.label}` : `$(account) ${profile.label}`,
      description: profile.oauthAccount?.emailAddress ?? "이메일 미관측",
      detail:
        peak !== undefined
          ? `마지막 관측 사용량 ${Math.round(peak)}%`
          : "사용량 관측 기록 없음",
      profile,
    };
  });

  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(add) 계정 슬롯 추가…" },
    { label: "$(pulse) 진단 실행…" },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "Claude 계정 전환",
    placeHolder: "실행 중인 대화는 원래 계정 그대로 유지됩니다",
  });
  if (!picked) {
    return;
  }

  if (picked.label.includes("계정 슬롯 추가")) {
    await commandAddAccount();
    return;
  }
  if (picked.label.includes("진단 실행")) {
    await commandDoctor();
    return;
  }
  if (!picked.profile) {
    return;
  }
  if (picked.profile.id === active?.id) {
    vscode.window.showInformationMessage(`이미 "${picked.profile.label}" 계정입니다.`);
    return;
  }

  await performSwitch(picked.profile.id);
}

async function performSwitch(profileId: string): Promise<void> {
  try {
    const result = await switchTo(profileId);
    await statusBar?.refresh();

    const promptNew = vscode.workspace
      .getConfiguration("subSwitcher")
      .get<boolean>("promptNewConversationAfterSwitch", true);

    const message =
      `${result.to.label} 계정으로 전환했습니다. ` +
      "새로 시작하는 대화부터 적용되며, 실행 중인 대화는 원래 계정 그대로입니다.";

    if (!promptNew) {
      vscode.window.showInformationMessage(message);
      return;
    }

    const action = await vscode.window.showInformationMessage(message, "새 대화 시작");
    if (action === "새 대화 시작") {
      await openNewConversation();
    }

    await maybeWarnRemoteControlBinding(result.to.label);
  } catch (err) {
    vscode.window.showErrorMessage(`계정 전환 실패: ${describeError(err)}`);
  }
}

/**
 * Ask the official extension for a new conversation. Its command ids have moved
 * between releases, so try the known ones and fail quietly rather than throwing.
 */
async function openNewConversation(): Promise<void> {
  const candidates = ["claude-vscode.newConversation", "claude-vscode.editor.open"];
  const available = new Set(await vscode.commands.getCommands(true));
  for (const command of candidates) {
    if (available.has(command)) {
      await vscode.commands.executeCommand(command);
      return;
    }
  }
  vscode.window.showInformationMessage(
    "Claude Code에서 새 대화를 직접 시작하세요. (새 대화부터 전환된 계정이 적용됩니다)",
  );
}

async function commandSwitchCodex(): Promise<void> {
  let state: CodexState;
  try {
    state = loadCodexState();
    if (state.profiles.length === 0) {
      const registered = await registerCodexSlotsInteractive();
      if (!registered) {
        return;
      }
      state = registered;
      codexStatusBar?.refresh();
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Codex 슬롯 정보를 읽지 못했습니다: ${describeError(err)}`);
    return;
  }

  const current = codexProfileForHome(state, effectiveCodexHome());
  const saved = findCodexProfile(state, state.activeId);
  const items: (vscode.QuickPickItem & { profile?: CodexProfile })[] = state.profiles.map(
    (profile) => ({
      label: profile.id === current?.id ? `$(check) ${profile.label}` : `$(account) ${profile.label}`,
      description:
        profile.id === saved?.id && profile.id !== current?.id ? "다시 로드하면 적용" : undefined,
      detail: normalizeCodexHome(profile.codexHome),
      profile,
    }),
  );
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(add) Codex 계정 슬롯 추가…" },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: "Codex 계정 전환",
    placeHolder: "전환하면 이 창을 다시 로드해야 합니다. 기록과 설정은 계정마다 따로 저장됩니다",
  });
  if (!picked) {
    return;
  }
  if (!picked.profile) {
    if (picked.label.includes("슬롯 추가")) {
      await commandAddCodexAccount();
    }
    return;
  }

  const target = picked.profile;
  if (target.id === current?.id && target.id === saved?.id) {
    vscode.window.showInformationMessage(`이 창은 이미 Codex "${target.label}" 계정을 쓰고 있습니다.`);
    return;
  }

  try {
    await selectCodexProfile(target.id);
  } catch (err) {
    vscode.window.showErrorMessage(`Codex 계정 전환 실패: ${describeError(err)}`);
    return;
  }
  codexStatusBar?.refresh();

  if (target.id === current?.id) {
    vscode.window.showInformationMessage(
      `이 창은 이미 Codex "${target.label}" 계정을 쓰고 있어 다시 로드할 필요가 없습니다.`,
    );
    return;
  }

  const reload = await vscode.window.showWarningMessage(
    `Codex를 "${target.label}" 계정으로 바꾸려면 창을 다시 로드해야 합니다.`,
    {
      modal: true,
      detail:
        "이 창에서 실행 중인 Codex와 Claude Code 작업이 모두 중단됩니다. " +
        "Codex 기록·설정·메모리는 계정마다 따로 저장되므로, 이전 계정의 대화는 새 계정에서 보이지 않습니다. " +
        "다른 VS Code 창에는 각 창을 다시 로드할 때 적용됩니다.",
    },
    "지금 다시 로드",
  );
  if (reload === "지금 다시 로드") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    return;
  }
  vscode.window.showInformationMessage(
    `다음에 창을 다시 로드하거나 새 창을 열면 Codex "${target.label}" 계정이 적용됩니다.`,
  );
}

async function commandAddCodexAccount(): Promise<void> {
  try {
    await addCodexAccountInteractive();
  } catch (err) {
    vscode.window.showErrorMessage(`Codex 슬롯 추가 실패: ${describeError(err)}`);
  }
  codexStatusBar?.refresh();
}

async function commandSetup(): Promise<void> {
  try {
    const state = await runSetup();
    if (state) {
      vscode.window.showInformationMessage(
        `계정 슬롯 ${state.profiles.length}개를 등록했습니다. 상태바에서 전환할 수 있습니다.`,
      );
      await maybeWarnRemoteControlBinding(state.profiles[0]?.label ?? "다른");
    }
  } catch (err) {
    vscode.window.showErrorMessage(`설정 실패: ${describeError(err)}`);
  }
  await statusBar?.refresh();
}

async function commandAddAccount(): Promise<void> {
  try {
    await addAccountInteractive();
  } catch (err) {
    vscode.window.showErrorMessage(`슬롯 추가 실패: ${describeError(err)}`);
  }
  await statusBar?.refresh();
}

async function commandDoctor(): Promise<void> {
  try {
    const findings = await runDoctor();
    const doc = await vscode.workspace.openTextDocument({
      content: renderReport(findings),
      language: "plaintext",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err) {
    vscode.window.showErrorMessage(`진단 실패: ${describeError(err)}`);
  }
}

/**
 * Remote Control ties a conversation to the account that started it. Mention it
 * once, the first time the user switches, so the "why did my old conversation
 * jump back to the other account" surprise is pre-empted rather than debugged.
 */
async function maybeWarnRemoteControlBinding(targetLabel: string): Promise<void> {
  let rc;
  try {
    rc = await readRemoteControlState();
  } catch {
    return;
  }
  if (!rc.bindsNewConversations) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    "Remote Control 자동 시작이 켜져 있어, 기존 대화는 각자 만든 계정에 묶여 있습니다. " +
      `${targetLabel} 계정에서 이전 대화를 이어받으려면 자동 시작을 꺼야 합니다.`,
    "자동 시작 끄기",
    "나중에",
  );
  if (choice === "자동 시작 끄기") {
    await commandDisableRemoteControlAutostart();
  }
}

async function commandDisableRemoteControlAutostart(): Promise<void> {
  let rc;
  try {
    rc = await readRemoteControlState();
  } catch (err) {
    vscode.window.showErrorMessage(`Remote Control 설정 확인 실패: ${describeError(err)}`);
    return;
  }

  if (rc.configured === false) {
    vscode.window.showInformationMessage(
      "이미 Remote Control 자동 시작이 꺼져 있습니다. 새 대화는 계정 간에 이어받을 수 있습니다.",
    );
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `${rc.settingsPath} 에 "remoteControlAtStartup": false 를 기록합니다. ` +
      "이후 새 대화는 로컬 세션으로 시작되어 어느 계정으로도 이어서 작업할 수 있습니다. " +
      "특정 대화에서 Remote Control이 필요하면 그 세션에서 직접 켜면 됩니다. " +
      "이미 만들어진 브리지 대화는 내용은 이어지지만 다른 계정에서 Remote Control이 되살아나지 않습니다.",
    { modal: true },
    "끄기",
  );
  if (confirm !== "끄기") {
    return;
  }

  try {
    await setRemoteControlAtStartup(false);
    vscode.window.showInformationMessage(
      "Remote Control 자동 시작을 껐습니다. 지금 실행 중인 대화는 영향을 받지 않으며, " +
        "새로 시작하는 대화부터 적용됩니다.",
    );
  } catch (err) {
    vscode.window.showErrorMessage(`설정 변경 실패: ${describeError(err)}`);
  }
  await statusBar?.refresh();
}

async function commandReset(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "CLAUDE_SECURESTORAGE_CONFIG_DIR 설정을 제거하고 Claude Code를 기본 동작으로 되돌립니다. " +
      "등록된 슬롯 정보와 로그인 상태는 그대로 유지됩니다.",
    { modal: true },
    "되돌리기",
  );
  if (confirm !== "되돌리기") {
    return;
  }
  try {
    await resetToDefaults();
    vscode.window.showInformationMessage("기본 동작으로 되돌렸습니다.");
  } catch (err) {
    vscode.window.showErrorMessage(`되돌리기 실패: ${describeError(err)}`);
  }
  await statusBar?.refresh();
}
