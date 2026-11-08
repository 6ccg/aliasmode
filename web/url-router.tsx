import { useEffect, useRef, useState } from "react";
import { openProfile, type UiProfile } from "./api.ts";

type Browser = { name: string; path: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const key = "aliasmode-added-browsers";
export function isRoutableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16384) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
}

export function UrlRouter({ profiles, local }: { profiles: UiProfile[]; local: boolean }) {
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke as Invoke | undefined;
  const supported = !!invoke && /Mac/.test(navigator.platform);
  const [urls, setUrls] = useState<string[]>([]);
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [added, setAdded] = useState<Browser[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operationBusy = useRef(false);
  const queueVersion = useRef(0);
  useEffect(() => {
    if (!supported || !invoke) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const version = queueVersion.current;
      try { const pending = await invoke<string[]>("pending_browser_urls"); if (active && version === queueVersion.current) setUrls(pending.filter(isRoutableUrl)); }
      catch { /* The sidecar may still be starting. Retain the native queue. */ }
      finally { polling = false; }
    };
    void invoke<Browser[]>("installed_browsers").then(value => { if (active) setBrowsers(value); }).catch(() => {});
    try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); if (Array.isArray(value)) setAdded(value.filter(item => typeof item?.path === "string" && typeof item?.name === "string")); } catch {}
    const refreshAdded = () => setAdded(readAddedBrowsers());
    window.addEventListener("aliasmode-browsers-changed", refreshAdded);
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); window.removeEventListener("aliasmode-browsers-changed", refreshAdded); };
  }, [supported, invoke]);
  if (!supported || !invoke) return null;
  const url = urls[0];
  const dismiss = async () => {
    if (url) { await invoke("dismiss_browser_url", { url }); queueVersion.current++; setUrls(items => items[0] === url ? items.slice(1) : items); }
    setError("");
  };
  const run = async (action: () => Promise<unknown>) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { operationBusy.current = false; setBusy(false); }
  };
  const selectProfile = (id: string) => run(async () => {
    const opened = await openProfile(id);
    if (opened?.ok === false) throw new Error(opened.error || "Profile could not be opened");
    const response = await fetch(`/ui/api/profiles/${encodeURIComponent(id)}/open-url`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Link could not be opened");
    await dismiss();
  });
  return <>
    {url && <div className="modal-backdrop" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#0009", display: "grid", placeItems: "center" }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label="Choose browser" style={{ maxWidth: 680, width: "90vw", maxHeight: "85vh", overflow: "auto", padding: 24 }}>
        <h2>Open link with…</h2>
        {url && <p style={{ overflowWrap: "anywhere" }}>{url}</p>}
        {url && local && <><h3>Local profiles</h3>{profiles.length === 0 && <p>Create a local profile first, or choose an installed browser below.</p>}{profiles.map(profile => <button className="btn" key={profile.id} disabled={busy} onClick={() => void selectProfile(profile.id)}>{profile.name || profile.id}</button>)}</>}
        {url && !local && <p>Choose Continue with Local to route links to your local profiles.</p>}
        <h3>Installed browsers</h3>
        {[...browsers, ...added.filter(item => !browsers.some(found => found.path === item.path))].map(browser => <div key={browser.path} style={{ marginBottom: 8 }}>
          <button className="btn" disabled={busy || !url} onClick={() => void run(async () => { await invoke("open_browser_url", { path: browser.path, url }); await dismiss(); })}>{browser.name}</button>
        </div>)}
        <p className="muted">Manage browsers and the macOS default in Settings → Browser routing.</p>
        {error && <p role="alert">{error}</p>}
        <div className="modal-foot"><button className="btn ghost" disabled={busy} onClick={() => void run(dismiss)}>Dismiss link</button></div>
      </section>
    </div>}
  </>;
}

function readAddedBrowsers(): Browser[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter(item => typeof item?.path === "string" && typeof item?.name === "string") : [];
  } catch { return []; }
}

type DefaultBrowserStatus = { isDefault: boolean; httpHandler: string | null; httpsHandler: string | null };

/** Settings are separate from the URL inbox: closing settings never consumes a link. */
export function BrowserRoutingSettings() {
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke as Invoke | undefined;
  const supported = !!invoke && /Mac/.test(navigator.platform);
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [added, setAdded] = useState<Browser[]>(readAddedBrowsers);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<DefaultBrowserStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operationBusy = useRef(false);
  useEffect(() => {
    if (!supported || !invoke) return;
    let active = true;
    const refresh = () => {
      void invoke<DefaultBrowserStatus>("default_browser_status").then(value => { if (active) setStatus(value); })
        .catch(() => { if (active) setStatus(null); });
    };
    refresh();
    void invoke<Browser[]>("installed_browsers").then(value => { if (active) setBrowsers(value); })
      .catch(() => { if (active) setError("Could not list installed browsers. You can still add one below."); });
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [supported, invoke]);
  if (!supported || !invoke) return null;
  const run = async (action: () => Promise<void>) => {
    if (operationBusy.current) return;
    operationBusy.current = true;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { operationBusy.current = false; setBusy(false); }
  };
  const saveAdded = (next: Browser[]) => {
    localStorage.setItem(key, JSON.stringify(next));
    setAdded(next);
    window.dispatchEvent(new Event("aliasmode-browsers-changed"));
  };
  return <section className="settings-card" aria-label="Browser routing">
    <header><h2>Browser routing</h2></header>
    <div className="card-body">
      <h3>Default web browser</h3>
      <p role="status">{status === null ? "Default browser status unavailable" : status.isDefault ? "AliasMode is your default browser for HTTP and HTTPS links." : "AliasMode is not your default browser for all web links."}</p>
      {status && !status.isDefault && <p className="muted">HTTP: {status.httpHandler ?? "Not set"} · HTTPS: {status.httpsHandler ?? "Not set"}</p>}
      <p>Install AliasMode in Applications. Requesting the default opens the macOS confirmation flow; you decide whether to approve. Links from other apps will then let you choose a local profile or an installed browser.</p>
      <button type="button" className="btn primary" disabled={busy || status?.isDefault} onClick={() => void run(async () => {
        setStatus(await invoke<DefaultBrowserStatus>("request_default_browser"));
      })}>{busy ? "Working…" : "Set AliasMode as default browser"}</button>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(async () => {
        setStatus(await invoke<DefaultBrowserStatus>("default_browser_status"));
      })}>Refresh status</button>
      <h3>Installed browsers</h3>
      {[...browsers, ...added.filter(item => !browsers.some(found => found.path === item.path))].map(browser => <div className="settings-row" key={browser.path}>
        <span><strong>{browser.name}</strong><br /><small className="muted">{browser.path}</small></span>
        {added.some(item => item.path === browser.path) && <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(async () => saveAdded(added.filter(item => item.path !== browser.path)))}>Remove</button>}
      </div>)}
      {browsers.length === 0 && added.length === 0 && <p>No browsers found. Add an installed browser below.</p>}
      <label className="fld"><span>Add another browser (.app path)</span><input value={path} disabled={busy} placeholder="/Applications/Firefox.app" onChange={event => setPath(event.target.value)} /></label>
      <button type="button" className="btn" disabled={busy || !path.trim()} onClick={() => void run(async () => {
        const browser = await invoke<Browser>("validate_browser_application", { path: path.trim() });
        saveAdded([...added.filter(item => item.path !== browser.path), browser]); setPath("");
      })}>Add browser</button>
      {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
