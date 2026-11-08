# macOS URL routing

The desktop manager registers as an HTTP/HTTPS handler. No browser engine fork is required.

This fork currently keeps the upstream bundle identifier (`com.aliasmode.desktop`) and application name. Do not install it alongside upstream AliasMode as a second app: macOS handler registration can become ambiguous and app data may be shared. Back up existing profiles before replacing the app. A separately branded distribution needs a distinct identifier and explicit data migration.

1. Build and install the macOS desktop `.app` using the normal macOS bundle instructions in the README. A source dashboard in Safari/Chrome is not an OS browser handler.
2. Put AliasMode in Applications and launch it once. Open Settings → Browser routing and click **Set AliasMode as default browser**. macOS asks for confirmation; canceling keeps the existing browser. The page reads the actual HTTP and HTTPS handlers, refreshes when the app regains focus, and also offers Refresh status. If the request is unavailable, use macOS System Settings → Desktop & Dock → Default web browser. AliasMode never changes the default on startup.
3. Choose Continue with Local and create or import profiles.
4. Open an HTTP/HTTPS link from another app. AliasMode shows a chooser. Choose a local profile to open a new tab, or an installed browser.
5. Settings → Browser routing also lets you add another browser by its absolute `.app` path. Chrome, Edge, Brave, Firefox, Safari and several common alternatives are detected in `/Applications`, `/System/Applications`, and `~/Applications`. Added choices can be removed.

Links are held only in the desktop process, not persisted or sent to Cloud. The queue survives dashboard reloads but not quitting the application. Each link must be explicitly opened or dismissed; there is no automatic routing rule. The queue is bounded at 100 links, each at most 16 KiB. Only HTTP(S) links without embedded username/password credentials are accepted. New links beyond that bound are not retained. Ordinary query strings and fragments are preserved.

Selecting a profile uses the existing local lifecycle, then its certified runtime to open a new tab. Both the Firefox owner and Chromium runtime use the existing navigation abstraction. Startup URLs and stored identity are not replaced. Existing running profiles are reused. Cloud/remote profiles are deliberately excluded. A navigation failure leaves the URL queued. If a request loses its response after the browser has opened a tab, retrying can open a duplicate tab.

Selecting another browser uses `/usr/bin/open -a <validated application> -- <url>` with separate arguments, never a shell command. The app is revalidated at launch and AliasMode itself is rejected to avoid routing loops. Added app paths are stored in this dashboard's local storage; moving an application requires adding its new path. The selected browser's own telemetry and network behavior are outside the manager's control.

## Verification

Automated coverage is in `url-routing.test.ts` and the Rust `url_router` unit tests. TypeScript tests check safe URLs, cross-origin rejection, local-only enforcement, inactive runtimes, and new-tab navigation through a Firefox-shaped endpoint. The Rust unit test checks native URL validation.

A release must additionally be checked on macOS: install the built app, select it in System Settings, open links with the app stopped and running, route to Firefox and Chromium profiles and each installed browser, add/remove a browser, dismiss links, submit several links while a profile starts, and verify onboarding/restart does not discard pending links unexpectedly. Linux automated tests cannot verify Launch Services, native compilation, signing, or actual browser launch behavior.
