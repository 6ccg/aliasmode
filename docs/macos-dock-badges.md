# Running macOS Chromium Profile Dock badges

This fork applies the existing Profile number to each running Chromium browser's Dock tile with the experimental CDP command [`Browser.setDockTile`](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setDockTile). The browser process owns the badge. AliasMode does not copy or compile a browser per Profile, create a helper `.app`, modify browser bundles/signatures, pin Dock items, or install a permanent launcher. The previous unwired per-Profile launcher prototype has been removed.

## Use and settings

- On macOS, open a Chromium Profile normally. Once the normal launch and identity checks succeed, AliasMode requests its number badge in the background. AliasMode Chromium and CloakBrowser are eligible; the installed engine must implement this experimental command. Firefox, Windows, Linux and headless launches are skipped.
- The label is the existing **Custom NO.** in Profile settings, or the roster's local serial when it is blank. Leading zeroes are preserved. Use distinct short numbers, ideally 1–4 digits: long labels may be clipped by macOS, and duplicate custom numbers remain duplicates. Names, account names and credentials are never used as the badge.
- Edit **Custom NO.** while the browser is open. The next dashboard poll or certified active check updates the badge without changing fingerprint/session settings or restarting the browser. The setting already persists in the Profile store. A blank custom number restores the local serial.
- Source/managed deployments can set `ALIASMODE_DOCK_BADGES=0` in the **manager's environment before starting it** to disable badge commands. This is an environment opt-out, not a new graphical toggle. Already displayed badges are owned by the running browser and can remain until that process exits; the opt-out does not force it to restart or clear another badge. The default is enabled on macOS.
- The feature changes only the running tile's label. It does not create a persistent per-Profile Dock shortcut or change what clicking a pinned Chromium application launches. Shared-bundle Dock grouping and the exact visual result require macOS validation. It does not change tile color or image.

In Cloud/Remote operation a browser started on this Mac may use its cached local Profile serial. This is a local badge, not a stable team-wide Cloud number, and no new field is synchronized.

## Lifecycle and failure handling

Fresh launches are badged only after launch commit and normal identity certification. An existing browser is badged after its ownership/persona checks pass on reattach or manager recovery. A new manager has an empty badge cache and reapplies the number to certified survivors. The feature adds no migration, browser restart requirement or process-launch path.

Repeated observations of the same browser generation, endpoint and label coalesce. A changed label, browser endpoint or launch generation gets a new request; an older pending request is canceled and rechecks the current certified launch/label before sending. Confirmed shutdown removes the cached attempt. Dashboard reconciliation refreshes only already-certified browsers, never an unverified discovered process.

Every attempt uses one short-lived browser-level WebSocket, with a maximum 1.5-second timeout and 4 KiB incoming-message limit. The launch/reattach response never waits for the badge. A failed connection or command is harmless to the browser. Transient failures retry only during later verified observations, no sooner than 30 seconds apart and at most three attempts for the same label/generation. A missing protocol method is tried once per browser generation/endpoint, not once per poll. There is no dedicated polling timer, page attachment or persistent badge connection.

An unavailable/unsupported result is logged once as a generic message without Profile names, endpoints, ports or raw protocol error text. No unsupported-runtime dialog blocks opening a Profile. The window title behavior and browser session remain unchanged.

## Security boundary

The command is restricted to the exact `ws://127.0.0.1:<owned-port>/devtools/browser/<id>` endpoint from a certified managed launch. Other hosts, port mismatches, page endpoints, embedded credentials, queries/fragments, malformed/oversized endpoints and WebSocket redirects are rejected. CDP is already enabled by the existing launcher; this feature opens no new listening port and adds no browser flags, URL handler, HTTP API or third-party service.

Only a bounded numeric label is sent, in `Browser.setDockTile`'s `badgeLabel` parameter. No icon bytes, names, usernames, cookies, passwords, proxy configuration or Profile paths are transmitted. Disconnecting terminates the temporary CDP client only, never the browser. This does not protect against a fully compromised local user account or authenticate every local process that can already access Chromium's debugging port.

## Verification and remaining gate

Linux automated tests cover the real loopback WebSocket exchange, unsupported/error replies, malformed/oversized responses, timeout/abort cleanup, endpoint restrictions and redirects, generation/label coalescing, retry limits, two independent Profiles, manager recovery, endpoint change, renumbering, nonfatal failures, ownership rejection, and Firefox/headless/platform/opt-out exclusions.

Run:

```sh
bun test dock-badges.test.ts launcher.test.ts launcher-firefox.test.ts
bun run typecheck
```

**No real macOS Dock, macOS app packaging or signing test has been run for this change.** Linux tests and simulated `hostPlatform: "darwin"` prove code paths and protocol handling, not visible Dock behavior. Do not describe this as a tested macOS release.

Before releasing, manually verify on each supported macOS/runtime combination: two Profiles with distinct numbers, multiple windows per Profile, changing/clearing Custom NO., long/duplicate numbers, browser quit/reopen, manager recovery with surviving browsers, headless/Firefox unaffected, unsupported engines, and an opted-out manager. Confirm the number appears on the correct running tile and remains distinguishable despite shared bundle IDs. Check that browser windows, tabs and login state stay intact and no helper applications or pinned Dock items appear. Do not use a browser copy or forced restart to hide a failed acceptance test.
