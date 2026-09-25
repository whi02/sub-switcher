# SubSwitcher

[한국어](README.md) | English

Switch between **your own** Claude and Codex accounts inside VS Code, without signing out.

> A personal project, not affiliated with Anthropic or OpenAI. It works alongside the official Claude Code and Codex extensions and modifies neither.

| | Claude Code | Codex |
|---|---|---|
| What changes | the credential slot only | the whole `CODEX_HOME` |
| History and memory | shared across accounts | separate per account |
| Takes effect | on your next conversation | after you reload the window |

## Switching Claude accounts

With more than one subscription, the usual approach is a shell alias:

```bash
alias claude2='CLAUDE_CONFIG_DIR=~/.claude-pro2 claude'
```

That has two problems. The VS Code extension has no account picker ([anthropics/claude-code#55621](https://github.com/anthropics/claude-code/issues/55621)), and `CLAUDE_CONFIG_DIR` moves the entire data directory, so conversation history and memory fork per account.

Claude Code derives its keychain entry from a directory path:

```
slot    = CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)
service = "Claude Code-credentials-" + sha256(slot)[:8]
```

`CLAUDE_SECURESTORAGE_CONFIG_DIR` moves independently of `CLAUDE_CONFIG_DIR`. Changing just that one variable swaps the credentials while the data stays in `~/.claude`. No symlinks, no file moves, no re-login.

The official extension reads the setting when it spawns a Claude process, so a switch applies **to conversations you start next**. Conversations already running keep the account they began with.

**The shared config file.** `~/.claude.json` holds the last active account's email and quota caches. On each switch that slice is replaced from a per-profile snapshot, with a backup kept in `~/.claude-accounts/backups/`. No credentials live there.

**Remote Control caveat.** A conversation started with Remote Control is bound server-side to the account that created it. To carry work across accounts, run `SubSwitcher: Disable Remote Control Autostart`. New conversations then resume under either account.

**Work and personal accounts.** Because history is shared, a conversation started under a Team or Enterprise account can be resumed under a personal Pro or Max account, and the earlier transcript then goes out with that account's requests. Team and Enterprise use falls under the [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), which bar Anthropic from training on it. Personal plans fall under the [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), where conversations may be used for training unless you have opted out. If a conversation contains your employer's code, check its policy before resuming it on a personal account.

## Switching Codex accounts

Codex has no variable that selects credentials alone. Its sign-in — as a file or in the OS keychain — is keyed off `CODEX_HOME`, and config, sessions and memories live in that same directory. So one account means one `CODEX_HOME`.

| Slot | `CODEX_HOME` |
|---|---|
| Default | unset, so Codex uses `~/.codex` |
| Extra account | a directory of its own, such as `~/.codex-work` |

- **History is separate.** A Codex conversation started under one account is not visible under another.
- **You have to reload the window.** The Codex extension has no setting for environment variables, so SubSwitcher places `CODEX_HOME` in the extension environment as the window loads. Codex keeps its app-server running for the life of the window, so a switch needs a reload, and work in that window stops. Other windows change when you reload them.
- **Only the VS Code extension changes.** The `codex` CLI in a terminal and the ChatGPT desktop app keep using `~/.codex`.
- **You sign in through Codex.** After switching and reloading, the Codex sidebar asks you to sign in.

If your shell exports `CODEX_HOME` itself, that value may win. `SubSwitcher: Diagnose` shows which one the window actually uses.

## Commands

| Command | What it does |
|---|---|
| `SubSwitcher: Run Setup` | Finds `~/.claude-*` directories and registers them as Claude slots |
| `SubSwitcher: Switch Account` | Claude account picker, also on the status bar |
| `SubSwitcher: Add Account Slot` | Registers a Claude slot by path, for an account not signed in yet |
| `SubSwitcher: Switch Codex Account` | Codex account picker; the first run registers your `~/.codex*` directories |
| `SubSwitcher: Add Codex Account Slot` | Registers a new `CODEX_HOME` as a Codex slot |
| `SubSwitcher: Diagnose` | Health report: shared paths, registered slots, the account in effect |
| `SubSwitcher: Disable Remote Control Autostart` | Stops new conversations from being bound to one account |
| `SubSwitcher: Reset (restore defaults)` | Removes the Claude environment entry and returns to pre-install behaviour |

The status bar shows the Claude account your next conversation will use, plus its last observed quota. Turn off `subSwitcher.showUsage` to hide the numbers in both the status bar and the account picker. Register a Codex slot and the window's Codex account appears too, with an icon when a switch is still waiting for a reload.

## Scope, and why it stops there

- **It never handles credentials.** No token is read or copied; sign-in happens only through Claude Code's `/login` and Codex's own screen. `npm run audit:compliance` checks this against the source.
- **It never rotates accounts for you.** Hitting a limit does not trigger a switch.
- **It never queries usage.** Live numbers for an inactive account would require that account's token, so it shows only what Claude Code cached, labelled with when it was observed, and shows nothing at all for Codex.
- **It relies on an undocumented variable.** `CLAUDE_SECURESTORAGE_CONFIG_DIR` is not in Claude Code's documentation yet ([anthropics/claude-code#79223](https://github.com/anthropics/claude-code/issues/79223)). If a Claude Code update changes how it behaves, switching may stop working until SubSwitcher catches up.

Personal plans such as Pro and Max fall under Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), and Claude Code adds the rules on its [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page. Three of them bear on this extension:

- Third-party tools may not collect, store or intermediate Claude credentials or session tokens, and sign-in must complete through Anthropic's own flow. SubSwitcher never touches a token; it only points the official extension at a slot you signed into with `/login`.
- Usage limits for Pro and Max assume ordinary, individual usage.
- Sharing an account is forbidden by the Consumer Terms, and using another account to get around a ban by the [Usage Policy](https://www.anthropic.com/legal/aup).

None of these documents forbids one person from holding more than one subscription of their own. Whether a given pattern of use counts as ordinary is Anthropic's call, though, and not something this extension can promise.

OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/) forbid sharing an account and **circumventing rate limits or restrictions**. OpenAI itself supports [switching](https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching) between a personal and a work ChatGPT account, and Codex switching is built for the same purpose. Do not use it to move between accounts to get around a limit.

## Requirements

- macOS or Linux, VS Code 1.94+
- The official `anthropic.claude-code` extension (plus `openai.chatgpt` for Codex switching)
- Each account signed in once: `/login` for Claude, the sidebar for Codex

## Install

Not on the Marketplace. Build it and sideload:

```bash
git clone https://github.com/whi02/sub-switcher.git
cd sub-switcher
npm install
npm run package               # produces sub-switcher-<version>.vsix
code --install-extension sub-switcher-*.vsix
```

Reload VS Code, then run `SubSwitcher: Run Setup` from the command palette.

## Development

```bash
npm install
npm run watch     # then F5 for an Extension Development Host
npm run check     # typecheck + compliance audit + tests
npm run package   # produces a .vsix
```

Tests run against a temporary `HOME`, so they never touch your real Claude or Codex state. The compliance audit blocks credential access, shelling out, network calls and writes into the official extensions. It self-tests against known-good and known-bad fixtures on every run, so a gate that has stopped detecting anything fails instead of passing quietly.

## Status

A personal project, solo-maintained. Issues are welcome, but this is best-effort rather than a supported product, so replies may take a while.

## License

MIT
