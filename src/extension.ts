import * as vscode from "vscode";
import { renderReport, runDoctor } from "./doctor";
import { loadProfiles, saveProfiles, type Profile } from "./profiles";
import { addAccountInteractive, runSetup } from "./setup";
import { AccountStatusBar } from "./statusBar";
import { captureActiveState, describeError, resetToDefaults, resolveActiveProfile, switchTo } from "./switcher";
import { peakUtilization } from "./usage";

/**
 * Account Lanes -- switch between your own Claude subscriptions in VS Code.
 *
 * What this extension does: it sets one environment variable
 * (CLAUDE_SECURESTORAGE_CONFIG_DIR) that the official Claude Code extension
 * passes to the Claude process it spawns, and it keeps the account-scoped caches
 * in ~/.claude.json in sync with that choice.
 *
 * What it deliberately does not do, per Claude Code's terms:
 *   - read, write, copy or store credentials of any kind (sign-in happens only
 *     through Claude Code's own /login flow)
 *   - modify the official extension or its bundled binary
 *   - call Anthropic's API on the user's behalf
 *   - rotate accounts automatically when a limit is reached
 */

/** How often to refresh the last-observed quota numbers while idle. */
const CAPTURE_INTERVAL_MS = 60_000;

let statusBar: AccountStatusBar | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new AccountStatusBar();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("doubleClaude.switch", () => commandSwitch()),
    vscode.commands.registerCommand("doubleClaude.setup", () => commandSetup()),
    vscode.commands.registerCommand("doubleClaude.addAccount", () => commandAddAccount()),
    vscode.commands.registerCommand("doubleClaude.doctor", () => commandDoctor()),
    vscode.commands.registerCommand("doubleClaude.reset", () => commandReset()),
  );

  // The user can edit the environment setting by hand, and the status bar's own
  // options live in our section, so watch both.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("claudeCode.environmentVariables") ||
        event.affectsConfiguration("doubleClaude")
      ) {
        void statusBar?.refresh();
      }
    }),
  );

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
      .getConfiguration("doubleClaude")
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

async function commandSetup(): Promise<void> {
  try {
    const state = await runSetup();
    if (state) {
      vscode.window.showInformationMessage(
        `계정 슬롯 ${state.profiles.length}개를 등록했습니다. 상태바에서 전환할 수 있습니다.`,
      );
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
