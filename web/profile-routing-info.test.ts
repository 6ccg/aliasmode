import { expect, test } from "bun:test";
import { normalizeCountryCode, profileRoutingInfo } from "./profile-routing-info.ts";

test("routing metadata labels the engine and configured OS, not seed rotation", () => {
  for (const [fingerprintOs, label] of [["windows", "Windows"], ["macos", "macOS"], ["linux", "Linux"]] as const) {
    expect(profileRoutingInfo({ engine: "chromium", fingerprintOs })).toEqual({ engine: { label: "Chromium" }, fingerprint: { label } });
  }
  expect(profileRoutingInfo({ engine: "firefox" })).toEqual({ engine: { label: "Firefox" } });
  expect(profileRoutingInfo({ engine: "chromium", randomizeFingerprintOnLaunch: true } as any).fingerprint).toBeUndefined();
});

test("routing country uses only a known ISO country and renders a flag", () => {
  expect(profileRoutingInfo({ engine: "firefox", proxyCountryCode: "us" }).country).toEqual({ code: "US", flag: "🇺🇸" });
  for (const code of [undefined, "", "ZZ", "XX", "USA", "United States", "<script>"]) {
    expect(normalizeCountryCode(code)).toBeUndefined();
    expect(profileRoutingInfo({ engine: "chromium", proxyCountryCode: code }).country).toBeUndefined();
  }
  expect(profileRoutingInfo({ engine: "chromium", timezone: "America/New_York", locale: "en-US", proxy: "us.example:8080" } as any).country).toBeUndefined();
});
