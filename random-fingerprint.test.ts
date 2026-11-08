import { test, expect } from "bun:test";
import { randomizedLaunchProfile } from "./random-fingerprint.ts";
import { deriveFingerprintFlags } from "./fingerprint.ts";
import { firefoxLaunchConfig, graphicsIdentity } from "./firefox-config.ts";
import { ProfileStore } from "./store.ts";
import { buildNewProfile, defaultScreen } from "./create.ts";

test("rotation is opt-in, nonmutating, and preserves account and network data", () => {
  const original = buildNewProfile({ name: "Rotation", engine: "chromium", chromiumRuntime: "cloakbrowser" }, () => false);
  expect(randomizedLaunchProfile(original)).toBe(original);
  const enabled = { ...original, randomizeFingerprintOnLaunch: true, hardware: { cores: 255 } };
  const snapshot = structuredClone(enabled);
  const rotated = randomizedLaunchProfile(enabled);
  expect(enabled).toEqual(snapshot);
  expect(rotated.fingerprintSeed).not.toBe(enabled.fingerprintSeed);
  expect(rotated.fingerprintSeed).toBeGreaterThanOrEqual(1);
  expect(rotated.fingerprintSeed).toBeLessThanOrEqual(0xffff_ffff);
  expect(rotated.hardware!.cores).not.toBe(255);
  expect(deriveFingerprintFlags(rotated)).toContain(`--fingerprint=${rotated.fingerprintSeed}`);
  expect(deriveFingerprintFlags(rotated)).toContain(`--fingerprint-screen-width=${rotated.screenWidth}`);
  const { fingerprintSeed: _a, hardware: _b, screenWidth: _c, screenHeight: _d, ...unchanged } = rotated;
  const { fingerprintSeed: _e, hardware: _f, screenWidth: _g, screenHeight: _h, ...expected } = enabled;
  expect(unchanged).toEqual(expected);
});

test("Chromium 155 drops old CPU overrides so the kernel redraws coordinated hardware", () => {
  const profile = { ...buildNewProfile({ name: "155", engine: "chromium", chromiumRuntime: "aliasmode" }, () => false), randomizeFingerprintOnLaunch: true, hardware: { cores: 8 } };
  const rotated = randomizedLaunchProfile(profile);
  expect(rotated.hardware).toBeUndefined();
  expect(deriveFingerprintFlags(rotated).some((flag) => flag.startsWith("--fingerprint-hardware-concurrency="))).toBe(false);
  expect(deriveFingerprintFlags(rotated)).toContain("--fingerprint-noise");
});

for (const platformOs of ["macos", "windows", "linux"] as const) {
  test(`Firefox rebuilds matching ${platformOs} device config and retains locale/timezone`, () => {
    const profile = { ...buildNewProfile({ name: "Firefox rotation", engine: "firefox", platformOs }, () => false), randomizeFingerprintOnLaunch: true, hardware: { cores: 255 }, locale: "fr-FR", timezone: "Europe/Paris" };
    Object.assign(profile.firefox!.config, { "aliasmode:canvasSeed": 123, "aliasmode:textSeed": 456, "webGl:renderer": "stale GPU", "mediaDevices:micros": 999, voices: [{ name: "stale" }] });
    const snapshot = structuredClone(profile);
    const first = randomizedLaunchProfile(profile);
    const next = randomizedLaunchProfile(first);
    expect(profile).toEqual(snapshot);
    expect(first.hardware).toBeUndefined();
    expect(first.firefox!.config["webGl:renderer"]).toBe(graphicsIdentity(platformOs, first.fingerprintSeed)["webGl:renderer"]);
    expect(first.firefox!.config["screen.width"]).toBe(first.screenWidth);
    expect(first.firefox!.config["screen.height"]).toBe(first.screenHeight);
    expect(first.ua).toBe(String(first.firefox!.config["navigator.userAgent"]));
    expect(first.firefox!.config.timezone).toBe("Europe/Paris");
    expect(first.firefox!.config["navigator.language"]).toBe("fr-FR");
    const config = firefoxLaunchConfig(first, undefined, undefined, undefined, undefined, undefined, 64);
    const nextConfig = firefoxLaunchConfig(next);
    expect(config["aliasmode:canvasSeed"]).not.toBe(nextConfig["aliasmode:canvasSeed"]);
    expect(config["aliasmode:textSeed"]).not.toBe(nextConfig["aliasmode:textSeed"]);
    expect(config["mediaDevices:micros"]).not.toBe(999);
    expect(config.voices).not.toEqual([{ name: "stale" }]);
    expect(config["navigator.hardwareConcurrency"]).toBeLessThanOrEqual(64);
    expect(first.cookies).toEqual(profile.cookies);
    expect(first.platformOs).toBe(platformOs);
    expect(first.proxy).toEqual(profile.proxy);
  });
}

test("screen draw avoids the previous screen when possible and respects oversized host floor", () => {
  const previous = { width: 1920, height: 1080 };
  expect(defaultScreen(null, () => 0, previous)).not.toEqual(previous);
  expect(defaultScreen({ width: 7680, height: 4320 }, () => 0, previous)).toEqual({ width: 7680, height: 4320 });
});

test("store persists opt-in and accepts explicitly disabling it", () => {
  const store = new ProfileStore(":memory:");
  try {
    const p = { ...buildNewProfile({ name: "Stored rotation", engine: "chromium" }, () => false), randomizeFingerprintOnLaunch: true };
    store.upsertProfile(p);
    expect(store.getProfile(p.id)!.randomizeFingerprintOnLaunch).toBe(true);
    store.upsertProfile({ ...store.getProfile(p.id)!, randomizeFingerprintOnLaunch: false });
    expect(store.getProfile(p.id)!.randomizeFingerprintOnLaunch ?? false).toBe(false);
    expect(() => store.upsertProfile({ ...p, randomizeFingerprintOnLaunch: "false" } as any)).toThrow("must be boolean");
  } finally { store.close(); }
});

for (const engine of ["firefox", "chromium"] as const) {
  test(`${engine} regeneration persists cleared overrides and stale measurements atomically`, () => {
    const store = new ProfileStore(":memory:");
    try {
      const p = { ...buildNewProfile({ name: "Roundtrip", engine, ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}) }, () => false), randomizeFingerprintOnLaunch: true, hardware: { cores: 255 } };
      store.upsertProfile({ ...p, fpExpected: { canvas: "old" } });
      store.saveObservedFingerprint(p.id, { canvas: "old" }, { verdict: "match", differences: [] });
      const before = store.getProfile(p.id)!;
      expect(before.fpVerdict?.verdict).toBe("match");
      const regenerated = randomizedLaunchProfile(before);
      store.upsertProfile(regenerated, { replaceDeviceIdentity: true });
      const saved = store.getProfile(p.id)!;
      expect(saved.hardware).toBeUndefined();
      expect(saved.fingerprintSeed).toBe(regenerated.fingerprintSeed);
      expect(saved.screenWidth).toBe(regenerated.screenWidth);
      expect(saved.firefox).toEqual(regenerated.firefox);
      expect(saved.fpObserved).toBeUndefined();
      expect(saved.fpExpected).toBeUndefined();
      expect(saved.fpVerdict).toBeUndefined();
    } finally { store.close(); }
  });
}
