import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const router = read("./src-tauri/src/url_router.rs");
const main = read("./src-tauri/src/lib.rs");
const shutdown = read("./src-tauri/src/shutdown.rs");
const inbox = read("./src-tauri/src/url_inbox.rs");
const frontend = read("./web/url-router.tsx");

// These guard IPC wiring and lifetime invariants, not native window rendering.
test("compact chooser command retains the existing main-window origin authorization", () => {
  const command = router.slice(router.indexOf("pub fn present_browser_chooser("), router.indexOf("fn web_url("));
  expect(command).toContain("authorize(&window, &origin)?;");
  expect(command).toContain("if pending.is_empty()");
  expect(command).toContain("if state.is_some()");
  expect(main).toContain("url_router::present_browser_chooser,");
  expect(main).toContain(".manage(url_router::ChooserPresentation::default())");
  expect(read("./src-tauri/permissions/url-router.toml")).toContain('"present_browser_chooser"');
});

test("new URL intake never reveals the dashboard before chooser rendering", () => {
  const receive = router.slice(router.indexOf("pub fn receive("), router.indexOf("pub fn pending_browser_urls("));
  expect(receive).toContain("if chooser_active(app)");
  expect(receive.indexOf("if chooser_active(app)")).toBeLessThan(receive.indexOf("window.show()"));
  const instance = main.slice(main.indexOf("tauri_plugin_single_instance::init"), main.indexOf(".plugin(tauri_plugin_shell"));
  expect(instance.indexOf('value.starts_with("http://")', instance.indexOf("// Link launches"))).toBeLessThan(instance.indexOf("RevealRequested"));
});

test("dismissal consumes one identity and restoration waits for frontend acknowledgement", () => {
  const dismiss = router.slice(router.indexOf("pub fn dismiss_browser_url("), router.indexOf("pub fn finish_browser_chooser("));
  expect(dismiss).toContain("pending.dismiss(id)");
  expect(dismiss).not.toContain("restore_dashboard(&window)");
  expect(dismiss).not.toContain("pending.clear()");
  expect(inbox).toContain("self.pending.first().is_some_and(|item| item.id == id)");
  const finish = router.slice(router.indexOf("pub fn finish_browser_chooser("), router.indexOf("pub struct Browser"));
  expect(finish).toContain("authorize(&window, &origin)?;");
  expect(finish).toContain("if pending.is_empty() {\n        restore_dashboard(&window)?;");
  expect(main).toContain("url_router::finish_browser_chooser,");
  expect(read("./src-tauri/permissions/url-router.toml")).toContain('"finish_browser_chooser"');
});

test("temporary geometry restores original visibility and never steals browser focus", () => {
  const restore = router.slice(router.indexOf("fn restore(&self"), router.indexOf("fn chooser_size("));
  for (const operation of ["set_size(self.size)", "set_position(self.position)", "set_closable(self.closable)", "set_resizable(self.resizable)", "window.minimize()", "window.maximize()", "window.set_fullscreen(true)", "window.hide()"])
    expect(restore).toContain(operation);
  expect(restore).not.toContain("set_focus");
});

test("native close requests frontend dismissal without entering browser cleanup", () => {
  expect(router).toContain("window.set_closable(true)?;");
  expect(router).not.toContain("window.set_closable(false)?;");
  const guard = shutdown.slice(shutdown.indexOf("api.prevent_close()"), shutdown.indexOf("state.in_progress.swap"));
  expect(guard).toContain("if crate::url_router::handle_chooser_close(&window)");
  expect(guard).toContain("return;");
  const bridge = router.slice(router.indexOf("pub(crate) fn handle_chooser_close"), router.indexOf("fn restore_dashboard"));
  expect(bridge).toContain("pending.close_action(chooser_active(app))");
  expect(bridge).toContain('"browser-chooser-close-requested"');
  expect(bridge).toContain("id.to_string()");
  expect(bridge).not.toContain(".url");
  for (const source of [bridge, frontend]) {
    expect(source).not.toContain("request_shutdown");
    expect(source).not.toContain("app.exit");
  }
});

test("native event subscription is narrowly authorized and awaited before presentation", () => {
  expect(main).toContain('.permission("core:event:allow-listen")');
  expect(main).toContain('.permission("core:event:allow-unlisten")');
  expect(main).not.toContain('.permission("core:event:default")');
  expect(main).not.toContain('.permission("core:event:allow-emit")');
  expect(frontend).toContain('listen<string>("browser-chooser-close-requested"');
  expect(frontend).toContain("if (!pending || !invoke || !closeReady) return;");
  expect(frontend).toContain("pending?.id === id && current?.id === id");
  expect(frontend).toContain("unlisten?.()");
  expect(frontend).not.toContain("browser-chooser-close\"");
});
