/**
 * Unwired design foundation, not an installed Dock feature. No file writes,
 * process execution, network access or URL handler. Not imported by production code.
 *
 * These public identifiers are NOT credentials. A future native adapter must
 * authenticate its IPC peer and read the live private registry before using
 * validateProfileLauncherTarget. See docs/macos-profile-launchers.md.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { assertSafeProfileId } from "./profile-id.ts";

export const PROFILE_LAUNCHER_MANIFEST_PROTOCOL = "aliasmode-profile-launcher-v1";
export const PROFILE_LAUNCHER_REQUEST_PROTOCOL = "aliasmode-profile-launch-v1";
export const PROFILE_LAUNCHER_EXECUTABLE = "aliasmode-profile-launcher";
export const MAX_PROFILE_LAUNCHER_MANIFEST_BYTES = 4096;
export const MAX_PROFILE_LAUNCHER_REQUEST_BYTES = 256;

export interface ProfileLauncherIdentity {
  managerBundleId: string;
  /** Stable per local data store, not derived from its path or current version. */
  dataNamespaceId: string;
  profileId: string;
  /** New UUID for a deleted/recreated profile, even when its textual ID is reused. */
  profileIncarnationId: string;
}

export interface ProfileLauncherManifest extends ProfileLauncherIdentity {
  protocol: typeof PROFILE_LAUNCHER_MANIFEST_PROTOCOL;
  launcherId: string;
  displayName: string;
}

export interface ProfileLauncherRequest {
  protocol: typeof PROFILE_LAUNCHER_REQUEST_PROTOCOL;
  launcherId: string;
}

const IDENTITY_KEYS = ["managerBundleId", "dataNamespaceId", "profileId", "profileIncarnationId"] as const;
const MANIFEST_KEYS = ["protocol", "launcherId", ...IDENTITY_KEYS, "displayName"] as const;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LAUNCHER_ID = /^[a-f0-9]{64}$/;
const BUNDLE_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

function invalid(): never {
  // Never echo a rejected input: it may contain an accidentally supplied secret.
  throw new Error("invalid profile launcher data");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) invalid();
  // Constructors also accept objects, so reject accessors and hidden properties.
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}

function parseRecord(text: unknown, limit: number, keys: readonly string[]): Record<string, unknown> {
  if (typeof text !== "string" || text.length > limit || Buffer.byteLength(text, "utf8") > limit) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  return exactRecord(value, keys);
}

function identity(value: Record<string, unknown>): ProfileLauncherIdentity {
  const { managerBundleId, dataNamespaceId, profileId, profileIncarnationId } = value;
  if (typeof managerBundleId !== "string" || managerBundleId.length > 128 || !BUNDLE_ID.test(managerBundleId)) invalid();
  if (typeof dataNamespaceId !== "string" || !UUID_V4.test(dataNamespaceId)) invalid();
  if (typeof profileIncarnationId !== "string" || !UUID_V4.test(profileIncarnationId)) invalid();
  assertSafeProfileId(profileId);
  return { managerBundleId, dataNamespaceId, profileId, profileIncarnationId };
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || Buffer.byteLength(value, "utf8") > 512) invalid();
  const characters = [...value];
  if (characters.length > 128 || characters.some((character) => {
    const cp = character.codePointAt(0)!;
    return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)
      || (cp >= 0xd800 && cp <= 0xdfff) || (cp & 0xffff) >= 0xfffe
      || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
  })) invalid();
  return value;
}

function stableId(value: ProfileLauncherIdentity): string {
  // JSON tuple framing avoids delimiter collisions. Keep Profile ID case.
  return createHash("sha256").update(JSON.stringify([
    PROFILE_LAUNCHER_MANIFEST_PROTOCOL,
    value.managerBundleId, value.dataNamespaceId, value.profileId, value.profileIncarnationId,
  ]), "utf8").digest("hex");
}

export function createProfileLauncherManifest(input: unknown): ProfileLauncherManifest {
  const record = exactRecord(input, [...IDENTITY_KEYS, "displayName"]);
  const target = identity(record);
  return {
    protocol: PROFILE_LAUNCHER_MANIFEST_PROTOCOL,
    launcherId: stableId(target),
    ...target,
    displayName: displayName(record.displayName),
  };
}

