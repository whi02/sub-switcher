import * as vscode from "vscode";
import { loadProfiles, type Profile, type ProfilesState } from "./profiles";
import { resolveActive } from "./switcher";
import { formatAge, formatResetsAt, isCrossAccountStale, peakUtilization } from "./usage";

/**
 * Status bar entry showing which account the *next* conversation will use.
 *
 * Every number it shows is a last-observed value, and the tooltip always says
 * how old it is. We cannot poll a signed-out account's quota without holding its
 * token, so pretending these are live would be a lie the user might act on.
 */
export class AccountStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    const alignment =
      vscode.workspace.getConfiguration("subSwitcher").get<string>("statusBarAlignment") === "left"
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;
    this.item = vscode.window.createStatusBarItem(alignment, 100);
    this.item.command = "subSwitcher.switch";
  }

  dispose(): void {
    this.item.dispose();
  }

  async refresh(): Promise<void> {
    if (!vscode.workspace.getConfiguration("subSwitcher").get<boolean>("showStatusBar", true)) {
      this.item.hide();
      return;
    }

    let state: ProfilesState;
    try {
      state = await loadProfiles();
    } catch {
      this.item.text = "$(account) Sub: 상태 읽기 실패";
      this.item.tooltip = "profiles.json을 읽지 못했습니다. SubSwitcher: Diagnose를 실행하세요.";
      this.item.show();
      return;
    }

    if (state.profiles.length === 0) {
      this.item.text = "$(account) Sub: 설정 필요";
      this.item.tooltip = "클릭해서 SubSwitcher 설정을 시작하세요.";
      this.item.command = "subSwitcher.setup";
      this.item.show();
      return;
    }

    this.item.command = "subSwitcher.switch";
    const resolution = resolveActive(state);

    // The two "no active profile" states have different causes and different
    // fixes, so they must not share a message: right after Run Setup no slot is
    // configured at all, and telling the user their setting fails to match sends
    // them looking for a misconfiguration that does not exist.
    if (resolution.kind === "unconfigured") {
      this.item.text = "$(account) Sub: 계정 선택";
      this.item.tooltip = new vscode.MarkdownString(
        [
          "**아직 계정을 선택하지 않았습니다.**",
          "",
          "Claude Code는 접미사 없는 기본 키체인 항목을 사용하고 있습니다.",
          "",
          "_클릭: 계정 선택_",
        ].join("\n"),
      );
      this.item.show();
      return;
    }

    if (resolution.kind === "unknown-slot") {
      this.item.text = "$(account) Sub: 미지정 슬롯";
      this.item.tooltip = new vscode.MarkdownString(
        [
          "**등록되지 않은 자격증명 슬롯이 설정되어 있습니다.**",
          "",
          "`claudeCode.environmentVariables`의 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 값이",
          "등록된 계정 슬롯 중 어느 것과도 일치하지 않습니다.",
          "",
          `현재 값: \`${resolution.slotDir}\``,
          "",
          "_클릭: 계정 선택_",
        ].join("\n"),
      );
      this.item.show();
      return;
    }

    const active = resolution.profile;
    const peak = peakUtilization(active.lastSeenUtilization);
    this.item.text =
      peak !== undefined
        ? `$(account) ${active.label} · ${Math.round(peak)}%`
        : `$(account) ${active.label}`;
    this.item.tooltip = this.buildTooltip(state, active);
    this.item.show();
  }

  private buildTooltip(state: ProfilesState, active: Profile): vscode.MarkdownString {
    const lines: string[] = ["**SubSwitcher**", ""];

    for (const profile of state.profiles) {
      const marker = profile.id === active.id ? "●" : "○";
      const email = profile.oauthAccount?.emailAddress ?? "이메일 미관측";
      lines.push(`${marker} **${profile.label}** — ${email}`);

      const snapshot = profile.lastSeenUtilization;
      const peak = peakUtilization(snapshot);
      if (peak === undefined) {
        lines.push("&nbsp;&nbsp;&nbsp;사용량 관측 기록 없음");
      } else {
        const parts: string[] = [];
        if (snapshot?.fiveHour !== undefined) {
          parts.push(`5시간 ${Math.round(snapshot.fiveHour)}%`);
        }
        if (snapshot?.sevenDay !== undefined) {
          parts.push(`7일 ${Math.round(snapshot.sevenDay)}%`);
        }
        lines.push(`&nbsp;&nbsp;&nbsp;${parts.join(" · ")} — ${formatAge(snapshot?.fetchedAt)}`);

        const resets = formatResetsAt(snapshot?.resetsAt);
        if (resets) {
          lines.push(`&nbsp;&nbsp;&nbsp;7일 한도 리셋: ${resets}`);
        }
        if (isCrossAccountStale(snapshot, profile.oauthAccount?.accountUuid)) {
          lines.push("&nbsp;&nbsp;&nbsp;⚠️ 다른 계정 기준 수치일 수 있음");
        }
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("모든 수치는 **마지막으로 관측된 값**입니다. 비활성 계정의 실시간 사용량은");
    lines.push("해당 계정 토큰을 다뤄야 하므로 조회하지 않습니다.");
    lines.push("");
    lines.push("전환해도 **실행 중인 대화는 원래 계정 그대로** 계속됩니다.");
    lines.push("");
    lines.push("_클릭: 계정 전환_");

    const md = new vscode.MarkdownString(lines.join("\n"));
    md.supportThemeIcons = true;
    return md;
  }
}
