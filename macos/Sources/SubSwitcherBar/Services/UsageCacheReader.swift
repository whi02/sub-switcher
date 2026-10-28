import Foundation

/// Collects the usage numbers Claude Code has already cached on disk.
///
/// We never call Anthropic's usage endpoint and never touch tokens: holding another
/// account's session token is exactly what Claude Code's terms forbid third-party tools
/// from doing. So every number shown is one Claude Code fetched itself, with its age.
///
/// Sources, merged by `accountUuid` (freshest `fetchedAtMs` wins):
///   - the shared config: `~/.claude/.config.json` if present, else `~/.claude.json`
///   - each `CLAUDE_CONFIG_DIR` slot (`~/.claude-*`, plus SubSwitcher's slot dirs)
///   - SubSwitcher's `~/.claude-accounts/profiles.json` snapshots
enum UsageCacheReader {
    private static let home = FileManager.default.homeDirectoryForCurrentUser

    struct Result {
        var accounts: [AccountSnapshot]
        /// Set when `profiles.json` comes from a newer SubSwitcher; its contents are then ignored.
        var unsupportedProfilesVersion: Int?
    }

    static func read() -> Result {
        var merged: [String: AccountSnapshot] = [:]
        var identities: [String: OAuthAccount] = [:]
        var labels: [String: String] = [:]

        func absorb(_ snapshot: AccountSnapshot) {
            if let existing = merged[snapshot.accountUuid],
               (existing.fetchedAt ?? .distantPast) >= (snapshot.fetchedAt ?? .distantPast) {
                return
            }
            merged[snapshot.accountUuid] = snapshot
        }

        func absorb(config: ClaudeConfigFile) {
            if let account = config.oauthAccount, let uuid = account.accountUuid {
                identities[uuid] = account
            }
            if let snapshot = snapshot(from: config.cachedUsageUtilization) { absorb(snapshot) }
        }

        var profilesFile = decode(ProfilesFile.self, at: home.appending(path: ".claude-accounts/profiles.json"))
        // A newer schema may mean different semantics (e.g. who owns the shared cache), so guessing is worse than ignoring it.
        var unsupportedVersion: Int?
        if let version = profilesFile?.version, version > ProfilesFile.supportedVersion {
            unsupportedVersion = version
            profilesFile = nil
        }
        let profiles = profilesFile?.profiles ?? []
        let activeUuid = profiles.first { $0.id != nil && $0.id == profilesFile?.activeId }?.oauthAccount?.accountUuid
        for profile in profiles {
            if let account = profile.oauthAccount, let uuid = account.accountUuid {
                identities[uuid] = account
                if let label = profile.label { labels[uuid] = label }
            }
            if let snapshot = snapshot(from: profile.accountCaches?.cachedUsageUtilization) {
                absorb(snapshot)
            } else if let snapshot = snapshot(from: profile.lastSeenUtilization) {
                absorb(snapshot)
            }
        }

        for dir in slotDirectories(profiles: profiles) {
            if let config = decode(ClaudeConfigFile.self, at: configFile(in: dir, fallback: dir.appending(path: ".claude.json"))) {
                absorb(config: config)
            }
        }

        let shared = decode(ClaudeConfigFile.self, at: configFile(in: home.appending(path: ".claude"),
                                                                 fallback: home.appending(path: ".claude.json")))
        if let shared {
            if let account = shared.oauthAccount, let uuid = account.accountUuid {
                identities[uuid] = account
            }
            // With SubSwitcher, the shared config's numbers are fetched with the active slot's
            // credentials, but the `accountUuid` stamped on them can still name a previous account.
            // The active profile is the better owner (confirmed by matching reset times).
            if var snapshot = snapshot(from: shared.cachedUsageUtilization) {
                if let activeUuid {
                    snapshot = AccountSnapshot(accountUuid: activeUuid, label: "", fiveHour: snapshot.fiveHour,
                                               sevenDay: snapshot.sevenDay, fetchedAt: snapshot.fetchedAt)
                }
                absorb(snapshot)
            }
        }
        let currentUuid = activeUuid ?? shared?.oauthAccount?.accountUuid

        let accounts = merged.values.map { snapshot in
            var result = snapshot
            let identity = identities[snapshot.accountUuid]
            result.email = identity?.emailAddress
            result.plan = planName(identity?.organizationType)
            result.label = labels[snapshot.accountUuid] ?? identity?.displayName ?? identity?.emailAddress ?? "Claude"
            result.isCurrent = snapshot.accountUuid == currentUuid
            return result
        }
        .sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
        return Result(accounts: accounts, unsupportedProfilesVersion: unsupportedVersion)
    }

    // MARK: - Helpers

    private static func snapshot(from cache: CachedUsage?) -> AccountSnapshot? {
        guard let cache, let uuid = cache.accountUuid else { return nil }
        return AccountSnapshot(
            accountUuid: uuid,
            label: "",
            fiveHour: cache.utilization?.fiveHour,
            sevenDay: cache.utilization?.sevenDay,
            fetchedAt: cache.fetchedAtMs.map { Date(timeIntervalSince1970: $0 / 1000) }
        )
    }

    /// Older SubSwitcher snapshots keep only the seven-day reset time.
    private static func snapshot(from lastSeen: ProfilesFile.Profile.LastSeen?) -> AccountSnapshot? {
        guard let lastSeen, let uuid = lastSeen.accountUuid else { return nil }
        return AccountSnapshot(
            accountUuid: uuid,
            label: "",
            fiveHour: lastSeen.fiveHour.map { UsageWindow(utilization: $0, resetsAt: nil) },
            sevenDay: lastSeen.sevenDay.map { UsageWindow(utilization: $0, resetsAt: parseISODate(lastSeen.resetsAt)) },
            fetchedAt: parseISODate(lastSeen.fetchedAt)
        )
    }

    /// `~/.claude-*` directories (except SubSwitcher's own state dir) plus every slot SubSwitcher knows about.
    private static func slotDirectories(profiles: [ProfilesFile.Profile]) -> [URL] {
        var dirs = Set<String>()
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: home.path)) ?? []
        for name in entries where name.hasPrefix(".claude-") && name != ".claude-accounts" {
            dirs.insert(home.appending(path: name).standardizedFileURL.path)
        }
        for profile in profiles {
            guard let raw = profile.secureStorageDir else { continue }
            let expanded = (raw as NSString).expandingTildeInPath
            dirs.insert(URL(fileURLWithPath: expanded).standardizedFileURL.path)
        }
        return dirs.sorted().map { URL(fileURLWithPath: $0) }
    }

    /// Claude Code prefers `<dataDir>/.config.json` when it exists.
    private static func configFile(in dataDir: URL, fallback: URL) -> URL {
        let preferred = dataDir.appending(path: ".config.json")
        return FileManager.default.fileExists(atPath: preferred.path) ? preferred : fallback
    }

    private static func decode<T: Decodable>(_ type: T.Type, at url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func planName(_ organizationType: String?) -> String? {
        switch organizationType {
        case "claude_max": return "Max"
        case "claude_pro": return "Pro"
        case "claude_team": return "Team"
        case "claude_enterprise": return "Enterprise"
        default: return nil
        }
    }
}
