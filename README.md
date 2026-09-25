# SubSwitcher

한국어 | [English](README.en.md)

VS Code에서 로그아웃 없이 **본인 소유의** Claude·Codex 계정을 전환합니다.

> Anthropic이나 OpenAI와 무관한 개인 프로젝트입니다. 공식 Claude Code 확장, Codex 확장과 함께 동작하며 어느 쪽도 수정하지 않습니다.

| | Claude Code | Codex |
|---|---|---|
| 바뀌는 것 | 자격 증명 슬롯만 | `CODEX_HOME` 전체 |
| 대화 기록·메모리 | 계정끼리 공유 | 계정마다 분리 |
| 적용 시점 | 다음 대화부터 | 창을 다시 로드한 뒤 |

## Claude 계정 전환

구독이 두 개 이상이면 보통 셸 alias로 바꿉니다.

```bash
alias claude2='CLAUDE_CONFIG_DIR=~/.claude-pro2 claude'
```

여기에는 두 가지 문제가 있습니다. VS Code 확장에는 계정 선택기가 없습니다([anthropics/claude-code#55621](https://github.com/anthropics/claude-code/issues/55621)). `CLAUDE_CONFIG_DIR`은 데이터 디렉터리를 통째로 옮기기 때문에 대화 기록과 메모리가 계정마다 갈라집니다.

Claude Code는 키체인 항목 이름을 디렉터리 경로에서 만듭니다.

```
slot    = CLAUDE_SECURESTORAGE_CONFIG_DIR ?? (CLAUDE_CONFIG_DIR ?? ~/.claude)
service = "Claude Code-credentials-" + sha256(slot)[:8]
```

`CLAUDE_SECURESTORAGE_CONFIG_DIR`은 `CLAUDE_CONFIG_DIR`과 따로 움직입니다. 그래서 이 변수 하나만 바꾸면 자격 증명만 갈아끼우고 데이터는 `~/.claude`에 그대로 둘 수 있습니다. 심볼릭 링크도, 파일 이동도, 재로그인도 없습니다.

공식 확장은 Claude 프로세스를 띄울 때 이 설정을 읽습니다. 그래서 **새로 시작하는 대화부터** 계정이 바뀌고 실행 중인 대화는 원래 계정을 유지합니다.

**공유 설정 파일.** `~/.claude.json`에는 마지막으로 쓴 계정의 이메일과 사용량 캐시가 남습니다. 전환할 때 이 부분만 계정별 스냅샷으로 바꾸고 백업을 `~/.claude-accounts/backups/`에 남깁니다. 자격 증명은 여기에 들어 있지 않습니다.

**Remote Control 주의.** Remote Control로 시작한 대화는 서버에서 그 대화를 만든 계정에 묶입니다. 계정을 넘나들며 이어서 작업하려면 `SubSwitcher: Disable Remote Control Autostart`를 실행하세요. 이후 새 대화는 어느 계정에서나 이어집니다.

**업무 계정과 개인 계정.** 기록을 공유하므로 Team·Enterprise 계정에서 시작한 대화를 개인 Pro·Max 계정에서 이어갈 수 있습니다. 이때 이전 대화 내용도 개인 계정의 요청에 실려 전송됩니다. Team·Enterprise는 [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)를 따르고 Anthropic은 그 내용으로 모델을 학습할 수 없습니다. 개인 구독은 [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)를 따르고 학습 거부를 하지 않았다면 대화가 학습에 쓰일 수 있습니다. 회사 코드가 담긴 대화라면 개인 계정에서 이어가기 전에 회사 정책을 확인하세요.

## Codex 계정 전환

Codex에는 자격 증명 위치만 고르는 변수가 없습니다. 로그인 정보는 파일이든 키체인이든 `CODEX_HOME` 경로를 기준으로 갈리고 설정·세션·메모리도 같은 디렉터리에 들어갑니다. 그래서 계정 하나가 곧 `CODEX_HOME` 하나입니다.

| 슬롯 | `CODEX_HOME` |
|---|---|
| 기본 | 설정하지 않음 → Codex 기본값 `~/.codex` |
| 추가 계정 | `~/.codex-work`처럼 계정마다 따로 |

- **기록이 분리됩니다.** 한 계정에서 나눈 Codex 대화는 다른 계정에서 보이지 않습니다.
- **창을 다시 로드해야 합니다.** Codex 확장에는 환경 변수 설정이 없어서 창이 열릴 때 확장 환경에 `CODEX_HOME`을 넣는 방식으로 동작합니다. Codex의 app-server는 창이 열려 있는 동안 계속 실행됩니다. 그래서 전환하면 창을 다시 로드해야 하고 그 창에서 하던 작업은 중단됩니다. 다른 창은 각자 다시 로드할 때 바뀝니다.
- **바뀌는 건 VS Code 확장뿐입니다.** 터미널에서 쓰는 `codex` CLI와 ChatGPT 데스크톱 앱은 계속 `~/.codex`를 씁니다.
- **로그인은 Codex에서 합니다.** 새 슬롯으로 바꾸고 창을 다시 로드하면 Codex 사이드바가 로그인을 요청합니다.

셸 설정에서 `CODEX_HOME`을 직접 export 해 두었다면 그 값이 우선할 수 있습니다. 창이 실제로 쓰는 값은 `SubSwitcher: Diagnose`에서 확인하세요.

## 명령

| 명령 | 하는 일 |
|---|---|
| `SubSwitcher: Run Setup` | `~/.claude-*` 디렉터리를 찾아 Claude 슬롯으로 등록 |
| `SubSwitcher: Switch Account` | Claude 계정 선택기 (상태 표시줄에서도 열립니다) |
| `SubSwitcher: Add Account Slot` | 아직 로그인하지 않은 Claude 계정을 경로로 등록 |
| `SubSwitcher: Switch Codex Account` | Codex 계정 선택기 (처음 실행하면 `~/.codex*`를 찾아 등록) |
| `SubSwitcher: Add Codex Account Slot` | 새 `CODEX_HOME`을 Codex 슬롯으로 등록 |
| `SubSwitcher: Diagnose` | 상태 점검: 공유 경로, 슬롯 목록, 지금 적용된 계정 |
| `SubSwitcher: Disable Remote Control Autostart` | 새 대화가 계정에 묶이지 않게 설정 |
| `SubSwitcher: Reset (restore defaults)` | Claude 환경 설정을 지우고 설치 전 상태로 |

상태 표시줄에는 다음 대화가 쓸 Claude 계정과 마지막으로 관측된 사용량이 나옵니다. 사용량은 `subSwitcher.showUsage`를 끄면 상태 표시줄과 계정 선택기에서 모두 사라집니다. Codex 슬롯을 등록하면 이 창의 Codex 계정도 따로 표시됩니다. 다시 로드해야 적용되는 전환이 남아 있으면 아이콘으로 알려줍니다.

## 범위와 약관

- **자격 증명을 다루지 않습니다.** 토큰을 읽거나 복사하지 않고 로그인은 Claude Code의 `/login`과 Codex 자체 화면에서만 합니다. `npm run audit:compliance`가 소스 코드에서 이를 검사합니다.
- **자동 전환이 없습니다.** 한도에 걸렸다고 알아서 계정을 바꾸지 않습니다.
- **사용량을 조회하지 않습니다.** 비활성 계정의 실시간 사용량을 보려면 그 계정의 토큰이 필요합니다. 그래서 Claude Code가 캐싱해 둔 값을 관측 시각과 함께 보여줄 뿐이고 Codex 사용량은 아예 표시하지 않습니다.
- **공식 문서에 없는 변수를 씁니다.** `CLAUDE_SECURESTORAGE_CONFIG_DIR`은 아직 Claude Code 문서에 나오지 않습니다([anthropics/claude-code#79223](https://github.com/anthropics/claude-code/issues/79223)). Claude Code 업데이트로 동작이 바뀌면 SubSwitcher가 따라갈 때까지 전환이 안 될 수 있습니다.

Pro·Max 같은 개인 구독에는 Anthropic의 [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)가 적용되고 Claude Code에는 [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)의 규정이 더해집니다. 이 확장과 관련된 내용은 세 가지입니다.

- 서드파티 도구는 Claude 자격 증명이나 세션 토큰을 수집·저장·중개할 수 없고 로그인은 Anthropic의 자체 흐름으로만 해야 합니다. SubSwitcher는 토큰에 손대지 않습니다. `/login`으로 로그인해 둔 슬롯을 공식 확장이 쓰도록 가리킬 뿐입니다.
- Pro·Max의 사용량 한도는 통상적인 개인 사용을 전제로 합니다.
- 계정 공유는 Consumer Terms가, 다른 계정으로 이용 정지를 피하는 행위는 [Usage Policy](https://www.anthropic.com/legal/aup)가 금지합니다.

이 문서들에 한 사람이 본인 구독을 여러 개 두는 것을 금지하는 조항은 없습니다. 다만 어떤 사용이 통상적인지는 Anthropic이 판단할 일이고 이 확장이 보장할 수 있는 부분이 아닙니다.

OpenAI의 [Terms of Use](https://openai.com/policies/terms-of-use/)는 계정 공유와 **사용량 한도·제한 우회**를 금지합니다. OpenAI도 ChatGPT에서 개인 계정과 업무 계정을 오가는 [계정 전환](https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching)을 지원하고, Codex 전환도 같은 용도로 만들었습니다. 한도를 피하려고 계정을 옮겨 다니는 용도로는 쓰지 마세요.

## 요구 사항

- macOS 또는 Linux, VS Code 1.94+
- 공식 확장 `anthropic.claude-code` (Codex 전환에는 `openai.chatgpt`도 필요)
- 계정마다 한 번씩 로그인 (Claude는 `/login`, Codex는 사이드바)

## 설치

마켓플레이스에는 없습니다. 직접 빌드해서 설치하세요.

```bash
git clone https://github.com/whi02/sub-switcher.git
cd sub-switcher
npm install
npm run package               # sub-switcher-<version>.vsix 생성
code --install-extension sub-switcher-*.vsix
```

VS Code를 다시 로드한 뒤 명령 팔레트에서 `SubSwitcher: Run Setup`을 실행하세요.

## 개발

```bash
npm install
npm run watch     # 이후 F5로 Extension Development Host 실행
npm run check     # 타입체크 + 컴플라이언스 감사 + 테스트
npm run package   # .vsix 생성
```

테스트는 임시 `HOME`에서 돌아가므로 실제 Claude·Codex 상태를 건드리지 않습니다. 컴플라이언스 감사는 자격 증명 접근, 셸 실행, 네트워크 호출, 공식 확장 쓰기를 소스에서 막습니다. 매번 정상·비정상 예제로 자체 검증을 하기 때문에 탐지가 멈추면 조용히 통과하지 않고 실패합니다.

## 상태

개인 프로젝트이고 혼자 관리합니다. 이슈는 환영하지만 지원되는 제품은 아니어서 응답이 늦을 수 있습니다.

## 라이선스

MIT
