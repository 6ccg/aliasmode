# Persistent per-Profile Dock launchers: design, not a released feature

**Status:** only an unwired TypeScript planning and validation module exists. There is no launcher executable, installer, native IPC endpoint, UI toggle, or registered URL scheme. Nothing creates or pins an application, starts a profile, or changes a browser runtime. macOS implementation and real-device verification are paused. Linux tests do not demonstrate working Dock behavior.

## Two distinct outcomes

- **A. A permanent per-Profile launch entry.** A small `.app` remains on disk after the browser exits. The user can keep it in the Dock and click it to open or focus exactly that Profile. The running browser may have a separate Dock icon. This is the proposed practical first milestone, not implemented yet.
- **B. One permanent tile that also owns that Profile's running windows.** Clicking, the running indicator, window menus, Quit, Mission Control, and relaunch all belong to that same tile. A short-lived launcher, a stable bundle ID, or a runtime badge does not establish this. It needs a proven native app shim/browser integration and testing for each supported engine. It is neither implemented nor guaranteed by this design.

`Browser.setDockTile` changes a running browser's presentation. It does not install a durable application or define what a later Dock click launches. Keeping a helper alive also does not transfer another process's browser windows to it. Do not describe either technique as outcome B.

No part of this proposal copies an installed browser per Profile, rewrites its bundle identifier, modifies its resources, changes its signature, or bypasses Gatekeeper. The proposed native helper would be a separate, small AliasMode-owned executable.

## What this patch implements

No production code imports `profile-launchers.ts`, and it performs no I/O. Its tests cover:

- A strict, versioned, bounded public manifest with no cookies, tokens, proxy credentials, browser executable, user-data path, startup URL, or arbitrary arguments.
- Stable bundle identifiers and filenames derived from the distribution bundle ID, data-store namespace, exact case-sensitive Profile ID, and Profile incarnation. Renaming changes only the display name.
- A plist preview with XML escaping, a fixed helper executable name, and no URL or document handlers. It is not a runnable bundle and does not yet provide an icon asset.
- A fixed-directory lexical plan under `~/Applications/AliasMode Profiles/`. Display names never become paths. This is not a filesystem ownership or symlink check.
- An identifier-only open-or-focus request that rejects all supplied command-line arguments and unknown fields.
- Binding checks against a caller-supplied live registry entry and current local Profile identity. Revoked, missing, trashed, recreated, wrong-store, Cloud, and Remote targets fail closed.

Tests also cover malformed and oversized inputs, Unicode/control characters, missing fields, tampered IDs, extra secret/command fields, and stable identities after a rename. **UUIDs, hashes, manifests and these checks do not authenticate a caller.** An attacker can construct public identifiers. The native transport and live registry checks below remain mandatory.

## Proposed durable identity and lifecycle

The installation needs a new persistent random UUID for the local data-store namespace. Each Profile also needs an immutable incarnation UUID, generated when that Profile is created. Neither has been added to the database in this patch.

The manifest identity is:

```
(protocol, managerBundleId, dataNamespaceId, profileId, profileIncarnationId)
```

The full SHA-256 of the JSON tuple becomes the launcher ID. Bundle identifiers have the form `com.aliasmode.desktop.profile.p<digest>`, and filenames are `Profile-<digest>.app`. The name, engine version, dashboard port, Profile sort order, app version, and filesystem location are not inputs. The namespace distinguishes two stores with otherwise identical Profile IDs. Hashing preserves mixed-case Profile IDs without relying on a case-sensitive filesystem.

This collision-safe filename is not a verified display-name design. Apple's plist reference describes Finder fallback to the filesystem name when its display-name/localization conditions are not met. A `CFBundleDisplayName` preview alone does not prove the Dock or Finder will show the Profile's name instead of the digest. Native display-name/localization and icon behavior, including renames, are explicit acceptance gates while preserving stable on-disk identity.

Identity rules for the later implementation:

1. Generate the namespace and Profile incarnation once, atomically, before registering a launcher. Existing rows need an explicit transactional migration. Never regenerate IDs at every startup.
2. Rename: keep the filename, bundle ID, namespace and incarnation. Refresh display metadata and the chosen icon only through the validated native installer. Re-sign if the signing design requires it, then refresh Launch Services. Actual Dock label/icon cache refresh must be tested.
3. Trash/delete: revoke the registry entry in the same lifecycle transaction before any later launch can be admitted. Trash restore requires explicit launcher re-enablement; deletion followed by re-import or creation gets a new incarnation even if the textual Profile ID is reused. Do not silently retarget an old Dock item.
4. Deleted or stale launcher: show a local, non-sensitive error and offer to open the manager. Never choose a similarly named Profile, create a replacement Profile, or fall back to another store.
5. Remove an entry: revoke first, then remove only the exact managed bundle after checking its ownership record. Do not edit Dock preferences; the user can remove the stale pinned item. Removing a launcher does not delete browser data.
6. Profile clones and independent store copies get new identities. Moving the same store preserves its namespace only through a verified migration. Copying its namespace into a second active store must not silently bind both to the same launcher.

