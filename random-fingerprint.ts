/** Manager-side device regeneration using the existing engines, without engine patches. */
import { randomInt } from "node:crypto";
import { defaultScreen, hostScreenFloor } from "./create.ts";
import { generateProfileHardware } from "./fingerprint.ts";
import { completeProfileFingerprint, createFirefoxProfileConfig, firefoxPersonaOs, syncFirefoxTimezone } from "./firefox-config.ts";
import type { Profile } from "./types.ts";

/** Redraw the supported device identity; account data and network/OS choices stay put. */
export function randomizedLaunchProfile(profile: Profile): Profile {
  if (!profile.randomizeFingerprintOnLaunch) return profile;
  // Draw uniformly from all valid seeds except the previous one. No collision/retry loop.
  const draw = randomInt(1, 0xffff_ffff);
  const fingerprintSeed = draw >= profile.fingerprintSeed ? draw + 1 : draw;
  const floor = hostScreenFloor(profile.engine ?? "chromium", profile.chromiumRuntime);
  // Avoid the previous screen when another fits the host; a large host may
  // have only one valid choice. Use the same screen policy as profile creation.
  const screen = defaultScreen(floor, () => randomInt(0x1_0000_0000) / 0x1_0000_0000,
    { width: profile.screenWidth, height: profile.screenHeight });
  let rotated: Profile = { ...profile, fingerprintSeed, screenWidth: screen.width, screenHeight: screen.height };
  if (profile.engine === "firefox") {
    // Replace, never merge: old explicit GPU/CPU/screen/media/seed values must not
    // override the new internally matched device. Keep the chosen desktop OS.
    const firefox = createFirefoxProfileConfig(screen.width, screen.height, firefoxPersonaOs(profile), fingerprintSeed);
    rotated = { ...rotated, firefox, ua: String(firefox.config["navigator.userAgent"]) };
    delete rotated.hardware;
    syncFirefoxTimezone(rotated);
    rotated = completeProfileFingerprint(rotated);
  } else if (profile.chromiumRuntime) {
    // Chromium 155 draws a coordinated GPU/CPU/RAM device from the seed.
    // A stored override (including a prior captured CPU) would pin old hardware.
    delete rotated.hardware;
  } else {
    // CloakBrowser defaults to 8 without the manager's existing CPU flag.
    rotated.hardware = generateProfileHardware(fingerprintSeed);
  }
  // Old measurements/expectations describe the former device, not this identity.
  delete rotated.fpObserved;
  delete rotated.fpExpected;
  delete rotated.fpVerdict;
  return rotated;
}
