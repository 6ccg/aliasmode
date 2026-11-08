import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { I18nProvider } from "./i18n.tsx";
import { BrowserRoutingSettings, UrlRouter, orderedBrowsers, moveBrowser, readBrowserOrder, linkSummary } from "./url-router.tsx";

test("routing settings are a settings card; idle URL inbox has no floating entry point", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => [] } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
  try {
    expect(renderToStaticMarkup(<I18nProvider><UrlRouter profiles={[]} local /></I18nProvider>)).toBe("");
    const settings = renderToStaticMarkup(<I18nProvider><BrowserRoutingSettings /></I18nProvider>);
    expect(settings).toContain('class="settings-card"');
    expect(settings).toContain("Set AliasMode as default browser");
    expect(settings).toContain("Add another browser");
    expect(settings).not.toContain('role="dialog"');
    expect(settings).not.toContain("Dismiss link");
  } finally {
    for (const [key, descriptor] of [["window", windowDescriptor], ["navigator", navigatorDescriptor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("creation exposes local opt-in rotation and resets it with each new draft", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
  expect(app).toContain('randomizeFingerprintOnLaunch: "false"');
  expect(app).toContain('checked={form.randomizeFingerprintOnLaunch === "true"}');
  expect(app).toContain('setForm({ ...BLANK_FORM');
  expect(app).toContain('randomizeFingerprintOnLaunch: form.randomizeFingerprintOnLaunch === "true"');
  const settingsStart = app.indexOf('view === "settings" ? (');
  const routingPanel = app.indexOf('settingsTab === "browser-routing" && <BrowserRoutingSettings />');
  expect(routingPanel).toBeGreaterThan(settingsStart);
  expect(routingPanel).toBeLessThan(app.indexOf('settingsTab === "account" && (', settingsStart));
});


const safari = {name: "Safari", path: "/Applications/Safari.app"};
const chrome = {name: "Chrome", path: "/Applications/Chrome.app"};
const brave = {name: "Brave", path: "/Applications/Brave.app"};

test("browser ordering deduplicates detected and added apps and appends new apps", () => {
  expect(orderedBrowsers([safari, chrome], [safari, brave], []).map(item => item.path)).toEqual([safari.path, chrome.path, brave.path]);
  expect(orderedBrowsers([safari, chrome], [brave], [chrome.path, "/missing.app", safari.path]).map(item => item.path)).toEqual([chrome.path, safari.path, brave.path]);
  expect(orderedBrowsers([safari], [], [chrome.path])).toEqual([safari]);
});

test("manual moves preserve identities and safely ignore unavailable or edge moves", () => {
  const items = [safari, chrome, brave];
  expect(moveBrowser(items, chrome.path, -1)).toEqual([chrome.path, safari.path, brave.path]);
  expect(moveBrowser(items, safari.path, 1)).toEqual([chrome.path, safari.path, brave.path]);
  expect(moveBrowser(items, safari.path, -1)).toEqual(items.map(item => item.path));
  expect(moveBrowser(items, brave.path, 1)).toEqual(items.map(item => item.path));
  expect(moveBrowser(items, "/missing.app", 1)).toEqual(items.map(item => item.path));
  expect(items).toEqual([safari, chrome, brave]);
});

test("saved browser order survives reload and tolerates damaged or blocked storage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    for (const [raw, expected] of [
      [JSON.stringify([chrome.path, safari.path]), [chrome.path, safari.path]],
      [JSON.stringify([chrome.path, null, chrome.path, 1]), [chrome.path]],
      ["invalid", []], ["{}", []],
    ] as const) {
      Object.defineProperty(globalThis, "localStorage", {configurable: true, value: {getItem: () => raw}});
      expect(readBrowserOrder()).toEqual([...expected]);
    }
    Object.defineProperty(globalThis, "localStorage", {configurable: true, value: {getItem: () => {throw Error("blocked");}}});
    expect(readBrowserOrder()).toEqual([]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("link summary removes tracking query and fragment without changing the URL", () => {
  const url = "https://one.google.com/ai-student?token=private&utm_campaign=" + "tracking".repeat(100) + "#secret";
  expect(linkSummary(url)).toBe("one.google.com/ai-student");
  expect(linkSummary("https://example.com/")).toBe("example.com");
  expect(linkSummary("http://localhost:8080/a")).toBe("localhost:8080/a");
  expect(url).toContain("token=private");
});
