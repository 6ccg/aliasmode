# macOS URL routing

The desktop manager registers as an HTTP/HTTPS handler. No browser engine fork is required.

This fork currently keeps the upstream bundle identifier (`com.aliasmode.desktop`) and application name. Do not install it alongside upstream AliasMode as a second app: macOS handler registration can become ambiguous and app data may be shared. Back up existing profiles before replacing the app. A separately branded distribution needs a distinct identifier and explicit data migration.

1. Build and install the macOS desktop `.app` using the normal macOS bundle instructions in the README. A source dashboard in Safari/Chrome is not an OS browser handler.
2. Put AliasMode in Applications and launch it once. Open Settings → Browser routing and click **Set AliasMode as default browser**. macOS asks for confirmation; canceling keeps the existing browser. The page reads the actual HTTP and HTTPS handlers, refreshes when the app regains focus, and also offers Refresh status. If the request is unavailable, use macOS System Settings → Desktop & Dock → Default web browser. AliasMode never changes the default on startup.
3. Choose Continue with Local and create or import profiles.
4. Open an HTTP/HTTPS link from another app. AliasMode shows a chooser. Choose a local profile to open a new tab, or an installed browser.
5. Settings → Browser routing also lets you add another browser by its absolute `.app` path. Chrome, Edge, Brave, Firefox, Safari and several common alternatives are detected in `/Applications`, `/System/Applications`, and `~/Applications`. Added choices can be removed. Use the up/down buttons to set the installed-browser order; it is saved on this Mac and applied to future link choices.

## Compact chooser

A queued link temporarily presents a 480×520 logical-pixel chooser (fitted to the current monitor), without the dashboard behind it. Browser cards use two columns; local profiles appear below, with search when there are more than five. Long lists scroll without pushing the dismiss control out of view. The default link summary shows only its host and path; click the three-dot button to expand the full URL, then click it again to collapse. The original query and fragment are still passed to the selected browser.

Tab and Shift+Tab stay inside the chooser. The duplicate in-page × is removed. The native titlebar Close button, Cmd+W, Escape, and Dismiss all request dismissal of the current link, not shutdown of AliasMode or its running profiles. Each queued occurrence has its own ID, including repeated copies of the same URL, so a delayed close event cannot dismiss a different occurrence. Closing while an opening operation is in progress does not cancel or interrupt that operation. Opening failures keep the link queued.

After the last link is consumed, the frontend removes the chooser before asking the native shell to restore the prior dashboard size, position, and visibility. If a new link arrived in the meantime, the compact chooser continues instead. A failed restoration keeps the native close guard in place so it cannot fall through to profile shutdown. Restoration does not explicitly focus the dashboard. A cold application launch may briefly show startup UI before macOS delivers its URL event.

Browser order is stored atomically in the native app data directory, independent of the dashboard port and separate from added-browser data. New applications are appended, missing applications are ignored, and corrupt ordering data falls back to discovery order.

Links are held only in the desktop process, not persisted or sent to Cloud. The queue survives dashboard reloads but not quitting the application. Each link must be explicitly opened or dismissed; there is no automatic routing rule. The queue is bounded at 100 links, each at most 16 KiB. Only HTTP(S) links without embedded username/password credentials are accepted. New links beyond that bound are not retained. Ordinary query strings and fragments are preserved.

Selecting a profile uses the existing local lifecycle, then its certified runtime to open a new tab. Both the Firefox owner and Chromium runtime use the existing navigation abstraction. Startup URLs and stored identity are not replaced. Existing running profiles are reused. Cloud/remote profiles are deliberately excluded. A navigation failure leaves the URL queued. If a request loses its response after the browser has opened a tab, retrying can open a duplicate tab.

Selecting another browser uses `/usr/bin/open -a <validated application> -- <url>` with separate arguments, never a shell command. The app is revalidated at launch and AliasMode itself is rejected to avoid routing loops. Added app paths are stored in this dashboard's local storage; moving an application requires adding its new path. The selected browser's own telemetry and network behavior are outside the manager's control.

## Verification

Automated coverage is in `url-routing.test.ts`, `url-router-native.test.ts`, `web/url-router.test.tsx`, and the Rust `url_router` and `url_inbox` unit tests. TypeScript tests check safe URLs, cross-origin rejection, local-only enforcement, inactive runtimes, and new-tab navigation through a Firefox-shaped endpoint. The Rust tests check URL validation and the actual queue's duplicate identities, stale dismissals, capacity and close-protection lifecycle. The queue tests can run without Tauri system libraries using `rustc --edition=2021 --test src-tauri/src/url_inbox.rs -o /tmp/aliasmode-url-inbox-tests` followed by `/tmp/aliasmode-url-inbox-tests`.

`bun scripts/browser-chooser-acceptance.ts` runs the real React components with mocked native IPC and synthetic profiles. It covers native-event API plumbing, delayed replies, duplicate links, opening failures, busy operations, listener registration, restoration retries, keyboard controls and layout. `--build-only` only checks that this harness bundles; neither mode exercises AppKit's real titlebar. The current cloud environment could build it and run separate React DOM checks, but could not launch the isolated Chromium runner or access its loopback fixture through the existing browser, so real-browser layout acceptance is still outstanding.

A release must additionally be checked on macOS: install the built app, select it in System Settings, open links with the app stopped and running, route to Firefox and Chromium profiles and each installed browser, add/remove a browser, dismiss links, submit several links while a profile starts, and verify onboarding/restart does not discard pending links unexpectedly. For native closing, test the red titlebar button and Cmd+W with duplicate links, during browser startup, after navigation failure, and with the dashboard hidden, minimized, maximized, or fullscreen before routing. Confirm that existing browser sessions remain open and retain their cookies and storage.

The native-close changes on `fix/native-chooser-and-profile-launchers` have not been verified on macOS. Linux automated tests do not verify Launch Services, AppKit event delivery, native compilation, signing, or actual browser launch behavior. macOS build, signing, installation, and Dock/window acceptance remain a release gate; a passing web harness is not a substitute.
