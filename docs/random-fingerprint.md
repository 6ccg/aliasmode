# Per-launch device fingerprint regeneration

In Local mode, edit a profile and enable **Randomize fingerprint on each new launch**. Existing profiles default to off. Save, close the profile, and open it again. This setting does not apply to regular Chrome, Edge, Brave, or Firefox apps opened by the URL chooser.

## What changes

The manager generates a cryptographically random nonzero 32-bit fingerprint seed different from the previous seed, selects a desktop screen using the same host-size constraints as profile creation, and regenerates the supported device configuration. A different screen is selected when more than one valid size fits the host. A very large host can leave only one possible screen size. Other finite hardware choices can repeat; this is a fresh draw, not a guarantee that every field changes.

- **AliasMode Chromium 155:** the existing engine uses the new `--fingerprint` seed to generate coordinated GPU, WebGL/WebGPU, CPU/RAM, fonts and media identity. The manager removes the previous CPU override (including a CPU saved after an earlier launch), so it cannot pin the old hardware. Screen flags carry the new screen; the existing noise option remains enabled. The runtime limits CPU and RAM to the host's capabilities. Chromium generates its own UA and Client Hints using its actual browser version; no cosmetic UA version is forced.
- **CloakBrowser:** the manager redraws the seed, screen and supported logical processor count through its existing flags. The runtime determines other seed-controlled surfaces. Chromium 155's device catalog and RAM behavior must not be assumed for CloakBrowser.
- **AliasMode Firefox:** the manager replaces the complete generated config using the existing OS-aware generator. GPU renderer/vendor and corresponding WebGL limits are generated together; CPU count is matched to graphics class. Screen, available area and window geometry are rebuilt. The saved UA is updated from the generated config. Old manual CPU overrides and old explicit generated-device overrides are removed. At launch, the existing engine/config path generates new canvas/text seeds, fonts, voices and media-device identity. Locale and timezone are restored from the profile rather than randomly changed.

**This option now replaces manual device overrides**, rather than only rotating noise seeds. Disable it if a fixed screen, CPU or custom Firefox device config is important. Disabling stops future regeneration; it does not restore earlier device settings.

OS choice, proxy, timezone policy, language, display scale, profile ID, account credentials, cookies, passwords, extensions and the persistent browser directory are preserved. Old fingerprint captures, import expectations and comparison verdicts are cleared because they describe the previous device. Fresh captures use the normal existing launch path.

The generated configuration is persisted before constructing a fresh browser launch. Concurrent opens share one launch; opening an already running profile or reattaching to its browser does not regenerate anything. If startup subsequently fails, the new configuration remains saved; retrying a fresh launch draws another. A running browser's identity is not rewritten.

## Device-model and hardware limits

These are browser-visible desktop personas, not virtual machines or new physical computers. There is no supported manager setting for an arbitrary laptop product name or serial number. Changing a label alone would not change the underlying capabilities.

Firefox on Apple Silicon uses stock Firefox's normalized GPU description, **Apple M1, or similar**. A new seed therefore need not show a new Apple GPU name. Intel Macs are adjusted at launch to the appropriate Intel/AMD graphics class. Firefox does not expose Chromium's `navigator.deviceMemory`, so this implementation does not invent a Firefox RAM property. Firefox's reported CPU count is capped to the host at launch.

Chromium 155 includes Apple GPU models, but models in a hardware family share measured capabilities. A catalog model does not mean a complete emulation of that physical machine. Real graphics/compute performance, some rendering/audio behavior, host capability limits and permission-granted real media devices can still reveal stable traits. This change neither forks nor modifies either engine.

## Privacy limits

This is not an anonymity guarantee. Cookies, account logins, IP addresses and other stable data can link sessions. Fingerprint changes can cause websites to request verification or flag a returning account. Disable the option if a stable identity is important. Local networking, Services, updates and downloads retain upstream behavior.

## References and licensing

- [AliasMode Chromium's pinned runtime switches](https://github.com/aliasmode/aliasmode-chromium/blob/v155.0.8059.85-aliasmode.5/docs/reference/switches.mdx) and [GPU catalog](https://github.com/aliasmode/aliasmode-chromium/blob/v155.0.8059.85-aliasmode.5/docs/reference/gpu-models.mdx).
- Firefox configuration is based on this repository's `createFirefoxProfileConfig`, `graphicsIdentity`, `firefoxLaunchConfig` and its existing bundled generator data.
- The original opt-in flow was compared with [Donut Browser commit 6b72363](https://github.com/donutbrowser/donutbrowser/blob/6b72363ac7fec91a3c82c50c048864d9d036eee0/src-tauri/src/browser_runner.rs). Donut's manager is AGPL-3.0. This implementation is independently written using AliasMode's existing runtime configuration paths; no Donut code or Wayfern binary is copied or bundled. AliasMode's Apache-2.0 license and notices remain.

## Verification

Tests cover opt-in persistence/validation, nonmutation, account/network data preservation, supported engine flags/config construction, Firefox OS-matched graphics and synchronized geometry/locale/timezone, removal of stale overrides, screen constraints, concurrent/repeated starts, stop/start regeneration and persistent-directory retention. Runtime calls in lifecycle tests are simulated. These tests do not replace macOS application testing or measurement of a real engine's web-visible fingerprint; no end-to-end anti-fingerprinting pass is claimed.

## Choose during creation

New local profiles expose **Randomize fingerprint on each new launch** before Create profile. It is off by default, applies to both Chromium and Firefox, and is saved with the new profile without a second edit step. Canceling or reopening creation resets the choice. You can change it later in the profile editor. Cloud and legacy Remote creation do not show this local-only choice.