`store.ts` currently keeps Profile creation timestamps, but older rows can have `created_at = 0`, and Profile deletion removes the row. A timestamp or SQLite row ID is not an incarnation token. The current `Profile` type has no immutable incarnation field; this patch deliberately does not pretend one exists.

## Proposed click route and security boundary

Use a native launcher app with no URL scheme, document handler, AppleScript command service, or exposed HTTP launch endpoint. Read the manifest from the helper's own validated bundle, not from a web URL or command-line path. Reject incoming URLs and unexpected arguments.

The helper locates the authorized main installation using a trusted local registry/bookmark. It validates that installation before starting it in background mode. No cookie, token, URL, Profile data directory, browser executable, or arbitrary command is placed in process arguments. The manager should be started only if necessary; requests for an already running manager go through native IPC. `NSWorkspace.OpenConfiguration.arguments` applies to a new instance, so it is not sufficient delivery for both cold and warm clicks.

The proposed native IPC request contains only the protocol and launcher ID. It always means **open-or-focus this registered local Profile**:

1. Authenticate the native peer's current identity. Verify the expected user, live process/audit identity and trusted helper code identity; checking only its claimed bundle ID, PID or UID is insufficient. Select a supported XPC or equivalent authenticated native transport. There is no transport implementation in this patch.
2. Resolve the launcher ID from the manager's current private registry, not a manifest or target supplied by the peer. The registry binds the exact launcher, installation namespace, Profile incarnation and enabled/revoked status.
3. While holding the existing per-Profile lifecycle admission lock, re-read the current Profile. Require Local mode, an available Profile, the same namespace and incarnation, and a non-revoked registration. Check again after any awaited startup work that can race with deletion or mode change.
4. Reuse a certified running Profile and bring it forward. Otherwise use the existing launcher and lifecycle logic. Never invoke a browser directly or bypass its fingerprint, proxy, runtime verification, persistent user-data directory or ownership checks.
5. Return only success/pending or a bounded, non-sensitive error, not cookies, authentication material, debugger endpoints, or arbitrary navigation results. Rate-limit and coalesce repeated clicks per launcher so a slow start cannot create multiple browsers.

A webpage cannot open Profiles through a new custom scheme because none is registered. The existing HTTP(S) browser chooser continues to require an explicit user choice and must not interpret a URL as a Profile launch command. Do not put a reusable local launch capability in a URL, plist, public manifest or log.

The intended boundary is untrusted web content and other unauthorized peers, not a fully compromised local account. Filesystem modes alone do not establish native peer identity. Dynamic launcher bundles and the current ad-hoc distribution complicate code-identity validation; this is an unresolved release gate, not an authentication feature supplied by the TypeScript module.

### Why not use the existing CLI or agent API directly?

- `sidecar-entry.ts` delegates to the CLI. Its desktop `start` path initializes the manager/store/runtime; it is not a Profile-specific launcher command. A new sidecar per Dock icon could bypass the desktop's single-instance supervision and cause lifecycle conflicts.
- `src-tauri/src/sidecar.rs::command_args` owns the desktop data directory and launches one supervised sidecar. `src-tauri/src/lib.rs` handles repeat app invocation and the existing HTTP(S) inbox; it has no per-Profile native launch route.
- `agent/runtime-client.mjs` discovers a version-bound descriptor and, on macOS, currently assumes `/Applications/AliasMode.app` by default. Persisting that executable path in every launcher would break app relocation.
- `agent-control.ts::openProfile` returns automation endpoint information and tracks connection ownership. `disconnect()` closes owned browsers unless detached. A small launcher that connects, opens and exits therefore has unsuitable lifecycle semantics unless redesigned. This proposal adds no general agent capability to a launcher and does not reuse that API.

## Installation, migration and updates: not implemented

The plist and path builders only return strings. They cannot safely install or replace a bundle. A native installer must perform all of the following before an experimental opt-in is offered:

