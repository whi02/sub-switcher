import Foundation
import Observation

@MainActor
@Observable
final class UsageStore {
    static let shared = UsageStore()

    /// Re-reading local files is cheap; this only controls how soon a fresh Claude Code fetch shows up.
    private static let refreshInterval: TimeInterval = 30

    private(set) var accounts: [AccountSnapshot] = []
    private(set) var unsupportedProfilesVersion: Int?
    private(set) var lastRead: Date?

    private var timer: Timer?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: Self.refreshInterval, repeats: true) { _ in
            Task { @MainActor in UsageStore.shared.refresh() }
        }
    }

    /// The current account's 5-hour usage (or the highest one if no account is current), for the menu bar.
    var menuBarPercent: Int? {
        let account = accounts.first(where: \.isCurrent) ?? accounts.max {
            ($0.fiveHour?.utilization ?? 0) < ($1.fiveHour?.utilization ?? 0)
        }
        guard let window = account?.fiveHour else { return nil }
        return Int(window.effectiveUtilization(at: Date()).rounded())
    }

    func refresh() {
        let result = UsageCacheReader.read()
        accounts = result.accounts
        unsupportedProfilesVersion = result.unsupportedProfilesVersion
        lastRead = Date()
    }
}

extension UsageWindow {
    /// A window whose reset time has already passed was emptied after Claude Code last looked.
    func hasReset(at now: Date) -> Bool {
        guard let resetsAt else { return false }
        return resetsAt <= now
    }

    func effectiveUtilization(at now: Date) -> Double {
        hasReset(at: now) ? 0 : utilization
    }
}
