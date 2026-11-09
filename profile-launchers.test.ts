import { describe, expect, test } from "bun:test";
import {
  MAX_PROFILE_LAUNCHER_MANIFEST_BYTES,
  MAX_PROFILE_LAUNCHER_REQUEST_BYTES,
  PROFILE_LAUNCHER_EXECUTABLE,
  createProfileLauncherManifest,
  createProfileLauncherRequest,
  parseProfileLauncherManifest,
  parseProfileLauncherRequest,
  profileLauncherBundleId,
  profileLauncherBundlePlan,
  profileLauncherInfoPlist,
  validateProfileLauncherTarget,
} from "./profile-launchers.ts";

const identity = {
  managerBundleId: "com.aliasmode.desktop",
  dataNamespaceId: "11111111-1111-4111-8111-111111111111",
  profileId: "Abc_123-test",
  profileIncarnationId: "22222222-2222-4222-8222-222222222222",
};
const differentUuid = "33333333-3333-4333-8333-333333333333";
const input = { ...identity, displayName: "Work Profile" };
const current = { ...identity, mode: "local", state: "available" };
const make = () => createProfileLauncherManifest(input);

describe("unwired persistent profile launcher identity", () => {
  test("round-trips a bounded, secret-free manifest", () => {
    const value = make();
    expect(parseProfileLauncherManifest(JSON.stringify(value))).toEqual(value);
    expect(Object.keys(value).sort()).toEqual([
      "protocol", "launcherId", "managerBundleId", "dataNamespaceId", "profileId", "profileIncarnationId", "displayName",
    ].sort());
    expect(value.launcherId).toMatch(/^[0-9a-f]{64}$/);
    expect(value.launcherId).toBe("c21e0c325c1d038bbf840ace68d9cc313fd28719078b7b9b3fdb6ad28d5f4645");
    expect(profileLauncherBundleId(value)).toBe(`com.aliasmode.desktop.profile.p${value.launcherId}`);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(MAX_PROFILE_LAUNCHER_MANIFEST_BYTES);
  });

  test("renaming preserves identity, bundle ID and application path", () => {
    const before = make();
    const after = createProfileLauncherManifest({ ...input, displayName: "重命名 / Renamed & <Work>" });
    expect(after.launcherId).toBe(before.launcherId);
    expect(profileLauncherBundleId(after)).toBe(profileLauncherBundleId(before));
    expect(profileLauncherBundlePlan("/Users/Test User", after).bundlePath)
      .toBe(profileLauncherBundlePlan("/Users/Test User", before).bundlePath);
    expect(profileLauncherInfoPlist(after)).not.toBe(profileLauncherInfoPlist(before));
  });

  test("case, data store, profile incarnation and app distribution cannot alias", () => {
    const original = make().launcherId;
    for (const change of [
      { profileId: "abc_123-test" },
      { profileId: "another" },
      { dataNamespaceId: differentUuid },
      { profileIncarnationId: differentUuid },
      { managerBundleId: "com.example.aliasmode" },
    ]) expect(createProfileLauncherManifest({ ...input, ...change }).launcherId).not.toBe(original);
    // Data-root relocation and application-version changes are deliberately not inputs.
    expect(() => createProfileLauncherManifest({ ...input, dataRoot: "/tmp/other" })).toThrow();
    expect(() => createProfileLauncherManifest({ ...input, appVersion: "9.9.9" })).toThrow();
  });

  test("rejects missing, unknown, inherited, hidden and accessor fields", () => {
    for (const key of Object.keys(input)) {
      const incomplete: Record<string, unknown> = { ...input };
      delete incomplete[key];
      expect(() => createProfileLauncherManifest(incomplete)).toThrow();
    }
    for (const extra of ["cookies", "token", "password", "url", "command", "__proto__"]) {
      expect(() => createProfileLauncherManifest({ ...input, [extra]: "must-not-be-copied" })).toThrow();
    }
    const inherited = Object.assign(Object.create(input), { displayName: input.displayName });
    expect(() => createProfileLauncherManifest(inherited)).toThrow();
    const hidden = Object.defineProperty({ ...input }, "token", { value: "hidden" });
    expect(() => createProfileLauncherManifest(hidden)).toThrow();
    const accessor = Object.defineProperty({ ...input }, "displayName", { get() { throw new Error("getter executed"); } });
    expect(() => createProfileLauncherManifest(accessor)).toThrow("invalid profile launcher data");
    for (const invalid of [null, [], "text", false, 1, new Date()]) {
      expect(() => createProfileLauncherManifest(invalid)).toThrow();
    }
  });

  test("enforces Profile ID, namespace, bundle ID and Unicode label grammars", () => {
    for (const profileId of ["", "../escape", "x/y", "x\\y", "a\0b", "a".repeat(129), "NUL", "--args", "https://example.test"]) {
      expect(() => createProfileLauncherManifest({ ...input, profileId })).toThrow();
    }
    for (const id of ["", "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF", "../escape", "3".repeat(100), "11111111-1111-1111-8111-111111111111"]) {
      expect(() => createProfileLauncherManifest({ ...input, dataNamespaceId: id })).toThrow();
      expect(() => createProfileLauncherManifest({ ...input, profileIncarnationId: id })).toThrow();
    }
    for (const managerBundleId of ["", "com", "com..app", "com.Bad.app", "com.app/escape", "com.app;sh", `com.${"a".repeat(125)}`]) {
      expect(() => createProfileLauncherManifest({ ...input, managerBundleId })).toThrow();
    }
    for (const displayName of ["", " \t ", "a".repeat(129), "😀".repeat(129), "a\0b", "a\nb", "a\rb", "\ud800", "\uffff", "name\u202eexe"]) {
      expect(() => createProfileLauncherManifest({ ...input, displayName })).toThrow();
    }
    expect(createProfileLauncherManifest({ ...input, displayName: "😀".repeat(128) }).displayName).toHaveLength(256);
  });

  test("rejects malformed, oversized, unknown-version and tampered manifest payloads", () => {
    for (const text of [undefined, "{", "null", "[]", "{}", " ".repeat(MAX_PROFILE_LAUNCHER_MANIFEST_BYTES + 1)]) {
      expect(() => parseProfileLauncherManifest(text)).toThrow();
    }
    for (const change of [
      { protocol: "aliasmode-profile-launcher-v2" }, { launcherId: "0".repeat(64) },
      { profileId: "other-profile" }, { cookie: "dummy-secret" },
    ]) expect(() => parseProfileLauncherManifest(JSON.stringify({ ...make(), ...change }))).toThrow();
    const missing = { ...make() } as Record<string, unknown>;
    delete missing.protocol;
    expect(() => parseProfileLauncherManifest(JSON.stringify(missing))).toThrow();
  });
});

