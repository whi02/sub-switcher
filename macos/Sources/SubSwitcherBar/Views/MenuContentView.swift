import SwiftUI

struct MenuContentView: View {
    @Environment(UsageStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if store.accounts.isEmpty {
                Text("표시할 계정이 없습니다.\nClaude Code에서 `/login` 한 뒤 대화를 한 번 하면 사용량이 기록되어 여기에 나타납니다.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(store.accounts) { account in
                            AccountCard(account: account, now: context.date)
                            if account.id != store.accounts.last?.id { Divider() }
                        }
                    }
                }
            }

            Divider()

            if let version = store.unsupportedProfilesVersion {
                Text("profiles.json이 더 새로운 SubSwitcher(v\(version))로 저장되어 계정 이름과 전환 정보를 읽지 않았습니다. SubSwitcher Bar를 업데이트하세요.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("Claude Code가 마지막으로 받아 둔 값입니다. 실시간 조회가 아닙니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button("새로고침") { store.refresh() }
                Spacer()
                Button("종료") { NSApp.terminate(nil) }
            }
        }
        .padding(14)
        .frame(width: 320)
    }
}

private struct AccountCard: View {
    let account: AccountSnapshot
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(account.label).font(.headline).lineLimit(1)
                if let plan = account.plan {
                    Badge(text: plan, color: plan == "Max" ? .purple : .blue)
                }
                if account.isCurrent {
                    Badge(text: "현재", color: .green)
                }
                Spacer()
            }
            if let email = account.email, email != account.label {
                Text(email).font(.caption).foregroundStyle(.secondary)
            }

            UsageRow(title: "5시간", window: account.fiveHour, now: now)
            UsageRow(title: "7일", window: account.sevenDay, now: now)

            Text(observedText)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var observedText: String {
        guard let fetchedAt = account.fetchedAt else { return "관측 시각 모름" }
        return "\(fetchedAt.formatted(.relative(presentation: .named))) 관측"
    }
}

private struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(color.opacity(0.22))
            .clipShape(Capsule())
    }
}

private struct UsageRow: View {
    let title: String
    let window: UsageWindow?
    let now: Date

    var body: some View {
        let value = window?.effectiveUtilization(at: now)
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text(value.map { "\(Int($0.rounded()))%" } ?? "–")
                    .font(.subheadline.monospacedDigit())
            }
            ProgressView(value: min(max((value ?? 0) / 100, 0), 1))
                .tint(color(for: value ?? 0))
            Text(resetText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func color(for value: Double) -> Color {
        if value >= 80 { return .red }
        if value >= 50 { return .orange }
        return .green
    }

    private var resetText: String {
        guard let window else { return "기록 없음" }
        if window.hasReset(at: now) { return "관측 이후 초기화됨" }
        guard let resetsAt = window.resetsAt else {
            return window.utilization == 0 ? "사용 기록 없음" : "초기화 시각 모름"
        }
        let seconds = Int(resetsAt.timeIntervalSince(now))
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60
        let remaining = days > 0 ? "\(days)일 \(hours)시간" : hours > 0 ? "\(hours)시간 \(minutes)분" : "\(max(minutes, 1))분"
        let at = resetsAt.formatted(.dateTime.month().day().hour().minute())
        return "\(remaining) 후 초기화 (\(at))"
    }
}
