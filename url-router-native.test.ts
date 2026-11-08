import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const router = read("./src-tauri/src/url_router.rs");
const main = read("./src-tauri/src/lib.rs");
const shutdown = read("./src-tauri/src/shutdown.rs");

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

test("dismissal restores the dashboard only after all pending links are consumed", () => {
  const dismiss = router.slice(router.indexOf("pub fn dismiss_browser_url("), router.indexOf("pub struct Browser"));
  expect(dismiss).toContain("pending.remove(index)");
  expect(dismiss).toContain("if pending.is_empty() {\n        restore_dashboard(&window)?;");
  expect(dismiss).not.toContain("pending.clear()");
});

test("temporary geometry restores original visibility and never steals browser focus", () => {
  const restore = router.slice(router.indexOf("fn restore(&self"), router.indexOf("fn chooser_size("));
  for (const operation of ["set_size(self.size)", "set_position(self.position)", "set_closable(self.closable)", "set_resizable(self.resizable)", "window.minimize()", "window.maximize()", "window.set_fullscreen(true)", "window.hide()"])
    expect(restore).toContain(operation);
  expect(restore).not.toContain("set_focus");
});

test("native close during routing cannot terminate active browser profiles or discard links", () => {
  expect(router).toContain("window.set_closable(false)?;");
  const guard = shutdown.slice(shutdown.indexOf("api.prevent_close()"), shutdown.indexOf("state.in_progress.swap"));
  expect(guard).toContain("if crate::url_router::chooser_active(&app)");
  expect(guard).toContain("return;");
  expect(guard).not.toContain("pending");
});
