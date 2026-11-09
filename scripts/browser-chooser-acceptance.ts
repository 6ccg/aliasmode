/** Isolated browser UI acceptance suite. Never launches real profiles or native browsers.
 * Run: bun scripts/browser-chooser-acceptance.ts
 * CHOOSER_BROWSER_EXECUTABLE overrides Chrome; CHOOSER_ARTIFACT_DIR retains screenshots.
 * --build-only validates the real-component harness without launching a browser.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const root = resolve(import.meta.dir, "..");
// Inside the repo so the generated entry resolves the installed React package.
const work = await mkdtemp(join(root, ".chooser-acceptance-"));
const output = join(work, "dist");
const artifacts = process.env.CHOOSER_ARTIFACT_DIR
  ? resolve(process.env.CHOOSER_ARTIFACT_DIR) : await mkdtemp(join(tmpdir(), "chooser-artifacts-"));
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const harness = `
import React from "react";
import { createRoot } from "react-dom/client";
import { UrlRouter, BrowserRoutingSettings } from "../web/url-router";
import "../web/styles.css";
import { I18nProvider } from "../web/i18n";
localStorage.setItem("aliasmode.shell.language", "en-US");
Object.defineProperty(navigator, "platform", { value: "MacIntel" });
const params = new URLSearchParams(location.search);
const url = "https://one.google.com/ai-student?plans=1&utm_campaign=" + "tracking".repeat(100);
const browsers = ["Safari", "Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"].map(name => ({name, path: "/Applications/" + name + ".app"}));
let nextId = 0;
const link = value => ({id: String(++nextId), url: value});
const state = window.preview = {
  urls: (params.has("duplicate") ? [url, url] : [url]).map(link), calls: [], fetches: [],
  fail: false, delay: 0, fetchDelay: 0, failDismiss: false, failRestore: false,
  pollDelay: 0, pollsStarted: 0, finishDelay: 0, addDuringFinish: false, presented: false,
  presentDelay: params.has("present-failure") ? 100 : 0, failPresent: params.has("present-failure"),
  listenerDelay: params.has("listener-delay") ? 350 : 0,
  listenerFailures: params.has("listener-failure") ? 1 : 0,
  add: value => state.urls.push(link(value)),
};
// Test-only lifecycle tracing: keep production components free of diagnostic hooks.
const focusTrace = state.focusTrace = [];
const traceEnabled = !params.has("no-focus-trace");
const describeFocus = element => element ? {
  tag: element.tagName, id: element.id, className: element.className,
  connected: element.isConnected,
} : null;
const traceFocus = (kind, target, detail = {}) => {
  if (!traceEnabled) return;
  focusTrace.push({time: performance.now(), kind, target: describeFocus(target),
    active: describeFocus(document.activeElement), bodyClass: document.body.className,
    documentFocused: document.hasFocus(), ...detail});
  if (focusTrace.length > 300) focusTrace.shift();
};
if (traceEnabled) {
for (const event of ["focusin", "focusout"]) document.addEventListener(event, e => {
  traceFocus(event, e.target, {relatedTarget: describeFocus(e.relatedTarget)});
}, true);
const originalFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (...args) {
  traceFocus("focus-call-before", this, {stack: new Error().stack});
  const result = originalFocus.apply(this, args);
  traceFocus("focus-call-after", this);
  return result;
};
for (const method of ["add", "remove"]) {
  const original = DOMTokenList.prototype[method];
  DOMTokenList.prototype[method] = function (...tokens) {
    const tracked = this === document.body.classList && tokens.includes("browser-chooser-active");
    if (tracked) traceFocus("body-class-" + method + "-before", document.body);
    const result = original.apply(this, tokens);
    if (tracked) traceFocus("body-class-" + method + "-after", document.body);
    return result;
  };
}
new MutationObserver(() => traceFocus("root-mutation", document.getElementById("root")))
  .observe(document.getElementById("root"), {childList: true});
}
const callbacks = new Map();
const listeners = new Map();
let callbackId = 0;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
state.nativeClose = (id = state.urls[0]?.id) => {
  if (!id) return;
  for (const [eventId, listener] of listeners) {
    callbacks.get(listener.handler)?.({event: listener.event, id: eventId, payload: id});
  }
};
window.__TAURI_INTERNALS__ = {
  transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id; },
  invoke: async (command, args) => {
  state.calls.push({command, args});
  if (traceEnabled && ["present_browser_chooser", "finish_browser_chooser", "dismiss_browser_url"].includes(command)) traceFocus("native-" + command, document.activeElement, {args});
  if (command === "plugin:event|listen") {
    if (args.event !== "browser-chooser-close-requested" || args.target.label !== "main") throw new Error("Unexpected event subscription");
    if (state.listenerDelay) await new Promise(resolve => setTimeout(resolve, state.listenerDelay));
    if (state.listenerFailures > 0) { state.listenerFailures--; throw new Error("Native close listener unavailable"); }
    listeners.set(args.handler, args);
    return args.handler;
  }
  if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
  if (command === "pending_browser_urls") {
    state.pollsStarted++;
    const snapshot = state.urls.map(item => ({...item}));
    if (state.pollDelay) await new Promise(resolve => setTimeout(resolve, state.pollDelay));
    return snapshot;
  }
  if (command === "installed_browsers") return browsers;
  if (command === "browser_order") return JSON.parse(localStorage.getItem("mock-native-order") || "[]");
  if (command === "save_browser_order") { localStorage.setItem("mock-native-order", JSON.stringify(args.order)); return; }
  if (command === "default_browser_status") return {isDefault: true};
  if (command === "present_browser_chooser") {
    if (state.presentDelay) await new Promise(resolve => setTimeout(resolve, state.presentDelay));
    if (state.failPresent) throw new Error("Could not show the compact browser chooser");
    state.presented = true;
    return;
  }
  if (command === "finish_browser_chooser") {
    if (!state.urls.length && document.querySelector(".browser-chooser")) throw new Error("Chooser still mounted during restoration");
    if (state.finishDelay) await new Promise(resolve => setTimeout(resolve, state.finishDelay));
    if (state.addDuringFinish) { state.addDuringFinish = false; state.add("https://arrived.example/new"); }
    if (!state.urls.length) {
      if (state.failRestore) throw new Error("Could not restore the dashboard window");
      state.presented = false;
    }
    return state.urls.map(item => ({...item}));
  }
  if (command === "open_browser_url") {
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.fail) throw new Error("Browser could not be opened");
    return;
  }
  if (command === "dismiss_browser_url") {
    if (state.failDismiss) throw new Error("Could not dismiss the link");
    if (state.urls[0]?.id === args.id) state.urls.shift();
    return state.urls.map(item => ({...item}));
  }
  throw new Error("Unmocked native command: " + command);
}};
window.fetch = async (input, init) => {
  const path = String(input);
  if (path === "/ui/api/shell-language") return new Response(JSON.stringify({language: "en-US"}), {headers: {"Content-Type": "application/json"}});
  state.fetches.push({path, init});
  if (state.fetchDelay) await new Promise(resolve => setTimeout(resolve, state.fetchDelay));
  if (!/^\\/ui\\/api\\/profiles\\/[^/]+\\/(open|open-url)$/.test(path)) throw new Error("Unmocked fetch: " + path);
  return new Response(JSON.stringify({ok: true}), {headers: {"Content-Type": "application/json"}});
};
createRoot(document.getElementById("root")).render(<I18nProvider>{params.has("settings") ? <BrowserRoutingSettings /> : <><button id="background">Background control</button><UrlRouter local profiles={Array.from({length: params.has("long") ? 50 : 1}, (_, i) => ({id: String(i), name: "Work profile " + i, engine: i === 0 ? "chromium" : "firefox", fingerprintOs: i === 0 ? "macos" : "windows", ...(i === 0 ? {proxyCountryCode: "US"} : {})}))} /></>}</I18nProvider>);
`;
async function withinViewport(page: Page) {
  const bounds = await page.locator('[role="dialog"]').boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 480.5 && bounds.y + bounds.height <= 520.5, JSON.stringify(bounds));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Document horizontal overflow");
  const footer = await page.locator(".browser-chooser-footer").boundingBox();
  assert(footer && footer.y + footer.height <= 520.5, "Footer falls outside viewport");
}
async function dismissed(page: Page) {
  await page.getByRole("dialog").waitFor({state: "hidden"});
  await page.waitForFunction(() => !(window as any).preview.presented && !document.body.classList.contains("browser-chooser-active"));
  // Native acknowledgement and effect cleanup are not the user-visible result.
  // Wait for the dashboard itself, retaining a bounded failure if it stays hidden.
  await page.locator("#background").waitFor({state: "visible"});
}
async function focused(page: Page, selector: string) {
  await page.waitForFunction(s => document.activeElement?.matches(s), selector);
  assert(await page.evaluate(s => document.activeElement?.matches(s), selector), `Expected focus on ${selector}`);
}
try {
  await mkdir(artifacts, {recursive: true});
  await writeFile(join(work, "entry.tsx"), harness);
  const build = await Bun.build({entrypoints: [join(work, "entry.tsx")], outdir: output, target: "browser", naming: "[name].[ext]"});
  assert(build.success, build.logs.map(String).join("\n"));
  await writeFile(join(output, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>');
  if (process.argv.includes("--build-only")) {
    console.log("Browser chooser harness build passed (browser checks not run).");
  } else {
    server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.includes("..")) return new Response("Not found", {status: 404});
      return new Response(Bun.file(join(output, path === "/" ? "index.html" : path)));
    }});
    const executablePath = process.env.CHOOSER_BROWSER_EXECUTABLE || [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ].find(existsSync);
    browser = await chromium.launch({headless: true, executablePath});
    const context = await browser.newContext({viewport: {width: 480, height: 520}, reducedMotion: "reduce"});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // No request can escape this isolated app, even if production code changes.
    await context.route("**/*", route => new URL(route.request().url()).origin === server!.url.origin ? route.continue() : route.abort());
    const visit = async (query = "") => {
      await page.goto(server!.url.href + query);
      if (!query.includes("settings")) { await page.getByRole("dialog").waitFor(); await page.waitForFunction(() => (window as any).preview.calls.some((c: any) => c.command === "present_browser_chooser")); }
      else await page.getByRole("button", {name: "Move Safari down", exact: true}).waitFor();
    };
    const snapshot = async (name: string) => page.screenshot({path: join(artifacts, name + ".png")});
    await visit();
    assert.equal(await page.getByRole("button", {name: "Show full link"}).getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".browser-chooser-summary > span").nth(1).innerText(), "one.google.com/ai-student");
    await withinViewport(page);
    assert(await page.locator(".browser-chooser-content").evaluate(el => el.scrollHeight <= el.clientHeight + 1), "Five browsers and one profile should fit without scrolling");
    await snapshot("compact-light");
    assert.equal(await page.locator(".profile-routing-chip").nth(0).innerText(), "Chromium");
    assert.equal(await page.locator(".profile-routing-chip").nth(1).innerText(), "macOS");
    assert.equal(await page.locator(".profile-routing-flag").innerText(), "🇺🇸");
    assert.equal(await page.getByRole("img", {name: "Last checked proxy country: US"}).count(), 1);
    assert.equal(await page.locator(".browser-chooser-close").count(), 0, "Native titlebar close replaces the duplicate in-page ×");
    await page.getByRole("button", {name: "Show full link", exact: true}).focus();
    await page.keyboard.press("Shift+Tab");
    await focused(page, ".browser-chooser-footer button");
    await page.keyboard.press("Tab");
    await focused(page, ".browser-chooser-detail");
    await page.getByRole("button", {name: "Show full link"}).click();
    assert.equal(await page.getByRole("button", {name: "Hide full link"}).getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#browser-chooser-full-url").innerText(), await page.evaluate(() => (window as any).preview.urls[0].url));
    await page.getByRole("button", {name: "Hide full link"}).click();
    assert.equal(await page.locator("#browser-chooser-full-url").count(), 0);
    await page.getByRole("button", {name: "Show full link"}).click();
    await withinViewport(page);
    await snapshot("details-expanded");
    await page.keyboard.press("Escape");
    await dismissed(page);
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 1);

    await visit("?duplicate");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (window as any).preview.urls.length === 1);
    assert.equal(await page.getByRole("dialog").count(), 1, "Escape should consume only one duplicate");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Choose once for this link");
    await page.keyboard.press("Escape");
    await dismissed(page);
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 0);

    // Real Tauri event API plumbing drives the same dismissal path as native Close/Cmd+W.
    await visit("?duplicate&long");
    const firstId = await page.evaluate(() => (window as any).preview.urls[0].id);
    await page.getByRole("button", {name: "Show full link"}).click();
    await page.getByRole("textbox", {name: "Find a profile"}).fill("profile 49");
    await page.evaluate(() => { const s = (window as any).preview; s.nativeClose(); s.nativeClose(); });
    await page.waitForFunction(() => (window as any).preview.urls.length === 1);
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Choose once for this link");
    assert.equal(await page.getByRole("button", {name: "Show full link"}).getAttribute("aria-expanded"), "false", "Duplicate URL receives fresh detail state");
    assert.equal(await page.getByRole("textbox", {name: "Find a profile"}).inputValue(), "", "Duplicate URL receives fresh search state");
    await page.evaluate(id => (window as any).preview.nativeClose(id), firstId);
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 1, "Late native event must not consume the next identical URL");
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 2);
    await page.evaluate(id => (window as any).preview.nativeClose(id), firstId);
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 2, "Late close after restoration is ignored");
    assert(await page.locator("#background").isVisible());
    await page.locator("#background").focus();
    await focused(page, "#background");

    // A warm URL in the same document must hide, then restore, the dashboard again.
    await page.evaluate(() => (window as any).preview.add("https://warm.example/link"));
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(() => (window as any).preview.presented && document.body.classList.contains("browser-chooser-active"));
    assert.equal(await page.locator("#background").isVisible(), false, "Warm chooser hides the dashboard");
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);
    assert(await page.locator("#background").isVisible(), "Warm dismissal restores the dashboard");
    await focused(page, "#background");
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 3);

    // Repeat warm restoration with no focus/class monkeypatches installed.
    await visit("?no-focus-trace");
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);
    await page.locator("#background").focus();
    await focused(page, "#background");
    await page.evaluate(() => (window as any).preview.add("https://warm.example/uninstrumented"));
    await page.waitForFunction(() => (window as any).preview.presented && document.body.classList.contains("browser-chooser-active"));
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);
    await focused(page, "#background");

    await visit("?duplicate");
    await page.evaluate(() => { const s = (window as any).preview; s.fail = true; s.delay = 300; });
    await page.locator(".browser-chooser-grid button").first().evaluate(el => {
      (el as HTMLButtonElement).click();
      (window as any).preview.nativeClose();
    });
    await page.keyboard.press("Escape");
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 2, "Native close and Escape during a failed open must retain both requests");
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 0);
    await page.evaluate(() => { (window as any).preview.fail = false; });
    await page.locator(".browser-chooser-grid button").first().click();
    await page.evaluate(() => (window as any).preview.nativeClose());
    await page.waitForFunction(() => (window as any).preview.urls.length === 1);
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Choose once for this link");
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 1, "Successful open and concurrent native close consume one request");

    await visit();
    await page.evaluate(() => { (window as any).preview.fetchDelay = 250; });
    await page.locator(".profile-choice").click();
    await page.evaluate(() => (window as any).preview.nativeClose());
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 1, "Opening a profile owns the link until it finishes");
    await dismissed(page);
    assert.deepEqual(await page.evaluate(() => (window as any).preview.fetches.map((f: any) => f.path)), ["/ui/api/profiles/0/open", "/ui/api/profiles/0/open-url"], "Closing the chooser never calls a session/profile shutdown endpoint");

    // A delayed poll taken before dismissal must never resurrect the consumed URL.
    await visit();
    const startedPolls = await page.evaluate(() => { const s = (window as any).preview; s.pollDelay = 600; return s.pollsStarted; });
    await page.waitForFunction(count => (window as any).preview.pollsStarted > count, startedPolls);
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);
    await page.waitForTimeout(750);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 0);

    await visit();
    await page.evaluate(() => { (window as any).preview.failDismiss = true; (window as any).preview.nativeClose(); });
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 1);
    await page.evaluate(() => { (window as any).preview.failDismiss = false; (window as any).preview.nativeClose(); });
    await dismissed(page);

    await visit();
    await page.evaluate(() => { (window as any).preview.failRestore = true; (window as any).preview.nativeClose(); });
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Could not restore/);
    assert.equal(await page.locator(".browser-chooser-link").count(), 0, "Link UI is removed before restoration");
    assert.equal(await page.evaluate(() => (window as any).preview.presented), true, "Restore failure retains native close protection");
    await page.evaluate(() => { (window as any).preview.failRestore = false; });
    await page.getByRole("button", {name: "Retry", exact: true}).click();
    await dismissed(page);
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 1, "Restore retry cannot consume another link");

    await visit();
    await page.evaluate(() => { const s = (window as any).preview; s.finishDelay = 150; s.addDuringFinish = true; s.nativeClose(); });
    await page.waitForFunction(() => document.querySelector(".browser-chooser-summary")?.textContent?.includes("arrived.example/new"));
    assert.equal(await page.evaluate(() => (window as any).preview.presented), true, "New URL during finish keeps the compact presentation");
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);

    await visit("?present-failure");
    await page.evaluate(() => { const s = (window as any).preview; s.finishDelay = 300; s.nativeClose(); });
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".browser-chooser").count(), 0, "Late presentation failure must not resurrect a chooser during finish");
    await dismissed(page);

    await page.goto(server!.url.href + "?listener-delay");
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.evaluate(() => (window as any).preview.calls.some((c: any) => c.command === "present_browser_chooser")), false, "Do not show native chooser before close listener is ready");
    await page.waitForFunction(() => (window as any).preview.presented);
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);

    await page.goto(server!.url.href + "?listener-failure");
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Native close listener unavailable/);
    assert.equal(await page.evaluate(() => (window as any).preview.presented), false);
    await page.waitForFunction(() => (window as any).preview.presented);
    await page.evaluate(() => (window as any).preview.nativeClose());
    await dismissed(page);

    await visit();
    await page.evaluate(() => { (window as any).preview.fail = true; (window as any).preview.delay = 150; });
    // Same event turn catches duplicate submissions before React commits disabled state.
    await page.locator(".browser-chooser-grid button").first().evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /Browser could not be opened/);
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "open_browser_url").length), 1);
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 1);
    await withinViewport(page);
    await snapshot("open-error");
    await page.evaluate(() => { (window as any).preview.fail = false; });
    await page.locator(".browser-chooser-grid button").first().click();
    await dismissed(page);

    await visit("?long");
    assert.equal(await page.locator(".profile-choice").count(), 50);
    await withinViewport(page);
    await snapshot("many-profiles");
    await page.getByRole("textbox", {name: "Find a profile"}).fill("no such profile");
    assert.equal(await page.locator(".profile-choice").count(), 0);
    assert(await page.getByText("No matching profiles.", {exact: true}).isVisible());
    await page.getByRole("textbox", {name: "Find a profile"}).fill("profile 49");
    assert.equal(await page.locator(".profile-choice").count(), 1);
    await page.locator(".profile-choice").click();
    await dismissed(page);
    assert.deepEqual(await page.evaluate(() => (window as any).preview.fetches.map((f: any) => f.path)), ["/ui/api/profiles/49/open", "/ui/api/profiles/49/open-url"]);

    await visit("?settings");
    assert(await page.getByRole("button", {name: "Move Safari up", exact: true}).isDisabled());
    assert(await page.getByRole("button", {name: "Move Chromium down", exact: true}).isDisabled());
    await page.getByRole("button", {name: "Move Safari down", exact: true}).click();
    await page.waitForFunction(() => document.querySelector(".browser-order-row strong")?.textContent === "Google Chrome");
    await snapshot("browser-order-settings");
    await page.reload();
    await page.locator(".browser-order-row strong").first().waitFor();
    assert.equal(await page.locator(".browser-order-row strong").first().innerText(), "Google Chrome");
    await visit();
    assert.match(await page.locator(".browser-chooser-grid button").first().innerText(), /Google Chrome/);
    await visit("?settings");
    await page.getByRole("button", {name: "Move Safari up", exact: true}).click();
    await page.waitForFunction(() => document.querySelector(".browser-order-row strong")?.textContent === "Safari");
    await visit();
    assert.match(await page.locator(".browser-chooser-grid button").first().innerText(), /Safari/);
    const light = await page.locator(".browser-chooser").evaluate(el => getComputedStyle(el).backgroundImage);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const dark = await page.locator(".browser-chooser").evaluate(el => getComputedStyle(el).backgroundImage);
    assert.notEqual(dark, light, "Chooser should use dark theme tokens");
    await withinViewport(page);
    await snapshot("compact-dark");
    assert.deepEqual(errors, [], "Unexpected browser errors");
    console.log(`Browser chooser acceptance passed. Screenshots: ${artifacts}`);
  }
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({path: join(artifacts, "failure.png")}).catch(() => {});
    await writeFile(join(artifacts, "failure-state.json"), JSON.stringify(await page.evaluate(() => {
      const state = (window as any).preview;
      const describe = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return {html: element.outerHTML, visibility: style.visibility, display: style.display, bounds: element.getBoundingClientRect().toJSON()};
      };
      return {bodyClass: document.body.className, presented: state?.presented, urls: state?.urls, calls: state?.calls,
        activeElement: document.activeElement?.outerHTML ?? null, focusTrace: state?.focusTrace,
        background: describe("#background"), root: describe("#root"), dialog: describe('[role="dialog"]')};
    }), null, 2)).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  server?.stop(true);
  await rm(work, {recursive: true, force: true});
}
