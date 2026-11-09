# Windows compatibility audit

Audited 2026-11-09/10 on Windows 11 Pro x64, build 26200. Fork base:
`a4d24398329336a021afc386cb93678da34b8995`; upstream/main and local main:
`0361bf4d4c53c993e5df80f1e7a2b6e9eb8a3538`. All 50 changed files were
reviewed. Local fixes: `35f1f6fb908a9bec157b734ff3103cf4c295ccbd` on
`codex/windows-compat`. No pushes, tags, releases, Actions dispatches or app
launches were performed.

## Environment and commands

Bun 1.2.21 (`7c45ed97`), Node 24.22.0, npm 11.19.1, Rust 1.97.1,
Cargo 1.97.1, Tauri CLI 2.11.4. Rust target: `x86_64-pc-windows-msvc`.
Every Cargo invocation used `CARGO_TARGET_DIR=E:\proj\.cargo-target\aliasmode`
and four build jobs. Git has `core.autocrlf=true`.

| Command | Result |
| --- | --- |
| `git fetch origin`; create `codex/windows-compat` from the requested fork | Pass; main and upstream untouched |
| `npm install -g bun@1.2.21` | Default npm mirror returned HTTP 500; official registry installation completed. Its empty executable was replaced with the same version's official `@oven/bun-windows-x64` package executable. |
| `bun install --frozen-lockfile` | Pass; 169 installs / 185 packages; lockfile unchanged |
| `bun run typecheck` | Pass before and after fixes; no diagnostics |
| Original `bun test` | 2067 pass, 30 skip, 9 fail; 111 files, 123.75 seconds |
| Each failing Bun file, separately on fork | All 9 failures reproduced; no timing failures |
| Six existing failing files, separately on detached upstream/main | Same 8 failures; returned to working branch afterwards |
| Final `bun test` | **2077 pass, 30 skip, 0 fail**; 111 files, 127.38 seconds |
| Initial `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -j 4` | Blocked by unprepared sidecar bundle resource; not a source compilation failure |
| `bun run desktop:prepare` | Pass with real, hash-verified Firefox and official Node; real compiled Bun baseline sidecar |
| Same `cargo check`, after prepare | Pass; one dead-code warning in chooser-owned code |
| Original `cargo test --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -j 4` | Library: 69 pass / 4 fail, all in new browser-order tests |
| Same command with `--lib browser_order::tests` | 1 pass / 4 fail; reproduced separately |
| Final full `cargo test` | **74 pass, 0 fail**: 73 library tests and 1 MCP launcher test; empty main/doc-test suites also pass |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets -j 4` | Pass; 2 warnings, detailed below; no `-D warnings` claim |
| `bun run docs:public:check` | Pass after preserving generated JSON bytes with LF |
| `bun run desktop:build:nsis` | **Pass**, full offline NSIS installer; Release compilation 4m45s; unsigned as requested |

PowerShell's npm-generated Bun wrapper also failed once while redirecting test
output. All counted test runs used the actual Bun 1.2.21 executable with its
directory first on PATH; the failed wrapper invocation was not counted as a
successful test run. Logs are retained locally under `reports/windows-compat/`
(ignored by Git), named `aliasmode-windows-*.log`.

## Failure attribution and fixes

| Failure | Attribution and evidence | Fix |
| --- | --- | --- |
| `url-router-native.test.ts:38`, one assertion | Fork-added, consistently fails because a multiline LF string is searched in CRLF Rust source. File absent on upstream. | Normalize inspected source line endings. |
| `dashboard-ui.test.ts:1070`, one Services assertion | Pre-existing upstream; same isolated failure at 0361bf4. | Normalize inspected Services source. |
| `version.test.ts:161`, one workflow assertion | Pre-existing upstream; same isolated failure at 0361bf4. This is CRLF, not `.mod2` parsing. | Normalize inspected workflow and acceptance source. |
| `web/i18n.test.ts:21`, one catalog assertion | Pre-existing upstream; multiline English key differs from CRLF source. Same isolated upstream failure. | Normalize inspected source. |
| `web/store.test.tsx:915` and `:981` | Two pre-existing multiline source assertions; both fail identically on upstream. | Normalize inspected app source. |
| `scripts/generate-public-docs.test.ts:153` and `:181` | Two pre-existing upstream failures: CRLF changes deterministic serialized bytes and SHA-256. | `docs/public/.gitattributes:2` pins JSON to LF; existing tests now verify the actual bytes without relaxing hashes. |
| `scripts/prepare-windows-bundle.test.ts:64` | Pre-existing upstream multiline Cargo source assertion; same isolated upstream failure. | Normalize inspected Cargo source. |
| Four `browser_order::tests`, original lines 137, 154, 175, 205 | Fork-added Windows-incompatible fixtures use `/Applications/...`, which is not absolute on Windows. Entire module absent upstream. Isolated run reproduced all four. | `src-tauri/src/browser_order.rs:128` builds absolute paths using the host temp directory, including byte-limit and Unicode checks. Production validator unchanged. |

All fixes above are in `35f1f6f`. No observed failures were classified as flaky.
Another agent shared the machine and Cargo target directory; lock waits occurred.
Timing-sensitive Bun tests passed, so CPU contention was not used to explain away
any failure.

## Ranked audit findings

1. **High: HTTP(S) argv can permanently intercept Windows native Close.**
   `src-tauri/src/lib.rs:487` unconditionally queues URL arguments from a second
   instance; `:495` suppresses ordinary reveal. `url_inbox.rs:59` keeps returning
   `Dismiss(id)` without consuming it. `shutdown.rs:178` intercepts Close, while
   `web/url-router.tsx:66` disables the only listener/poller on Windows. This
   affects titlebar Close and Alt+F4 after the first valid queued URL, including
   a hidden background manager that then cannot be revealed by that URL launch.
   Invalid HTTP-prefixed arguments can suppress reveal even without queuing.
   **Proposed for chooser agent, not edited:** gate URL intake/reveal suppression
   to macOS and make non-macOS chooser-close handling return false. Keep normal
   Windows single-instance reveal/cleanup intact and test URL-bearing second
   launches on a non-macOS platform.

2. **Medium, documented behavior: accepting an upstream update replaces this
   fork.** `src-tauri/src/releases.rs:18` still reads the upstream feed, and
   `:200` compares ordinary SemVer within the first prerelease channel (`beta`).
   Thus beta.74 < beta.74.mod2 < beta.75, and a newer beta or stable upstream
   release can be offered. `web/app.tsx:2134` automatically checks; `:3846` and
   `:4656` require clicking **Update now** to install. There is no silent automatic
   install. Unchanged: README already documents this policy; no new update feed
   or opt-out was introduced by this audit. Live release availability and an
   actual update installation were not tested.

3. **Low: untranslated fingerprint controls in Chinese on Windows too.**
   `web/app.tsx:5198` previously bypassed translation; the create label/help also
   lacked zh-CN entries. Fixed in `35f1f6f`, with a regression test in
   `web/i18n.test.ts:29`. Existing `Dismiss` -> `忽略` is a wording change, not a
   functional Windows regression. No screenshot or browser test was run.

4. **Low: new compiler warning on non-macOS.**
   `src-tauri/src/url_router.rs:478` leaves `DefaultBrowserStatus::new` unused in
   Windows production builds. No functional impact; chooser-owned, not edited.
   Clippy also reports `items_after_test_module` at `lib.rs:271`; the test-module
   layout predates this fork. Both commands exit successfully without warnings
   being promoted to errors.

The CRLF failures and macOS-only fixtures above degrade Windows development and
verification rather than the installed app's browser lifecycle; both are fixed.

## URL-bearing Windows entry paths

- **Direct command, custom shortcut, user-added handler, external launcher:**
  `aliasmode.exe https://example.com` while another instance runs deterministically
  reaches the problematic callback. Plausible for a fork advertised as a chooser;
  no default Windows handler is registered by this fork. A first/cold Windows
  launch ignores the URL instead: startup argv are only parsed for background,
  import and updater flags, not fed to this queue.
