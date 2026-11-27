import { afterEach, expect, test } from "bun:test";
import {
  DockBadgeCoordinator, dockBadgeLabel, dockBadgesEnabled, isLocalDockEndpoint, sendDockBadge,
  type DockBadgeCommand, type DockBadgeResult, type DockBadgeTarget,
} from "./dock-badges.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function server(reply: (message: any) => unknown) {
  const messages: any[] = [];
  let closed = false;
  const instance = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("no", { status: 400 }); },
    websocket: {
      message(socket, data) {
        const message = JSON.parse(data.toString());
        messages.push(message);
        const response = reply(message);
        if (response !== undefined) socket.send(typeof response === "string" ? response : JSON.stringify(response));
      },
      close() { closed = true; },
    },
  });
  servers.push(instance);
  return {
    messages, isClosed: () => closed,
    command: {
      endpoint: `ws://127.0.0.1:${instance.port}/devtools/browser/test-uuid`, port: instance.port!,
      label: "007", signal: new AbortController().signal, stillCurrent: () => true,
    } satisfies DockBadgeCommand,
  };
}

test("Dock labels use bounded roster numbers only, preserving leading zeroes", () => {
  expect(dockBadgeLabel("007", 2)).toBe("007");
  expect(dockBadgeLabel("", 123)).toBe("123");
  expect(dockBadgeLabel(undefined, 1)).toBe("1");
  expect(dockBadgeLabel("0", 1)).toBe("0");
  for (const invalid of ["account@example.com", "12\n34", "secret", "9".repeat(13), "١٢", "12<script>"]) {
    expect(dockBadgeLabel(invalid, 4)).toBe("4");
  }
  for (const invalid of [null, 0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    expect(dockBadgeLabel("", invalid)).toBeNull();
  }
  expect(dockBadgesEnabled(undefined)).toBe(true);
  expect(dockBadgesEnabled("1")).toBe(true);
  expect(dockBadgesEnabled(" 0 ")).toBe(false);
});

test("Dock command rejects remote, page, mismatched, redirected and credential-bearing endpoints", async () => {
  expect(isLocalDockEndpoint("ws://127.0.0.1:9333/devtools/browser/abc-123", 9333)).toBe(true);
  const endpoints = [
    "wss://127.0.0.1:9333/devtools/browser/abc", "ws://localhost:9333/devtools/browser/abc",
    "ws://example.com:9333/devtools/browser/abc", "ws://127.0.0.1:9334/devtools/browser/abc",
    "ws://127.0.0.1:9333/devtools/page/abc", "ws://user:pass@127.0.0.1:9333/devtools/browser/abc",
    "ws://127.0.0.1:9333/devtools/browser/abc?token=secret", "ws://127.0.0.1:9333/devtools/browser/abc#secret",
    "ws://127.1:9333/devtools/browser/abc", "ws://127.0.0.1:9333/devtools/browser/abc\n",
    "ws://127.0.0.1:9333/devtools/browser/abc/../def", "ws://127.0.0.1:9333/devtools/browser/" + "x".repeat(512),
  ];
  for (const endpoint of endpoints) {
    expect(isLocalDockEndpoint(endpoint, 9333)).toBe(false);
    expect(await sendDockBadge({ endpoint, port: 9333, label: "1", signal: new AbortController().signal, stillCurrent: () => true })).toBe("skipped");
  }
  for (const port of [0, -1, 1.5, 65536, NaN]) expect(isLocalDockEndpoint("ws://127.0.0.1:9333/devtools/browser/abc", port)).toBe(false);
});

test("a real loopback CDP socket receives only Browser.setDockTile and then disconnects", async () => {
  const fixture = server(({ id }) => ({ id, result: {} }));
  expect(await sendDockBadge(fixture.command)).toBe("applied");
  expect(fixture.messages).toEqual([{ id: 1, method: "Browser.setDockTile", params: { badgeLabel: "007" } }]);
  await tick();
  expect(fixture.isClosed()).toBe(true);
});

test("unknown CDP method is unsupported; no private remote error text escapes", async () => {
  const fixture = server(({ id }) => ({ id, error: { code: -32601, message: "secret account or endpoint" } }));
  expect(await sendDockBadge(fixture.command)).toBe("unsupported");
  expect(fixture.messages).toHaveLength(1);
});

test("CDP errors, malformed replies, overlarge payloads and silence are nonfatal", async () => {
  for (const response of [
    { id: 1, error: { code: -32000, message: "private error" } }, "{bad json", "x".repeat(5000),
    { id: 1 }, { id: 2, result: {} }, undefined,
  ]) {
    const fixture = server(() => response);
    expect(await sendDockBadge(fixture.command, 30)).toBe("unavailable");
  }
});

test("obsolete and aborted work cannot send a badge to the browser", async () => {
  const fixture = server(({ id }) => ({ id, result: {} }));
  const abort = new AbortController();
  abort.abort();
  expect(await sendDockBadge({ ...fixture.command, signal: abort.signal })).toBe("skipped");
  let checks = 0;
  expect(await sendDockBadge({ ...fixture.command, stillCurrent: () => ++checks === 1 })).toBe("skipped");
  expect(await sendDockBadge({ ...fixture.command, stillCurrent: () => { throw new Error("stale"); } })).toBe("skipped");
  expect(fixture.messages).toHaveLength(0);
});

test("abort closes an outstanding CDP command without waiting for its timeout", async () => {
  const fixture = server(() => undefined);
  const abort = new AbortController();
  const result = sendDockBadge({ ...fixture.command, signal: abort.signal });
  while (!fixture.messages.length) await tick();
  abort.abort();
  expect(await result).toBe("skipped");
  await tick();
  expect(fixture.isClosed()).toBe(true);
});

test("WebSocket redirect is not followed even to a second local endpoint", async () => {
  const fixture = server(({ id }) => ({ id, result: {} }));
  const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(null, { status: 302, headers: { location: fixture.command.endpoint } });
  } });
  servers.push(redirect);
  expect(await sendDockBadge({ ...fixture.command, endpoint: `ws://127.0.0.1:${redirect.port}/devtools/browser/test`, port: redirect.port! })).toBe("unavailable");
  expect(fixture.messages).toHaveLength(0);
});

