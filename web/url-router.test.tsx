import { test, expect } from "bun:test";
import { normalizeCountryCode, profileRoutingInfo } from "./profile-routing-info.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { orderedBrowsers, moveTo, linkSummary } from "./url-router.tsx";
import { acceptSnapshot } from "./browser-chooser.tsx";

const safari = {name: "Safari", path: "/Applications/Safari.app"};
const chrome = {name: "Chrome", path: "/Applications/Chrome.app"};
const brave = {name: "Brave", path: "/Applications/Brave.app"};

test("browser ordering deduplicates detected and added apps and appends new apps", () => {
  expect(orderedBrowsers([safari, chrome], [safari, brave], []).map(item => item.path)).toEqual([safari.path, chrome.path, brave.path]);
  expect(orderedBrowsers([safari, chrome], [brave], [chrome.path, "/missing.app", safari.path]).map(item => item.path)).toEqual([chrome.path, safari.path, brave.path]);
  expect(orderedBrowsers([safari], [], [chrome.path])).toEqual([safari]);
});

test("dragging moves an item directly to the target and retains every other item", () => {
  const ids = ["first", "second", "third", "fourth"];
  expect(moveTo(ids, "first", "fourth")).toEqual(["second", "third", "fourth", "first"]);
  expect(moveTo(ids, "fourth", "second")).toEqual(["first", "fourth", "second", "third"]);
  expect(moveTo(ids, "missing", "second")).toEqual(ids);
  expect(ids).toEqual(["first", "second", "third", "fourth"]);
});

test("link summary removes tracking query and fragment without changing the URL", () => {
  const url = "https://one.google.com/ai-student?token=private&utm_campaign=" + "tracking" + "#secret";
  expect(linkSummary(url)).toBe("one.google.com/ai-student");
  expect(linkSummary("https://example.com/")).toBe("example.com");
  expect(linkSummary("http://localhost:8080/a")).toBe("localhost:8080/a");
  expect(url).toContain("token=private");
});


test("out-of-order queue replies cannot resurrect a dismissed occurrence", () => {
  const first = { revision: "1", urls: [{id: "1", url: "https://example.com"}] };
  const empty = { revision: "2", urls: [] };
  expect(acceptSnapshot(empty, first)).toBe(empty);
  expect(acceptSnapshot(first, empty)).toEqual(empty);
  const duplicate = { revision: "3", urls: [{id: "2", url: "https://example.com"}] };
  expect(acceptSnapshot(empty, duplicate)).toEqual(duplicate);
  expect(acceptSnapshot(duplicate, empty)).toBe(duplicate);
  expect(acceptSnapshot(empty, {revision: "invalid", urls: []})).toBe(empty);
});

test("routing metadata labels the engine and configured OS, not seed rotation", () => {
  for (const [fingerprintOs, label] of [["windows", "Windows"], ["macos", "macOS"], ["linux", "Linux"]] as const) {
    expect(profileRoutingInfo({ engine: "chromium", fingerprintOs })).toEqual({ engine: { label: "Chromium" }, fingerprint: { label } });
  }
  expect(profileRoutingInfo({ engine: "firefox" })).toEqual({ engine: { label: "Firefox" } });
  expect(profileRoutingInfo({ engine: "chromium", randomizeFingerprintOnLaunch: true } as any).fingerprint).toBeUndefined();
});

test("routing country uses only a known ISO country and renders a flag", () => {
  expect(profileRoutingInfo({ engine: "firefox", proxyCountryCode: "us" }).country).toEqual({ code: "US", flag: "🇺🇸" });
  for (const code of [undefined, "ZZ", "USA"]) {
    expect(normalizeCountryCode(code)).toBeUndefined();
    expect(profileRoutingInfo({ engine: "chromium", proxyCountryCode: code }).country).toBeUndefined();
  }
  expect(profileRoutingInfo({ engine: "chromium", timezone: "America/New_York", locale: "en-US", proxy: "us.example:8080" } as any).country).toBeUndefined();
});