describe("non-executing bundle plan", () => {
  test("XML-escapes labels; registers no URL, document or shell route", () => {
    const value = createProfileLauncherManifest({ ...input, displayName: `中文 😀 <&> "quoted" 'single'` });
    const plist = profileLauncherInfoPlist(value);
    expect(plist).toContain("中文 😀 &lt;&amp;&gt; &quot;quoted&quot; &apos;single&apos;");
    expect(plist).toContain(`<key>CFBundleExecutable</key><string>${PROFILE_LAUNCHER_EXECUTABLE}</string>`);
    expect(plist).toContain("<key>LSUIElement</key><false/>");
    for (const prohibited of ["CFBundleURLTypes", "CFBundleDocumentTypes", "NSServices", "/bin/sh", "cookies", "token"]) {
      expect(plist).not.toContain(prohibited);
    }
  });

  test("uses only a stable digest as filename, never a profile label or executable override", () => {
    const value = createProfileLauncherManifest({ ...input, displayName: "../../another.app; $(touch example)" });
    const plan = profileLauncherBundlePlan("/Users/Test User", value);
    expect(plan.bundlePath).toBe(`/Users/Test User/Applications/AliasMode Profiles/Profile-${value.launcherId}.app`);
    expect(plan.executableRelativePath).toBe("Contents/MacOS/aliasmode-profile-launcher");
    expect(plan.manifestRelativePath).toBe("Contents/Resources/profile-launcher.json");
    expect(parseProfileLauncherManifest(plan.manifestText)).toEqual(value);
    expect(() => profileLauncherBundlePlan("/Users/Test", { ...value, executable: "/bin/sh" })).toThrow();
  });

  test("rejects noncanonical or unsafe home paths without touching the filesystem", () => {
    for (const home of [null, "", "/", "relative", "~/user", "C:\\Users\\Test", "//Users/Test", "/Users/../Other", "/Users/./Test", "/Users/Test/", "/Users/a\0b", "/Users/a\nb", "/Users/a\\b", `/${"a".repeat(4097)}`]) {
      expect(() => profileLauncherBundlePlan(home, make())).toThrow();
    }
  });
});

