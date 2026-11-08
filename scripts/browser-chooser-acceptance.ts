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
const state = window.preview = { urls: params.has("duplicate") ? [url, url] : [url], calls: [], fetches: [], fail: false, delay: 0 };
window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
  state.calls.push({command, args});
  if (command === "pending_browser_urls") return [...state.urls];
  if (command === "installed_browsers") return browsers;
  if (command === "browser_order") return JSON.parse(localStorage.getItem("mock-native-order") || "[]");
  if (command === "save_browser_order") { localStorage.setItem("mock-native-order", JSON.stringify(args.order)); return; }
  if (command === "default_browser_status") return {isDefault: true};
  if (command === "present_browser_chooser") return;
  if (command === "open_browser_url") {
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    if (state.fail) throw new Error("Browser could not be opened");
    return;
  }
  if (command === "dismiss_browser_url") { const index = state.urls.indexOf(args.url); if (index >= 0) state.urls.splice(index, 1); return; }
  throw new Error("Unmocked native command: " + command);
}};
window.fetch = async (input, init) => {
  const path = String(input);
  if (path === "/ui/api/shell-language") return new Response(JSON.stringify({language: "en-US"}), {headers: {"Content-Type": "application/json"}});
  state.fetches.push({path, init});
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
async function focused(page: Page, selector: string) {
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
    await page.getByRole("button", {name: "Dismiss link", exact: true}).focus();
    await page.keyboard.press("Shift+Tab");
    await focused(page, ".browser-chooser-footer button");
    await page.keyboard.press("Tab");
    await focused(page, ".browser-chooser-close");
    await page.getByRole("button", {name: "Show full link"}).click();
    assert.equal(await page.getByRole("button", {name: "Hide full link"}).getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("#browser-chooser-full-url").innerText(), await page.evaluate(() => (window as any).preview.urls[0]));
    await page.getByRole("button", {name: "Hide full link"}).click();
    assert.equal(await page.locator("#browser-chooser-full-url").count(), 0);
    await page.getByRole("button", {name: "Show full link"}).click();
    await withinViewport(page);
    await snapshot("details-expanded");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({state: "hidden"});
    assert.equal(await page.evaluate(() => (window as any).preview.calls.filter((c: any) => c.command === "dismiss_browser_url").length), 1);

    await visit("?duplicate");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (window as any).preview.urls.length === 1);
    assert.equal(await page.getByRole("dialog").count(), 1, "Escape should consume only one duplicate");
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "Choose once for this link");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({state: "hidden"});
    assert.equal(await page.evaluate(() => (window as any).preview.urls.length), 0);

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
    await page.getByRole("dialog").waitFor({state: "hidden"});

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
    await page.getByRole("dialog").waitFor({state: "hidden"});
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
  if (page) await page.screenshot({path: join(artifacts, "failure.png")}).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server?.stop(true);
  await rm(work, {recursive: true, force: true});
}
