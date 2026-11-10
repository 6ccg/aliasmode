import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { BrowserRoutingSettings, orderedBrowsers, moveTo, linkSummary } from "./url-router.tsx";
import { BrowserChooser, acceptSnapshot } from "./browser-chooser.tsx";

test.each(["MacIntel", "Win32"])("routing settings and idle chooser on %s", (platform) => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => [] } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform } });
  try {
    expect(renderToStaticMarkup(<I18nProvider><BrowserChooser profiles={[]} local /></I18nProvider>)).toBe("");
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
  const url = "https://one.google.com/ai-student?token=private&utm_campaign=" + "tracking".repeat(100) + "#secret";
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