const target: DockBadgeTarget = { endpoint: "ws://127.0.0.1:9333/devtools/browser/a", port: 9333, generation: "9333:100", label: "1" };

test("certified observations coalesce per profile; renumber, reconnect, restart and forget refresh independently", async () => {
  const sent: DockBadgeCommand[] = [];
  const badges = new DockBadgeCoordinator(async (command) => { sent.push(command); return "applied"; });
  badges.update("one", target, () => true);
  badges.update("one", target, () => true);
  badges.update("two", { ...target, endpoint: "ws://127.0.0.1:9334/devtools/browser/b", port: 9334, label: "2" }, () => true);
  await tick();
  expect(sent.map(({ label }) => label)).toEqual(["1", "2"]);
  badges.update("one", target, () => true);
  await tick();
  expect(sent).toHaveLength(2);
  badges.update("one", { ...target, label: "007" }, () => true);
  await tick();
  badges.update("one", { ...target, endpoint: "ws://127.0.0.1:9333/devtools/browser/new" }, () => true);
  await tick();
  badges.update("one", { ...target, generation: "9333:200" }, () => true);
  await tick();
  expect(sent).toHaveLength(5);
  badges.forget("one");
  badges.update("one", target, () => true);
  await tick();
  expect(sent).toHaveLength(6);
});

test("unsupported is cached for the process, not globally or by label", async () => {
  const sent: DockBadgeCommand[] = [];
  const logs: string[] = [];
  const badges = new DockBadgeCoordinator(async (command) => { sent.push(command); return "unsupported"; }, (line) => logs.push(line));
  badges.update("private profile name", target, () => true);
  await tick();
  badges.update("private profile name", { ...target, label: "2" }, () => true);
  await tick();
  expect(sent).toHaveLength(1);
  expect(logs).toEqual(["Dock badge unsupported; browser keeps running"]);
  badges.update("private profile name", { ...target, generation: "9333:200" }, () => true);
  await tick();
  expect(sent).toHaveLength(2);
});

test("transient failures retry only on later observations with backoff and a hard limit", async () => {
  let time = 0;
  let calls = 0;
  const logs: string[] = [];
  const badges = new DockBadgeCoordinator(async () => { calls++; throw new Error("secret"); }, (line) => logs.push(line), () => time);
  for (let attempt = 0; attempt < 5; attempt++) {
    badges.update("one", target, () => true);
    await tick();
    badges.update("one", target, () => true);
    await tick();
    time += 30_000;
  }
  expect(calls).toBe(3);
  expect(logs).toEqual(["Dock badge unavailable; browser keeps running"]);
});

test("replacement aborts old work and stale completion cannot overwrite the new attempt", async () => {
  const pending: Array<{ command: DockBadgeCommand; resolve: (result: DockBadgeResult) => void }> = [];
  const badges = new DockBadgeCoordinator((command) => new Promise((resolve) => pending.push({ command, resolve })));
  badges.update("one", target, () => true);
  await tick();
  badges.update("one", { ...target, label: "2" }, () => true);
  await tick();
  expect(pending[0]!.command.signal.aborted).toBe(true);
  expect(pending[0]!.command.stillCurrent()).toBe(false);
  pending[1]!.resolve("applied");
  pending[0]!.resolve("unsupported");
  await tick();
  badges.update("one", { ...target, label: "2" }, () => true);
  await tick();
  expect(pending).toHaveLength(2);
  badges.forget("one");
  expect(pending[1]!.command.signal.aborted).toBe(true);
});

test("a launch lost before queued work starts causes no command", async () => {
  let calls = 0;
  const badges = new DockBadgeCoordinator(async () => { calls++; return "applied"; });
  badges.update("one", target, () => false);
  badges.update("two", target, () => true);
  badges.forget("two");
  await tick();
  expect(calls).toBe(0);
});
