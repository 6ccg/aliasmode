/** Running Chromium Dock tiles only. No app bundles, page scripts or persistent CDP connection. */
import WebSocket from "ws";

export type DockBadgeResult = "applied" | "unsupported" | "unavailable" | "skipped";

/** Only numbers already shown in the roster are eligible; never use names or account details. */
export function dockBadgeLabel(customNo: string | undefined, serial: number | null): string | null {
  const custom = (customNo ?? "").trim();
  if (/^\d{1,12}$/.test(custom)) return custom;
  return serial !== null && Number.isSafeInteger(serial) && serial > 0 ? String(serial) : null;
}

export function dockBadgesEnabled(value: string | undefined): boolean {
  return value?.trim() !== "0";
}

/** Accept only the exact browser endpoint on the already-owned loopback debugging port. */
export function isLocalDockEndpoint(endpoint: string, port: number): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || endpoint.length > 512) return false;
  return new RegExp(`^ws://127\\.0\\.0\\.1:${port}/devtools/browser/[A-Za-z0-9_-]+$`).test(endpoint);
}

export interface DockBadgeCommand {
  endpoint: string;
  port: number;
  label: string;
  signal: AbortSignal;
  /** Recheck the certified launch and label immediately before sending, not just before connect. */
  stillCurrent: () => boolean;
}

export type DockBadgeSetter = (command: DockBadgeCommand) => Promise<DockBadgeResult>;

/** Bounded, browser-level command. Failure never throws or returns remote error/endpoint text. */
export const setDockBadge: DockBadgeSetter = (command) => sendDockBadge(command);

export function sendDockBadge(command: DockBadgeCommand, timeoutMs = 1500): Promise<DockBadgeResult> {
  const { endpoint, port, label, signal, stillCurrent } = command;
  if (!isLocalDockEndpoint(endpoint, port) || !/^\d{1,16}$/.test(label)) return Promise.resolve("skipped");
  return new Promise((resolve) => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const current = () => {
      try { return !signal.aborted && stillCurrent(); } catch { return false; }
    };
    const finish = (result: DockBadgeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // terminate only this CDP client. Never Browser.close, never a page attachment.
      if (socket) {
        socket.removeAllListeners();
        socket.on("error", () => {});
        try { socket.terminate(); } catch {}
      }
      resolve(result);
    };
    const abort = () => finish("skipped");
    if (!current()) return finish("skipped");
    signal.addEventListener("abort", abort, { once: true });
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1500, timeoutMs)) : 1500;
    timer = setTimeout(() => finish("unavailable"), timeout);
    timer.unref?.();
    try {
      socket = new WebSocket(endpoint, {
        followRedirects: false,
        handshakeTimeout: timeout,
        maxPayload: 4096,
        perMessageDeflate: false,
      });
      socket.on("open", () => {
        if (!current()) return finish("skipped");
        try { socket!.send(JSON.stringify({ id: 1, method: "Browser.setDockTile", params: { badgeLabel: label } })); }
        catch { finish("unavailable"); }
      });
      socket.on("message", (data) => {
        try {
          const reply = JSON.parse(data.toString());
          if (reply?.id !== 1) return;
          if (reply.error) return finish(reply.error.code === -32601 ? "unsupported" : "unavailable");
          if (reply.result && typeof reply.result === "object") finish("applied");
          else finish("unavailable");
        } catch { finish("unavailable"); }
      });
      socket.on("error", () => finish("unavailable"));
      socket.on("close", () => finish("unavailable"));
    } catch { finish("unavailable"); }
  });
}

export interface DockBadgeTarget {
  endpoint: string;
  port: number;
  /** Start time + owned debug port. Browser UUID is also part of the identity below. */
  generation: string;
  label: string;
}

interface Attempt {
  target: DockBadgeTarget;
  abort: AbortController;
  result?: DockBadgeResult;
  retries: number;
  retryAt: number;
}

/**
 * Coalesce frequent certified-active probes. Retry transient failures only on a later verified
 * observation, at most three attempts per label/generation. Unsupported runtimes get one attempt
 * per browser process/endpoint. Manager restart intentionally starts with an empty cache.
 */
export class DockBadgeCoordinator {
  private attempts = new Map<string, Attempt>();

  constructor(
    private setter: DockBadgeSetter = setDockBadge,
    private log: (message: string) => void = () => {},
    private now: () => number = Date.now,
  ) {}

  update(profileId: string, target: DockBadgeTarget, stillCurrent: () => boolean): void {
    if (!isLocalDockEndpoint(target.endpoint, target.port) || !/^\d{1,16}$/.test(target.label)) return;
    const previous = this.attempts.get(profileId);
    const sameProcess = previous?.target.generation === target.generation && previous.target.endpoint === target.endpoint;
    const sameLabel = sameProcess && previous!.target.label === target.label;
    if (sameProcess && previous!.result === "unsupported") return;
    if (sameLabel && (!previous!.result || previous!.result === "applied"
      || previous!.retries >= 3 || this.now() < previous!.retryAt)) return;
    previous?.abort.abort();
    const attempt: Attempt = {
      target: { ...target }, abort: new AbortController(),
      retries: sameLabel ? previous!.retries + 1 : 1, retryAt: 0,
    };
    this.attempts.set(profileId, attempt);
    const current = () => this.attempts.get(profileId) === attempt && stillCurrent();
    // Queue after launch commit. Even an injected synchronous failure cannot fail the launch.
    void Promise.resolve().then(() => {
      if (!current()) return "skipped" as const;
      return this.setter({ ...target, signal: attempt.abort.signal, stillCurrent: current });
    }).catch(() => "unavailable" as const).then((result) => {
      if (this.attempts.get(profileId) !== attempt) return;
      attempt.result = result;
      attempt.retryAt = this.now() + 30_000;
      if (result === "unsupported" || (result === "unavailable" && attempt.retries === 1)) {
        // No profile name, account information, browser UUID, port or raw protocol errors in logs.
        try { this.log(`Dock badge ${result}; browser keeps running`); } catch {}
      }
    });
  }

  forget(profileId: string): void {
    this.attempts.get(profileId)?.abort.abort();
    this.attempts.delete(profileId);
  }
}