- **Stock Desktop/Start menu shortcuts:** `installer.nsi:950`, `:953`, `:977`
  supply no arguments, so normal launches keep reveal and Close behavior.
- **Installer finish/relaunch:** `installer.nsi:422` supplies no arguments.
  Passive `/R /ARGS` at `:752` can pass a manually supplied URL, but normal
  updater code supplies only a handoff marker (`releases.rs:363`,
  `update_attempt.rs:48`). Installer hooks add no URL arguments. The NSIS deep-link
  template at `:672` has no configured Windows protocols to expand.
- **Cloakpit import:** `lib.rs:213` accepts directory arguments as `PathBuf` and
  does not validate a bare URL as a directory until later. A mistaken
  `--import-cloakpit https://...` on a second instance still queues that URL
  before import handling; ordinary valid Windows directory paths do not match
  the HTTP prefix. Second-instance import was already not processed upstream.
- **MCP and CLI:** `agent/runtime-client.mjs:298` starts the desktop with only
  `--background`; the MCP Rust launcher forwards client arguments to the sidecar,
  not the desktop URL router. Browser URL arguments target managed engines.
- **Mode-change/failure restart:** Tauri restart may preserve startup args, but
  normal restart exits the original manager and creates a cold first instance;
  no new URL is synthesized. A URL-bearing restart handed to a surviving second
  manager would need the same nonstandard URL-bearing invocation as above.