function manifest(value: unknown): ProfileLauncherManifest {
  const record = exactRecord(value, MANIFEST_KEYS);
  const target = identity(record);
  if (record.protocol !== PROFILE_LAUNCHER_MANIFEST_PROTOCOL || record.launcherId !== stableId(target)) invalid();
  return {
    protocol: PROFILE_LAUNCHER_MANIFEST_PROTOCOL,
    launcherId: stableId(target),
    ...target,
    displayName: displayName(record.displayName),
  };
}

export function parseProfileLauncherManifest(text: unknown): ProfileLauncherManifest {
  return manifest(parseRecord(text, MAX_PROFILE_LAUNCHER_MANIFEST_BYTES, MANIFEST_KEYS));
}

export function profileLauncherBundleId(input: unknown): string {
  const value = manifest(input);
  return `${value.managerBundleId}.profile.p${value.launcherId}`;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A plist preview only. It does not create, sign, register or launch an app. */
export function profileLauncherInfoPlist(input: unknown): string {
  const value = manifest(input);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIdentifier</key><string>${xml(profileLauncherBundleId(value))}</string>
  <key>CFBundleExecutable</key><string>${PROFILE_LAUNCHER_EXECUTABLE}</string>
  <key>CFBundleName</key><string>${xml(value.displayName)}</string>
  <key>CFBundleDisplayName</key><string>${xml(value.displayName)}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><false/>
</dict></plist>
`;
}

/** Lexical plan, NOT a filesystem authorization or symlink/ownership check. */
export function profileLauncherBundlePlan(homeDirectory: unknown, input: unknown) {
  const value = manifest(input);
  if (typeof homeDirectory !== "string" || homeDirectory.length > 4096 || homeDirectory.endsWith("/")
    || !posix.isAbsolute(homeDirectory) || posix.normalize(homeDirectory) !== homeDirectory
    || /[\\\x00-\x1f\x7f]/.test(homeDirectory)) invalid();
  return {
    bundlePath: posix.join(homeDirectory, "Applications", "AliasMode Profiles", `Profile-${value.launcherId}.app`),
    executableRelativePath: `Contents/MacOS/${PROFILE_LAUNCHER_EXECUTABLE}`,
    manifestRelativePath: "Contents/Resources/profile-launcher.json",
    manifestText: `${JSON.stringify(value, null, 2)}\n`,
    infoPlist: profileLauncherInfoPlist(value),
  };
}

/** The native helper reads its own bundle. Never accept URLs, paths or flags. */
export function createProfileLauncherRequest(input: unknown, args: readonly string[] = []): ProfileLauncherRequest {
  if (!Array.isArray(args) || args.length !== 0) invalid();
  const value = manifest(input);
  return { protocol: PROFILE_LAUNCHER_REQUEST_PROTOCOL, launcherId: value.launcherId };
}

function request(input: unknown): ProfileLauncherRequest {
  const value = exactRecord(input, ["protocol", "launcherId"]);
  if (value.protocol !== PROFILE_LAUNCHER_REQUEST_PROTOCOL || typeof value.launcherId !== "string" || !LAUNCHER_ID.test(value.launcherId)) invalid();
  return { protocol: PROFILE_LAUNCHER_REQUEST_PROTOCOL, launcherId: value.launcherId };
}

export function parseProfileLauncherRequest(text: unknown): ProfileLauncherRequest {
  return request(parseRecord(text, MAX_PROFILE_LAUNCHER_REQUEST_BYTES, ["protocol", "launcherId"]));
}

/**
 * Binding check ONLY, not authentication. registeredManifest/revoked must come
 * from the live private registry, current from the live database, both inside
 * the lifecycle lock. Public manifests, UUIDs and hashes grant no authority.
 * Returns one fixed operation with no URL, runtime path, secrets or CDP data.
 */
export function validateProfileLauncherTarget(
  input: unknown,
  registeredManifest: unknown,
  revoked: boolean,
  current: unknown,
): { operation: "open-or-focus"; profileId: string } {
  const launch = request(input);
  const registered = manifest(registeredManifest);
  if (revoked !== false || current === null) throw new Error("profile launcher target is unavailable");
  const record = exactRecord(current, [...IDENTITY_KEYS, "mode", "state"]);
  const live = identity(record);
  if (record.mode !== "local" || record.state !== "available" || launch.launcherId !== registered.launcherId
    || IDENTITY_KEYS.some((key) => live[key] !== registered[key])) {
    throw new Error("profile launcher target is unavailable");
  }
  return { operation: "open-or-focus", profileId: live.profileId };
}
