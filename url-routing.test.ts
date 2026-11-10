import { test, expect } from "bun:test";
import { ProfileStore } from "./store.ts";
import { parseExport } from "./parse.ts";
import { handleUiRequest } from "./ui.ts";
import { isRoutableUrl } from "./web/url-router.tsx";

function setup() {
  const store = new ProfileStore(":memory:");
  const profile = parseExport("id=route1\nname=Routing\nua=Mozilla/5.0\n******************").profiles[0]!;
  store.upsertProfile(profile);
  store.recordLaunch({ profileId: "route1", pid: 1, debugPort: 1234, startedAt: 1, ws: "firefox://127.0.0.1:1234/test" });
  const opened: unknown[] = [];
  const launcher = { certifiedActive: async () => true, navigate: async (...args: unknown[]) => { opened.push(args); } } as any;
  const request = (url: unknown, headers: Record<string, string> = {}, options = {}, remote: any = null) => handleUiRequest(new Request("http://localhost/ui/api/profiles/route1/open-url", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ url }),
  }), launcher, store, remote, options);
  return { store, opened, request, launcher };
}
test("chooser reads local display data without waiting for browser process reconciliation", async () => {
  const { store, launcher } = setup();
  launcher.reconcileOrphans = () => { throw Error("Chooser must not scan processes"); };
  launcher.browserIconPaths = () => ({ firefox: "/runtime/Firefox.app" });
  try {
    const request = () => new Request("http://localhost/ui/api/browser-chooser");
    const response = await handleUiRequest(request(), launcher, store, null, {});
    const data = await response!.json();
    expect(data.local).toBe(true);
    expect(data.profiles.map((item: any) => item.id)).toEqual(["route1"]);
    expect(data.iconPaths.firefox).toBe("/runtime/Firefox.app");
    const cloud = await handleUiRequest(request(), launcher, store, null, { runtimeMode: "cloud" });
    expect(await cloud!.json()).toEqual({ local: false, profiles: [], iconPaths: {} });
  } finally { store.close(); }
});
test("URL routing opens a new tab through the certified runtime without changing profile settings", async () => {
  const { store, opened, request } = setup();
  try {
    const before = store.getProfile("route1");
    expect((await request("https://example.com/a?q=1#b"))!.status).toBe(200);
    expect(opened).toEqual([["firefox://127.0.0.1:1234/test", ["https://example.com/a?q=1#b"], false]]);
    expect(store.getProfile("route1")).toEqual(before);
  } finally { store.close(); }
});
test("URL routing rejects unsafe schemes, embedded credentials, oversized URLs and cross-origin requests", async () => {
  const { store, opened, request } = setup();
  try {
    for (const url of ["javascript:alert(1)", "file:///tmp/a", "https://user:pass@example.com", "--args", null, "https://example.com/" + "a".repeat(16384)]) {
      expect((await request(url))!.status).toBe(400);
      expect(isRoutableUrl(url)).toBe(false);
    }
    expect((await request("https://example.com", { origin: "https://evil.example" }))!.status).toBe(403);
    expect(opened).toHaveLength(0);
  } finally { store.close(); }
});
test("URL routing rejects cloud, remote, and inactive runtimes", async () => {
  const { store, opened, request, launcher } = setup();
  try {
    expect((await request("https://example.com", {}, { cloudBrowser: {} } as any))!.status).toBe(400);
    expect((await request("https://example.com", {}, {}, {}))!.status).toBe(400);
    launcher.certifiedActive = async () => false;
    expect((await request("https://example.com"))!.status).toBe(409);
    expect(opened).toHaveLength(0);
  } finally { store.close(); }
});