describe("request and live binding checks, not IPC authentication", () => {
  test("accepts zero arguments and a bounded identifier-only request", () => {
    const value = make();
    const request = createProfileLauncherRequest(value);
    expect(parseProfileLauncherRequest(JSON.stringify(request))).toEqual(request);
    expect(Object.keys(request).sort()).toEqual(["launcherId", "protocol"]);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(MAX_PROFILE_LAUNCHER_REQUEST_BYTES);
    expect(validateProfileLauncherTarget(request, value, false, current))
      .toEqual({ operation: "open-or-focus", profileId: input.profileId });
  });

  test("rejects all launch arguments, including URL, cookie, token and arbitrary-command input", () => {
    for (const args of [
      ["https://example.test"], ["--profile", "another"], ["--url=https://example.test"],
      ["--cookie=dummy"], ["--token=dummy"], ["/bin/sh", "-c", "true"], [""],
    ]) expect(() => createProfileLauncherRequest(make(), args)).toThrow();
  });

  test("rejects missing, unknown, malformed and oversized request fields", () => {
    const request = createProfileLauncherRequest(make());
    for (const text of [null, "{", "null", "[]", "{}", " ".repeat(MAX_PROFILE_LAUNCHER_REQUEST_BYTES + 1), JSON.stringify({ protocol: request.protocol }), JSON.stringify({ launcherId: request.launcherId })]) {
      expect(() => parseProfileLauncherRequest(text)).toThrow();
    }
    for (const change of [
      { protocol: "future-version" }, { launcherId: "" }, { launcherId: "A".repeat(64) },
      { launcherId: "a".repeat(65) }, { launcherId: "../../escape" }, { launcherId: 1 },
      { profileId: "another" }, { url: "https://example.test" }, { token: "dummy-secret" },
      { cookies: [] }, { command: ["/bin/sh"] }, { operation: "delete" },
    ]) expect(() => parseProfileLauncherRequest(JSON.stringify({ ...request, ...change }))).toThrow();
  });

  test("fails closed for revoked, deleted, trashed, Cloud, Remote and mismatched bindings", () => {
    const value = make();
    const request = createProfileLauncherRequest(value);
    expect(() => validateProfileLauncherTarget(request, value, true, current)).toThrow();
    expect(() => validateProfileLauncherTarget(request, value, false, null)).toThrow();
    for (const change of [
      { state: "trashed" }, { state: "deleted" }, { mode: "cloud" }, { mode: "remote" },
      { profileId: "another" }, { profileId: input.profileId.toLowerCase() },
      { managerBundleId: "com.other.desktop" }, { dataNamespaceId: differentUuid },
      { profileIncarnationId: differentUuid },
    ]) expect(() => validateProfileLauncherTarget(request, value, false, { ...current, ...change })).toThrow();
    expect(() => validateProfileLauncherTarget({ ...request, launcherId: "a".repeat(64) }, value, false, current)).toThrow();
  });

  test("an old Dock icon cannot bind a deleted/recreated Profile with the same textual ID", () => {
    const oldManifest = make();
    const oldRequest = createProfileLauncherRequest(oldManifest);
    const recreated = { ...current, profileIncarnationId: differentUuid };
    expect(() => validateProfileLauncherTarget(oldRequest, oldManifest, false, recreated)).toThrow();
    const replacement = createProfileLauncherManifest({ ...input, profileIncarnationId: differentUuid });
    expect(() => validateProfileLauncherTarget(oldRequest, replacement, false, recreated)).toThrow();
    expect(validateProfileLauncherTarget(createProfileLauncherRequest(replacement), replacement, false, recreated))
      .toEqual({ operation: "open-or-focus", profileId: input.profileId });
  });

  test("rename does not break an existing request; errors do not echo rejected secrets", () => {
    const value = make();
    const renamed = createProfileLauncherManifest({ ...input, displayName: "Renamed" });
    expect(validateProfileLauncherTarget(createProfileLauncherRequest(value), renamed, false, current).profileId).toBe(input.profileId);
    try {
      parseProfileLauncherRequest(JSON.stringify({ ...createProfileLauncherRequest(value), token: "must-not-be-logged" }));
      throw new Error("request unexpectedly accepted");
    } catch (error) {
      expect(String(error)).toBe("Error: invalid profile launcher data");
    }
  });
});