## Other Windows paths checked

- `launcher.ts:1106` creates the Dock badge coordinator only on `darwin`; all
  refresh calls return before invoking a setter on Windows (`:1679`). No badge
  WebSocket/CDP connection or timer is created there, even with the opt-in field.
  Firefox and headless exclusions also have passing tests.
- `random-fingerprint.ts:14` reuses the existing host-screen policy; Windows
  Chromium 155 scale handling is retained (`create.ts:68`,
  `aliasmode-chromium.ts:247`). CloakBrowser redraws its existing 8-24-core
  catalog (not host-capped, as upstream); Firefox is capped by
  `firefox-config.ts:322`. Chromium 155 removes a stale CPU override and delegates
  the hardware draw/host limits to its engine. Existing unsupported-host,
  macOS-persona-on-Windows and DPAPI checks remain. Fresh launch is the only
  rotation path; reattach, concurrent starts and persistent directories are
  covered by tests. No real-engine hardware/screen measurement is claimed.
- `store.ts:80` adds a default-zero column, preserving existing data; true is
  optional and existing profiles stay off. `profile-validation.ts:66` accepts
  only booleans when present, without rejecting unrelated unknown fields. The
  Cloud portable encoder (`portable-profile.ts:42`) does not serialize this
  local-only flag, so it cannot cause an upstream Cloud unknown-field rejection;
  it also does not survive a Cloud/portable round-trip. No server schema changed.
- `web/app.tsx:4403` hides Browser routing settings outside macOS native shells;
  default settings selection remains Account. Fingerprint rotation is purposely
  cross-platform and opt-in; Cloud creation/edit does not send the local choice.
- `tempfile` is now a production dependency for atomic browser-order saves and
  compiles on Windows. Objective-C dependencies are target-gated. Info.plist and
  the added artifact-only ARM64 workflow do not change Windows bundling/jobs.

## Packaging and verification boundary

The full offline NSIS installer built successfully at:

`E:\proj\.cargo-target\aliasmode\release\bundle\nsis\AliasMode_0.1.0-beta.74.mod2_x64-setup.exe`

An identical copy is retained under `reports/windows-compat/` in this worktree.
Size: **477,408,427 bytes**. SHA-256:

`8eb8a3d43085b449ab87dc6da4e9efd48e652b8ed1b8697067d989050c860912`

The main executable has PE machine `0x8664` (x64); the NSIS bootstrapper is
`0x014c` (the expected 32-bit installer stub). Both PE version strings are
`0.1.0-beta.74.mod2`. The generated NSIS script has
`VERSIONWITHBUILD "0.1.0.0"` for its numeric `VIProductVersion`, while retaining
the complete prerelease string for FileVersion/ProductVersion. Thus `.mod2`
does not prevent Windows resource generation, Release linking or NSIS bundling.
`--no-sign` skips updater signatures; this is a local unsigned build, not a
published/signed release. The generated NSIS script also contains no expanded
HTTP/HTTPS protocol registrations.

The build uses the real Firefox archive pinned by the source (archive SHA-256
`23d2531f5a72dbfde049319259bcee55407a2ba7afc570398446da5c1f20cfcb`,
executable SHA-256
`1a031ad448359f65b299634dd6fd0027c556f4c7807c2e0fb17f48a76fba7337`),
the official pinned Node 22.23.2 bundle, and a Bun Windows x64 baseline sidecar.

The 30 skipped Bun tests include platform-gated/opt-in real-browser integration
tests. The app was not launched, installed, or pointed at the real user's data.
Native titlebar behavior is established from source/queue tests rather than a
running packaged WebView. Real Chromium/Firefox fingerprint output, display/DPI
changes, Windows installer install/uninstall, and live Cloud/update services
remain unverified. No macOS runtime claim is made.