- Derive the user's home/Applications location through native APIs and establish an owned managed root. Check every relevant ancestor, owner, permissions and filesystem identity; reject symlink redirection and paths outside that root. Never accept a destination or executable path from Profile metadata.
- Use a per-store lock and race-resistant directory-relative operations. Create a unique staging directory on the same filesystem, with exclusive creation and private permissions. Stage only the known helper, manifest, plist and icon. Verify complete contents and the signing policy before publication.
- Publish with a supported atomic no-clobber operation, not a check-then-overwriting rename. Existing unrelated apps, files, symlinks and incomplete bundles must never be overwritten. Atomic replacement of an owned old bundle needs an explicit ownership/identity check, a recoverable swap, and a crash-recovery journal. A generic `rename` is not a portable no-clobber guarantee.
- Test interruption after every creation/update step. Reconcile staged bundles and registry records without activating an incomplete or unregistered launcher. Make removal similarly confined and recoverable.
- Preserve the per-Profile bundle path and ID across manager and browser upgrades. Revalidate the main installation, helper protocol, code identity and registry before launch. Unknown protocol versions must fail closed and ask for repair, not launch a different app or data store.
- Resolve app moves with a verified bookmark/installation record. Launch Services lookup by bundle ID alone can be ambiguous if multiple copies are installed. If revalidation fails, require an explicit rebind to the intended installation. Do not search PATH or execute a user-supplied command.

The fork currently uses the same `com.aliasmode.desktop` identifier as upstream. Side-by-side installations remain ambiguous; this design does not resolve that existing distribution issue. A separately branded distribution needs a separate manager bundle ID and explicit data/launcher migration. Replacing this fork with upstream can remove support for this future protocol; stale launchers must fail closed.

## Signing, notarization and window ownership

`src-tauri/tauri.macos.conf.json` currently selects ad-hoc signing (`"-"`) and disables hardened runtime. The README states that the beta is not notarized. Do not claim a generated launcher inherits Developer ID signing or notarization from the main app.

Apple's signature seal includes the plist and resources. Changing a bundle ID, display name, icon or manifest after signing changes sealed content. A copied helper executable, a generated wrapper, and the outer application bundle have different verification requirements. The exact native packaging/signing approach needs a macOS prototype and security review. A publisher's Developer ID private key must never be shipped to users to sign locally generated apps. Ad-hoc signing is not notarization and does not remove Gatekeeper requirements. No implementation should clear quarantine or disable security checks.

Outcome A can use a small independently identified app, with an explicit warning that a separate running browser icon may appear. Outcome B is a separate engine-integration project: the browser must support the chosen app identity/window ownership in a verified way. Neither changing `Info.plist` on a shared runtime nor adding a label to its runtime Dock tile is an acceptable shortcut. No such browser changes are in this patch.

## Evidence and verification gates

Repository anchors:

- `profile-id.ts::isSafeProfileId`: existing cross-platform Profile ID grammar.
- `store.ts::upsertProfile` and `deleteProfile`: timestamp handling and row deletion; no immutable incarnation.
- `launcher.ts::buildArgs`, `userDataDir`, and Firefox start paths: managed per-Profile data directories and existing browser lifecycle.
- `agent-control.ts::openProfile`, `detachProfile`, `disconnect`: agent ownership and debugger-capable responses.
- `src-tauri/src/lib.rs`, `src-tauri/src/sidecar.rs`, `src-tauri/Info.plist`: current desktop startup and HTTP(S)-only OS entry points.
- `src-tauri/tauri.macos.conf.json`, `scripts/prepare-macos-bundle.ts`, and README macOS desktop beta: present packaging and signing boundaries. The launcher proposal changes none of them.

Primary Apple references:

- [CFBundleIdentifier](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleidentifier): application bundle identity.
- [Core Foundation plist keys](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html): bundle executable, names and identifiers.
- [NSDockTile](https://developer.apple.com/documentation/appkit/nsdocktile) and [NSApplication.dockTile](https://developer.apple.com/documentation/appkit/nsapplication/docktile): a running application's tile, not a durable Profile launch registry.
- [NSWorkspace launch arguments](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/arguments): arguments apply to new application instances.
- [Understanding the Code Signature](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html): plist/resource seals and code identity across updates.

The archived references were read directly. Modern documentation statements were cross-checked against Apple's indexed page text; their directly fetched HTML requires JavaScript. These sources establish API constraints, not observed Dock behavior.

Linux verification: run `bun test profile-launchers.test.ts` and `bun run typecheck`. An independent plist parser can verify generated XML, but cannot verify Launch Services, signing, native IPC or Dock behavior.

Before any macOS experimental release, test Apple Silicon and supported Intel builds: cold/warm manager, browser stopped/running, repeated clicks, two simultaneous Profiles, normal browser quit, manager quit, relaunch from a pinned tile, Profile rename/trash/delete/recreate, store migration, app relocation, manager/browser updates, stale registry, hostile inputs, corrupt bundles, symlink/race attacks, signature validation and Gatekeeper. Record outcome A and outcome B separately. This native implementation and test stage is currently **not run and paused**, not a completed or automatically enabled feature.
