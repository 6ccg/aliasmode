import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { BrowserRoutingSettings, UrlRouter } from "./url-router.tsx";

test("routing settings are a settings card; idle URL inbox has no floating entry point", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => [] } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
  try {
    expect(renderToStaticMarkup(<UrlRouter profiles={[]} local />)).toBe("");
    const settings = renderToStaticMarkup(<BrowserRoutingSettings />);
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
