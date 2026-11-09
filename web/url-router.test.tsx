import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { I18nProvider } from "./i18n.tsx";
import { BrowserRoutingSettings, UrlRouter, orderedBrowsers, moveBrowser, readBrowserOrder, linkSummary, scheduleDashboardFocus } from "./url-router.tsx";

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


test("chooser captures dashboard focus before hiding it and reveals it before restoring focus", () => {
  const router = readFileSync(new URL("./url-router.tsx", import.meta.url), "utf8");
  const effectStart = router.indexOf("if (!chooserVisible) return;");
  const effectEnd = router.indexOf("}, [chooserVisible]);", effectStart);
  expect(effectStart).toBeGreaterThan(-1);
  expect(effectEnd).toBeGreaterThan(effectStart);
  const effect = router.slice(effectStart, effectEnd);
  const capture = effect.indexOf("const previous = document.activeElement");
  const hide = effect.indexOf('document.body.classList.add("browser-chooser-active")');
  const reveal = effect.indexOf('document.body.classList.remove("browser-chooser-active")');
  const restore = effect.indexOf("scheduleDashboardFocus(previous");
  expect(capture).toBeGreaterThan(-1);
  expect(hide).toBeGreaterThan(capture);
  expect(reveal).toBeGreaterThan(hide);
  expect(restore).toBeGreaterThan(reveal);
});


test("deferred dashboard focus waits for visibility and cannot steal focus after reopening", () => {
  const keys = ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "document"] as const;
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  let callback: FrameRequestCallback = () => {};
  let active = false;
  let visibility = "visible";
  let focused = 0;
  const body = {};
  const fakeDocument = {body, activeElement: body};
  Object.defineProperty(globalThis, "document", {configurable: true, value: fakeDocument});
  const previous = {isConnected: true, getClientRects: () => [1], focus: () => focused++} as unknown as HTMLElement;
  Object.defineProperty(globalThis, "requestAnimationFrame", {configurable: true, value: (fn: FrameRequestCallback) => { callback = fn; return 1; }});
  Object.defineProperty(globalThis, "cancelAnimationFrame", {configurable: true, value: () => {}});
  Object.defineProperty(globalThis, "getComputedStyle", {configurable: true, value: () => ({visibility})});
  try {
    scheduleDashboardFocus(previous, () => active);
    expect(focused).toBe(0);
    callback(0);
    expect(focused).toBe(1);
    scheduleDashboardFocus(previous, () => active);
    active = true; // A new URL arrives before React has committed its chooser.
    callback(0);
    expect(focused).toBe(1);
    active = false;
    const cancel = scheduleDashboardFocus(previous, () => active);
    cancel(); // Reopening cancels the old frame, even if it was already dispatched.
    callback(0);
    expect(focused).toBe(1);
    visibility = "hidden";
    scheduleDashboardFocus(previous, () => active);
    callback(0);
    expect(focused).toBe(1);
    visibility = "visible";
    callback(0); // A later frame sees the restored style and completes focus.
    expect(focused).toBe(2);
    visibility = "hidden";
    const cancelWaiting = scheduleDashboardFocus(previous, () => active);
    callback(0);
    cancelWaiting();
    visibility = "visible";
    callback(0);
    expect(focused).toBe(2);
    visibility = "hidden";
    scheduleDashboardFocus(previous, () => active);
    callback(0);
    active = true;
    visibility = "visible";
    callback(0);
    expect(focused).toBe(2);
    active = false;
    scheduleDashboardFocus(previous, () => active);
    callback(performance.now() + 1001); // Do not restore after the finite deadline.
    expect(focused).toBe(2);
    visibility = "hidden";
    scheduleDashboardFocus(previous, () => active);
    callback(0);
    fakeDocument.activeElement = {}; // User focuses a different dashboard control while waiting.
    visibility = "visible";
    callback(0);
    expect(focused).toBe(2);
    fakeDocument.activeElement = body;
    Object.assign(previous, {isConnected: false});
    scheduleDashboardFocus(previous, () => active);
    callback(0);
    expect(focused).toBe(2);
  } finally {
    keys.forEach((key, index) => {
      if (descriptors[index]) Object.defineProperty(globalThis, key, descriptors[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
