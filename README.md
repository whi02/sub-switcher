# SubSwitcher

VS Code 안에서 로그아웃 없이 **본인 소유의** Claude 구독을 전환합니다. 어떤 계정을 쓰든 대화 기록, 메모리, 설정은 항상 공유됩니다.

> Anthropic과 제휴하거나 Anthropic이 만든 확장이 아닙니다. 공식 Claude Code 확장과 함께 동작하며, 이를 수정하지 않습니다.

## 문제 상황

Claude 구독을 두 개 이상 가지고 있다면, 보통은 셸 alias로 전환합니다.

```bash
alias claude2='CLAUDE_CONFIG_DIR=~/.claude-pro2 claude'
```

이 방식에는 두 가지 대가가 따릅니다.

1. **VS Code 확장에는 적용되지 않습니다.** UI에는 계정 선택기가 없습니다 ([anthropics/claude-code#55621](https://github.com/anthropics/claude-code/issues/55621)).
2. **기록이 분리됩니다.** `CLAUDE_CONFIG_DIR`은 데이터 디렉터리 전체를 옮기기 때문에, `projects/`(세션 트랜스크립트와 `memory/` 모두), `history.jsonl`, `CLAUDE.md`, `settings.json`, `plugins/`가 계정마다 따로 갈라집니다. 한 계정에서 시작한 대화는 다른 계정에서 이어갈 수 없고, 한쪽에 기록된 메모리는 다른 쪽에서 보이지 않습니다.

## 동작 원리

Claude Code는 디렉터리 경로로부터 키체인 항목을 도출합니다.

```
slot = CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)
service = "Claude Code-credentials" + "-" + sha256(slot).hex.slice(0, 8)
```

`CLAUDE_SECURESTORAGE_CONFIG_DIR`은 `CLAUDE_CONFIG_DIR`과 **독립적으로** 자격 증명 슬롯을 선택합니다. 그래서 이 확장은 이 변수 하나만 바꾸고 `CLAUDE_CONFIG_DIR`은 건드리지 않습니다.

| | 값 |
|---|---|
| `CLAUDE_CONFIG_DIR` | *설정하지 않음* — 데이터는 `~/.claude`, 설정은 `~/.claude.json`에 남아 모든 계정이 공유 |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | `~/.claude-pro1` \| `~/.claude-pro2` — 유일하게 바뀌는 값 |

심볼릭 링크도, 파일 이동도, 재로그인도 없습니다. 각 계정은 Claude Code 자체의 `/login`을 통해 한 번만 로그인하며, 토큰은 Claude Code가 넣어둔 그대로 키체인에 남습니다.

전환은 다음번에 Claude 프로세스가 시작될 때 적용됩니다. 공식 확장이 `claudeCode.environmentVariables` 설정을 캐싱하지 않고 프로세스를 띄우는 시점에 읽기 때문입니다. **이미 실행 중인 대화는 자신의 프로세스, 즉 자신의 계정을 그대로 유지합니다.**

### 한 가지 유의할 점

`~/.claude.json`은 공유되기 때문에 마지막으로 활성화됐던 계정의 정보 — `oauthAccount`(이메일, 계정 UUID, 조직)와 `cachedUsageUtilization` 같은 할당량 캐시 — 를 그대로 담고 있습니다. 전환 직후에는 토큰은 계정 B인데 이 캐시는 여전히 계정 A를 가리키는 상태가, Claude Code가 다시 가져올 때까지 이어집니다. 그래서 이 확장은 전환할 때마다 `~/.claude.json`의 그 계정 관련 부분을 프로필별 스냅샷으로 교체하고, 타임스탬프가 찍힌 백업을 `~/.claude-accounts/backups/`에 남깁니다.

이 필드들은 신원 메타데이터와 캐시된 숫자일 뿐입니다. **자격 증명이 아니며, 이 확장은 자격 증명을 건드리지 않습니다.**

### Remote Control은 대화를 한 계정에 묶습니다

Remote Control(claude.ai/code 브리지)이 어떤 대화에 대해 활성화되어 있으면, 그 대화의 세션은 **그 대화를 시작한 계정 소유**로 Anthropic 서버에 존재합니다. 로컬 자격 증명 슬롯을 바꿔도 이 세션은 옮겨지지 않습니다. 다른 계정으로 브리지 세션을 재개하려 하면 네이티브 바이너리가 `account_mismatch`를 반환하고, 세션은 원래 소유자에게 남습니다. 서버 기본값이 현재 모든 세션에서 Remote Control을 자동 시작하므로, 기본적으로는 *모든* 대화가 계정에 묶입니다.

한쪽 구독에서 시작한 작업을 다른 쪽에서 이어가고 싶다면 **`SubSwitcher: Disable Remote Control Autostart`**를 실행하세요. `~/.claude/settings.json`(두 계정이 공유하는 파일 하나)에 `"remoteControlAtStartup": false`를 기록합니다. 이후 새 대화는 일반 로컬 세션으로 시작되어, 전체 기록과 공유 메모리를 유지한 채 어느 계정에서든 재개할 수 있습니다. 필요할 때는 특정 세션에 대해 Remote Control을 수동으로 켤 수도 있습니다.

이미 브리지 세션으로 생성된 대화는 텍스트 자체는 여전히 계정 간에 재개되지만, 다른 계정에서는 그 대화에 Remote Control이 다시 살아나지 않습니다.

## 사용법

| 명령 | 동작 |
|---|---|
| `SubSwitcher: Run Setup` | 기존 `~/.claude-*` 디렉터리를 찾아 슬롯으로 등록 |
| `SubSwitcher: Switch Account` | 선택기 표시. 상태 표시줄 항목에도 연결되어 있음 |
| `SubSwitcher: Add Account Slot` | 아직 로그인하지 않은 계정을 경로로 슬롯 등록 |
| `SubSwitcher: Diagnose` | 상태 점검 보고서: 공유 경로, 슬롯 → 키체인 이름 매핑, 오래된 캐시 |
| `SubSwitcher: Reset (restore defaults)` | 환경 변수 항목 제거. Claude Code가 설치 전 동작으로 돌아감 |
| `SubSwitcher: Disable Remote Control Autostart` | `remoteControlAtStartup: false`를 설정해 새 대화가 계정에 묶이지 않도록 함 (위 설명 참고) |

상태 표시줄은 **다음** 대화가 사용할 계정과 마지막으로 관측된 할당량을 보여줍니다. 툴팁에는 그 숫자가 얼마나 오래됐는지 항상 표시되는데, 왜 실시간일 수 없는지는 아래에서 설명합니다.

## 범위, 그리고 그 이유

Claude Code의 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) 페이지가 정한 세 가지 제한이 이 설계를 결정했습니다.

- **"Claude Code 바이너리를 수정해서는 안 된다."**
  이 확장은 공식 확장이 경로를 어떻게 해석하는지 이해하기 위해 그 파일들을 읽기만 합니다. 아무것도 패치하지 않고, 아무것도 프록시하지 않습니다.

- **"개발자는 Claude.ai 자격 증명이나 세션 토큰을 수집·저장·중개할 수 없다 — 계정 로그인은 반드시 Anthropic 자체 흐름을 통해 완료되어야 한다."**
  이 코드베이스 어디에도 키체인 접근이 없고, `profiles.json`에는 토큰이 절대 들어가지 않습니다. 계정을 추가할 때 비밀번호를 묻는 일은 없습니다. 디렉터리 경로를 등록하고 `/login`을 실행하라고 안내할 뿐입니다.

- **"Pro와 Max 플랜에 광고된 사용량 한도는 통상적인 개인 사용을 전제로 한다."**
  설계상 **속도 제한 시 자동 전환은 없습니다.** 전환은 사용자가 결정할 때만 일어납니다. 같은 이유로 이 확장은 Anthropic의 사용량 엔드포인트를 절대 조회하지 않습니다. 비활성 계정의 실시간 할당량을 보여주려면 그 계정의 토큰을 쥐고 있어야 하기 때문입니다. 표시되는 것은 그 계정이 활성 상태였을 때 Claude Code 자체가 캐싱해둔 값뿐이며, 얼마나 오래됐는지 함께 표시됩니다.

본인이 비용을 지불하고 본인이 쓰는 구독을 여러 개 갖는 것은 이 약관이 금지하는 것이 아닙니다. 자격 증명을 공유하거나, 접근권을 재판매하거나, 다른 사람의 사용량을 본인 플랜으로 우회시키는 것이 금지 대상이며, 이 도구는 그런 일을 하지 않습니다.

## 요구 사항

- macOS 또는 Linux
- VS Code 1.94+
- 공식 `anthropic.claude-code` 확장
- `CLAUDE_CONFIG_DIR=<slot> claude` + `/login`으로, 또는 이 확장의 Add Account 흐름으로 각 계정을 한 번씩 로그인해둔 상태

## 설치

VS Code 마켓플레이스에는 등록되어 있지 않습니다. `.vsix`를 빌드해서 사이드로드하세요.

```bash
git clone https://github.com/whi02/sub-switcher.git
cd sub-switcher
npm install
npm run package               # sub-switcher-<version>.vsix 생성
code --install-extension sub-switcher-*.vsix
```

VS Code를 다시 로드한 뒤, 커맨드 팔레트에서 `SubSwitcher: Run Setup`을 실행하세요.

## 개발

```bash
npm install
npm run watch     # 이후 VS Code에서 F5로 Extension Development Host 실행
npm run check     # 타입체크 + 컴플라이언스 감사 + 테스트
npm run package   # .vsix 생성
```

`npm run test`는 임시 `HOME`을 대상으로 실행되므로, 실제 Claude Code 상태를 건드리지 않습니다.

`npm run audit:compliance`는 위 세 가지 제한을 실제 소스 코드에 대해 강제합니다 — 자격 증명 접근 없음, 셸 실행 없음, 네트워크 호출 없음, 공식 확장에 대한 쓰기 없음. 매 실행마다 알려진 정상/비정상 픽스처로 자체 테스트를 수행하므로, 탐지 기능이 멈춘 게이트는 조용히 통과하는 대신 실패합니다.

## 상태

개인 프로젝트이며 혼자 유지보수합니다. 이슈는 환영하지만, 지원되는 제품이 아니라 최선을 다하는 수준으로 봐주세요 — 응답 시간에 대한 SLA는 없고, PR이 한동안 리뷰되지 않은 채 남아 있을 수 있습니다.

## 라이선스

MIT
