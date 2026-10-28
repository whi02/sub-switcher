import Foundation

/// One rate-limit window as Claude Code caches it in `cachedUsageUtilization.utilization`.
struct UsageWindow: Decodable, Equatable {
    /// Percent used, 0...100.
    let utilization: Double
    let resetsAt: Date?

    private enum CodingKeys: String, CodingKey {
        case utilization
        case resetsAt = "resets_at"
    }

    init(utilization: Double, resetsAt: Date?) {
        self.utilization = utilization
        self.resetsAt = resetsAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        utilization = (try? c.decodeIfPresent(Double.self, forKey: .utilization)) ?? 0
        resetsAt = (try? c.decodeIfPresent(String.self, forKey: .resetsAt)).flatMap(parseISODate)
    }
}

func parseISODate(_ raw: String?) -> Date? {
    guard let raw else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: raw) { return date }
    return ISO8601DateFormatter().date(from: raw)
}

/// What the menu shows for one Claude account: the freshest numbers Claude Code cached for it.
struct AccountSnapshot: Identifiable, Equatable {
    var id: String { accountUuid }
    let accountUuid: String
    var label: String
    var email: String?
    var plan: String?
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    /// When Claude Code fetched these numbers, not when we read them.
    var fetchedAt: Date?
    /// True for the account the shared `~/.claude.json` currently belongs to.
    var isCurrent = false
}

// MARK: - On-disk shapes (only the keys we read; everything else is ignored)

struct OAuthAccount: Decodable {
    let accountUuid: String?
    let emailAddress: String?
    let displayName: String?
    let organizationType: String?
}

struct CachedUsage: Decodable {
    struct Windows: Decodable {
        let fiveHour: UsageWindow?
        let sevenDay: UsageWindow?

        private enum CodingKeys: String, CodingKey {
            case fiveHour = "five_hour"
            case sevenDay = "seven_day"
        }
    }

    let fetchedAtMs: Double?
    let accountUuid: String?
    let utilization: Windows?
}

/// `~/.claude.json`, or the same file inside a `CLAUDE_CONFIG_DIR` slot.
struct ClaudeConfigFile: Decodable {
    let oauthAccount: OAuthAccount?
    let cachedUsageUtilization: CachedUsage?
}

/// SubSwitcher's `~/.claude-accounts/profiles.json`. Holds slot paths and cached numbers, never tokens.
struct ProfilesFile: Decodable {
    struct Profile: Decodable {
        struct AccountCaches: Decodable {
            let cachedUsageUtilization: CachedUsage?
        }

        struct LastSeen: Decodable {
            let fiveHour: Double?
            let sevenDay: Double?
            let resetsAt: String?
            let fetchedAt: String?
            let accountUuid: String?
        }

        let id: String?
        let label: String?
        let secureStorageDir: String?
        let oauthAccount: OAuthAccount?
        let accountCaches: AccountCaches?
        let lastSeenUtilization: LastSeen?
    }

    /// Schema version SubSwitcher wrote (`PROFILES_VERSION` in src/profiles.ts).
    let version: Int?
    let activeId: String?
    let profiles: [Profile]?

    /// The newest `profiles.json` schema this app understands.
    static let supportedVersion = 1
}
