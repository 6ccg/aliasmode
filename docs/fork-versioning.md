# Fork versioning and merge preparation

This fork uses the upstream version followed by `.modN`, starting at `0.1.0-beta.74.mod1`. The running Chromium Dock badge revision is `0.1.0-beta.74.mod2`. Increment only the mod number for fork changes; change the upstream portion only when incorporating that upstream release. This is a SemVer prerelease suffix (not build metadata).

The current base is upstream/main and origin/main commit `0361bf4d4c53c993e5df80f1e7a2b6e9eb8a3538`, whose version is `0.1.0-beta.74`. Existing fork beta.75, beta.76 and beta.77 tags/releases are historical and must not be rewritten. SemVer orders beta.74.mod1 below beta.77, so an installed beta.77 will not automatically update to this preview; install this preview manually.

The preparation branch contains three commits: routing and optional fingerprint rotation; compact chooser and browser ordering; fork version and artifact-only ARM64 build. Nothing merges automatically. Only the fork `6ccg/aliasmode` may receive pushes; never push to `aliasmode/aliasmode`.

The subsequent native-close fix and running Dock badge work remain on `fix/native-chooser-and-profile-launchers`. Despite that historical branch name, the unwired permanent-launcher prototype was removed after choosing running badges. This work does not change `main` or `prepare/beta74-mod1`. Any later integration should retain a small number of coherent commits, rather than merging intermediate save points. No macOS build or GitHub Actions job is started as part of this source-only change.

The macOS ARM64 workflow uploads DMG, app archive and SHA-256 checksums as a 30-day Actions artifact. It cannot publish releases or tags, and uses read-only repository permissions. Builds remain ad-hoc signed, not Developer ID signed or notarized.
