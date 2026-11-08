import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const store = read("./src-tauri/src/browser_order.rs");
const router = read("./src-tauri/src/url_router.rs");

test("native browser ordering is authorized, permissioned and registered", () => {
  const main = read("./src-tauri/src/lib.rs");
  const permissions = read("./src-tauri/permissions/url-router.toml");
  for (const command of ["browser_order", "save_browser_order"]) {
    expect(main).toContain(`browser_order::${command},`);
    expect(permissions).toContain(`"${command}"`);
    const body = store.slice(store.indexOf(`pub fn ${command}(`));
    expect(body.indexOf("authorize(&window, &origin)?;")).toBeLessThan(body.indexOf("preferences_path(&window)?"));
  }
  expect(store).toContain("app_data_dir()");
  expect(store).toContain('join("browser-order.json")');
  expect(store).not.toContain("localStorage");
  expect(store).not.toContain("Command::new");
});

test("actual browser icons are generated locally on the main thread with bounded PNG output", () => {
  const icon = router.slice(router.indexOf("fn browser_with_icon("), router.indexOf("async fn on_browser_main_thread"));
  expect(icon).toContain("browser(path)?");
  expect(icon).toContain("iconForFile");
  expect(icon).toContain("NSBitmapImageFileType::PNG");
  expect(icon).toContain("png.length() > 256 * 1024");
  expect(icon).toContain("data:image/png;base64,");
  const commands = router.slice(router.indexOf("async fn on_browser_main_thread"), router.indexOf("pub fn open_browser_url("));
  expect(commands).toContain("app.run_on_main_thread");
  expect(commands).toContain("pub async fn installed_browsers");
  expect(commands).toContain("pub async fn validate_browser_application");
  expect(commands.match(/authorize\(&window, &origin\)\?;/g)?.length).toBe(2);
});
