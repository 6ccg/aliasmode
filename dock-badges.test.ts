import { afterEach, expect, test } from "bun:test";
import {
  DockBadgeCoordinator, dockBadgeLabel, dockBadgesEnabled, sendDockBadge,
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


const target: DockBadgeTarget = { endpoint: "ws://127.0.0.1:9333/devtools/browser/a", port: 9333, generation: "9333:100", label: "1" };

test("Dock labels use bounded roster numbers only, preserving leading zeroes", () => {
  expect(dockBadgeLabel("007", 2)).toBe("007");
  expect(dockBadgeLabel("", 123)).toBe("123");
  expect(dockBadgeLabel(undefined, 1)).toBe("1");
  expect(dockBadgeLabel("0", 1)).toBe("0");
  for (const invalid of ["account@example.com", "9".repeat(13)]) {
    expect(dockBadgeLabel(invalid, 4)).toBe("4");
  }
  for (const invalid of [null, 0, -1]) {
    expect(dockBadgeLabel("", invalid)).toBeNull();
  }
  expect(dockBadgesEnabled(undefined)).toBe(true);
  expect(dockBadgesEnabled("1")).toBe(true);
  expect(dockBadgesEnabled(" 0 ")).toBe(false);
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
