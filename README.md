# Account Lanes

Switch between **your own** Claude subscriptions inside VS Code without signing out, while every account keeps sharing the same conversation history, memory and settings.

> Not affiliated with, endorsed by, or built by Anthropic. Works alongside the official Claude Code extension; it does not modify it.

## The problem

If you hold more than one Claude subscription, the usual way to use both is a shell alias:

```bash
alias claude2='CLAUDE_CONFIG_DIR=~/.claude-pro2 claude'
```

That has two costs:

1. **It does not reach the VS Code extension.** There is no account picker in the UI ([anthropics/claude-code#55621](https://github.com/anthropics/claude-code/issues/55621)).
2. **It splits your history.** `CLAUDE_CONFIG_DIR` moves the whole data directory, so `projects/` (session transcripts *and* `memory/`), `history.jsonl`, `CLAUDE.md`, `settings.json` and `plugins/` all fork per account. A conversation started on one account cannot be resumed on the other, and memory written under one is invisible to the other.

## How it works

Claude Code derives its keychain entry from a directory path:

```
slot = CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)
service = "Claude Code-credentials" + "-" + sha256(slot).hex.slice(0, 8)
```

`CLAUDE_SECURESTORAGE_CONFIG_DIR` selects the credential slot **independently of** `CLAUDE_CONFIG_DIR`. So this extension changes only that one variable and leaves `CLAUDE_CONFIG_DIR` unset:

| | value |
|---|---|
| `CLAUDE_CONFIG_DIR` | *unset* — data stays in `~/.claude`, config in `~/.claude.json`, shared by every account |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | `~/.claude-pro1` \| `~/.claude-pro2` — the only thing that changes |

No symlinks. No file moves. No re-login. Each account signs in once through Claude Code's own `/login`, and its token stays in the keychain where Claude Code put it.

Switching is picked up the next time a Claude process starts, because the official extension reads its `claudeCode.environmentVariables` setting at spawn time rather than caching it. **Conversations already running keep their own process, and therefore their own account.**

### The one wrinkle

Because `~/.claude.json` is shared, it caches whichever account was last active — `oauthAccount` (email, account UUID, org) and quota caches like `cachedUsageUtilization`. After a switch the token is account B while that cache still says account A, until Claude Code refetches. So on every switch this extension also swaps that account-scoped slice of `~/.claude.json` from a per-profile snapshot, keeping a timestamped backup in `~/.claude-accounts/backups/`.

Those fields are identity metadata and cached numbers. **They are not credentials, and this extension never touches credentials.**

### Remote Control binds a conversation to one account

When Remote Control (the claude.ai/code bridge) is active for a conversation, that conversation's session lives on Anthropic's servers **owned by the account that started it**. Switching the local credential slot cannot move it: resuming a bridge session under the other account makes the native binary report `account_mismatch`, and it stays with its owner. A server-side default currently starts Remote Control for every session, so by default *every* conversation is account-bound.

If you want to start work on one subscription and continue it on the other, run **`Account Lanes: Disable Remote Control Autostart`**. It writes `"remoteControlAtStartup": false` into `~/.claude/settings.json` (one file, shared by both accounts). New conversations then start as plain local sessions, which resume under either account with full history and shared memory. You can still turn Remote Control on by hand for a specific session when you need it.

Conversations that were *already* created as bridge sessions still resume cross-account for their text — you just will not get Remote Control revived on them under the other account.

## Usage

| Command | What it does |
|---|---|
| `Account Lanes: Run Setup` | Finds existing `~/.claude-*` directories and registers them as slots |
| `Account Lanes: Switch Account` | Picker; also bound to the status bar item |
| `Account Lanes: Add Account Slot` | Registers a slot by path, for an account you have not signed into yet |
| `Account Lanes: Diagnose` | Health report: shared paths, slot → keychain name mapping, stale caches |
| `Account Lanes: Reset (restore defaults)` | Removes the environment entry; Claude Code returns to its pre-install behaviour |
| `Account Lanes: Disable Remote Control Autostart` | Sets `remoteControlAtStartup: false` so new conversations are not account-bound (see below) |

The status bar shows the account the **next** conversation will use, plus the last observed quota. Its tooltip always states how old that number is — see below for why it cannot be live.

## Scope, and why it stops there

Claude Code's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page sets three limits that shaped this design:

- **"The Claude Code binary must not be modified."**
  This extension only reads the official extension's files, to understand how it resolves paths. It patches nothing and proxies nothing.

- **"Developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."**
  There is no keychain access anywhere in this codebase, and no token ever enters `profiles.json`. Adding an account never asks for a password; it registers a directory path and tells you to run `/login`.

- **"Advertised usage limits for Pro and Max plans assume ordinary, individual usage."**
  There is **no automatic rotation on rate limit**, by design. You switch when you decide to. For the same reason the extension never queries Anthropic's usage endpoint: reporting an inactive account's live quota would require holding that account's token. It shows only what Claude Code itself cached while that account was active, labelled with its age.

Holding more than one subscription that you pay for and use yourself is not what those terms prohibit. Sharing credentials, reselling access, or routing other people's usage through your plan is — and none of that is what this tool does.

## Requirements

- macOS or Linux
- VS Code 1.94+
- The official `anthropic.claude-code` extension
- Each account already signed in once via `CLAUDE_CONFIG_DIR=<slot> claude` + `/login`, or via this extension's Add Account flow

## Install

Not published to the VS Code Marketplace. Build a `.vsix` and sideload it:

```bash
git clone https://github.com/whi02/double-claude.git
cd double-claude
npm install
npm run package               # produces double-claude-<version>.vsix
code --install-extension double-claude-*.vsix
```

Reload VS Code, then run `Account Lanes: Run Setup` from the command palette.

## Development

```bash
npm install
npm run watch     # then F5 in VS Code to open an Extension Development Host
npm run check     # typecheck + compliance audit + tests
npm run package   # produces a .vsix
```

`npm run test` runs against a temporary `HOME`, so it never touches your real Claude Code state.

`npm run audit:compliance` enforces the three limits above against the actual source — no credential access, no shelling out, no network calls, no writes into the official extension. It self-tests against known-bad and known-good fixtures on every run, so a gate that has stopped detecting anything fails instead of passing quietly.

## Status

A personal project, solo-maintained. Issues are welcome, but treat this as best-effort rather than a supported product — no SLA on response time, and pull requests may sit unreviewed for a while.

## License

MIT
