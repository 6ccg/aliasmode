import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { profileRoutingInfo } from "./profile-routing-info.ts";
import { useTranslation } from "./i18n.tsx";
import { openProfile, type UiProfile } from "./api.ts";

type PendingBrowserUrl = { id: string; url: string };
export type Browser = { name: string; path: string; icon?: string | null };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const key = "aliasmode-added-browsers";
const orderKey = "aliasmode-browser-order";
export function readBrowserOrder(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(orderKey) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
  } catch { return []; }
}
export function orderedBrowsers(installed: Browser[], added: Browser[], order: string[]): Browser[] {
  const unique = [...new Map([...installed, ...added.filter(item => !installed.some(found => found.path === item.path))].map(item => [item.path, item])).values()];
  const rank = new Map(order.map((path, index) => [path, index]));
  return unique.sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity));
}
export function moveBrowser(items: Browser[], path: string, delta: number): string[] {
  const paths = items.map(item => item.path);
  const from = paths.indexOf(path), to = from + delta;
  if (from >= 0 && to >= 0 && to < paths.length) [paths[from], paths[to]] = [paths[to]!, paths[from]!];
  return paths;
}
export function linkSummary(value: string): string {
  try { const url = new URL(value); return url.host + (url.pathname === "/" ? "" : url.pathname); }
  catch { return value; }
}

export function isRoutableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16384) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
}

/** Restore only after the dashboard's visibility change has reached the browser. */
export function scheduleDashboardFocus(previous: HTMLElement | null, chooserActive: () => boolean): () => void {
  let cancelled = false;
  const deadline = performance.now() + 1000;
  let frame: number;
  const restore = (now: number) => {
    if (cancelled || chooserActive() || !previous?.isConnected || now >= deadline) return;
    // A user-selected dashboard control takes priority over delayed restoration.
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== previous) return;
    // Removing the class need not make the target focusable in the first frame.
    // Recheck the actual visibility, bounded and cancellable if another chooser opens.
    if (getComputedStyle(previous).visibility !== "visible" || !previous.getClientRects().length) {
      frame = requestAnimationFrame(restore);
      return;
    }
    previous.focus();
  };
  frame = requestAnimationFrame(restore);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}

export function UrlRouter({ profiles, local }: { profiles: UiProfile[]; local: boolean }) {
  const { t } = useTranslation();
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke as Invoke | undefined;
  const supported = !!invoke && /Mac/.test(navigator.platform);
  const [urls, setUrls] = useState<PendingBrowserUrl[]>([]);
  const queue = useRef<PendingBrowserUrl[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const finishing = useRef(false);
  const nativeClose = useRef<(id: string) => void>(() => {});
  const [closeReady, setCloseReady] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [added, setAdded] = useState<Browser[]>([]);
  const [order, setOrder] = useState<string[]>(readBrowserOrder);
  const [filter, setFilter] = useState("");
  const [showFullUrl, setShowFullUrl] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const cancelFocusRestore = useRef<(() => void) | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operationBusy = useRef(false);
  const queueVersion = useRef(0);
  const updateQueue = (pending: PendingBrowserUrl[]) => {
    const next = pending.filter(item => typeof item.id === "string" && isRoutableUrl(item.url));
    queue.current = next;
    setUrls(next);
    if (next.length) setRestoring(false);
  };
  useEffect(() => {
    if (!supported || !invoke) return;
    let active = true;
    let polling = false;
    let unlisten: UnlistenFn | undefined;
    let listenerRetry: ReturnType<typeof setTimeout> | undefined;
    // Do not present the compact window until Close can reach the frontend.
    // Registration failures are visible and retry without consuming any link.
    const registerClose = () => {
      void listen<string>("browser-chooser-close-requested", event => {
        if (active) nativeClose.current(event.payload);
      }, { target: "main" }).then(dispose => {
        if (active) { unlisten = dispose; setCloseReady(true); setCloseError(""); }
        else dispose();
      }).catch(error => {
        if (active) { setCloseError(String(error)); listenerRetry = setTimeout(registerClose, 1000); }
      });
    };
    registerClose();
    const poll = async () => {
      if (polling || operationBusy.current || finishing.current) return;
      polling = true;
      const version = queueVersion.current;
      try {
        const pending = await invoke<PendingBrowserUrl[]>("pending_browser_urls");
        if (active && version === queueVersion.current && !operationBusy.current && !finishing.current) updateQueue(pending);
      } catch { /* The sidecar may still be starting. Retain the native queue. */ }
      finally { polling = false; }
    };
    void invoke<Browser[]>("installed_browsers").then(value => { if (active) setBrowsers(value); }).catch(() => {});
    try { const value = JSON.parse(localStorage.getItem(key) ?? "[]"); if (Array.isArray(value)) setAdded(value.filter(item => typeof item?.path === "string" && typeof item?.name === "string")); } catch {}
    const refreshAdded = () => {
      setAdded(readAddedBrowsers());
      void invoke<string[]>("browser_order").then(value => { if (active) setOrder(value); }).catch(() => {});
    };
    refreshAdded();
    window.addEventListener("aliasmode-browsers-changed", refreshAdded);
    window.addEventListener("storage", refreshAdded);
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; unlisten?.(); clearTimeout(listenerRetry); clearInterval(timer); window.removeEventListener("aliasmode-browsers-changed", refreshAdded); window.removeEventListener("storage", refreshAdded); };
  }, [supported, invoke]);
  const pending = urls[0];
  const url = pending?.url;
  const chooserVisible = !!pending || restoring;
  useEffect(() => {
    if (!chooserVisible) return;
    cancelFocusRestore.current?.();
    // Hiding the root can blur its focused control. Capture it before changing visibility.
    const previous = document.activeElement as HTMLElement | null;
    document.body.classList.add("browser-chooser-active");
    return () => {
      document.body.classList.remove("browser-chooser-active");
      cancelFocusRestore.current = scheduleDashboardFocus(previous, () =>
        queue.current.length > 0 || document.body.classList.contains("browser-chooser-active"));
    };
  }, [chooserVisible]);
  useEffect(() => {
    if (!pending || !invoke || !closeReady) return;
    setFilter("");
    setShowFullUrl(false);
    dialog.current?.focus();
    let active = true;
    const frame = requestAnimationFrame(() => {
      void invoke("present_browser_chooser").catch(error => {
        if (active && queue.current[0]?.id === pending.id) setError(String(error));
      });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [pending?.id, invoke, closeReady]);
  useEffect(() => {
    if (!supported || !invoke || pending || busy) return;
    // React has removed the entire chooser before native restoration is allowed.
    // Also recovers a reload that occurred between dismissal and this acknowledgement.
    let active = true;
    finishing.current = true;
    queueVersion.current++;
    void invoke<PendingBrowserUrl[]>("finish_browser_chooser").then(next => {
      if (!active) return;
      updateQueue(next);
      setRestoring(false);
      setError("");
    }).catch(error => {
      if (active) { setRestoring(true); setError(String(error)); }
    }).finally(() => {
      if (active) { finishing.current = false; queueVersion.current++; }
    });
    return () => { active = false; finishing.current = false; queueVersion.current++; };
  }, [supported, invoke, pending?.id, busy, restoreAttempt]);
  const dismiss = async (item: PendingBrowserUrl) => {
    if (!invoke) return;
    const next = await invoke<PendingBrowserUrl[]>("dismiss_browser_url", { id: item.id });
    queueVersion.current++;
    updateQueue(next);
    if (!next.length) setRestoring(true);
    setError("");
  };
  const run = async (action: () => Promise<unknown>) => {
    if (operationBusy.current || finishing.current || !pending || queue.current[0]?.id !== pending.id) return;
    operationBusy.current = true;
    queueVersion.current++;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { queueVersion.current++; operationBusy.current = false; setBusy(false); }
  };
  const dismissCurrent = () => {
    if (pending && queue.current[0]?.id === pending.id) void run(() => dismiss(pending));
  };
  nativeClose.current = id => {
    const current = queue.current[0];
    if (pending?.id === id && current?.id === id) void run(() => dismiss(current));
  };
  if (!supported || !invoke) return null;
  const selectProfile = (id: string) => run(async () => {
    const opened = await openProfile(id);
    if (opened?.ok === false) throw new Error(opened.error || "Profile could not be opened");
    const response = await fetch(`/ui/api/profiles/${encodeURIComponent(id)}/open-url`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Link could not be opened");
    if (pending) await dismiss(pending);
  });
  if (!pending || !url) return restoring && error ? <div className="browser-chooser-backdrop">
    <section className="browser-chooser browser-chooser-restoring" role="dialog" aria-modal="true" aria-label={t("Open link with…")}>
      <p role="alert">{error}</p>
      <button type="button" autoFocus onKeyDown={event => {
        if (event.key === "Tab") event.preventDefault();
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
      }} onClick={() => { setError(""); setRestoreAttempt(value => value + 1); }}>{t("Retry")}</button>
    </section>
  </div> : null;
  const choices = orderedBrowsers(browsers, added, order);
  const visibleProfiles = profiles.filter(profile => (profile.name || profile.id).toLowerCase().includes(filter.toLowerCase()));
  return <div className="browser-chooser-backdrop">
    <section ref={dialog} className="browser-chooser" role="dialog" aria-modal="true" aria-labelledby="browser-chooser-title" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!event.repeat) dismissCurrent(); }
        if (event.key === "Tab") {
          const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')];
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header className="browser-chooser-header">
        <div><span className="browser-chooser-brand">ALIASMODE</span><h2 id="browser-chooser-title">{t("Open link with…")}</h2></div>
      </header>
      <div className="browser-chooser-link">
        <div className="browser-chooser-summary"><span aria-hidden="true">↗</span><span title={linkSummary(url)}>{linkSummary(url)}</span>
          <button type="button" className="browser-chooser-detail" aria-label={t(showFullUrl ? "Hide full link" : "Show full link")} aria-expanded={showFullUrl} aria-controls="browser-chooser-full-url" onClick={() => setShowFullUrl(value => !value)}>•••</button>
        </div>
        {showFullUrl && <p id="browser-chooser-full-url" tabIndex={0}>{url}</p>}
      </div>
      <div className="browser-chooser-content">
        <h3>{t("Browsers")}</h3>
        <div className="browser-chooser-grid">
          {choices.map(browser => <button type="button" className="browser-choice" key={browser.path} title={browser.path} disabled={busy}
            onClick={() => void run(async () => { await invoke("open_browser_url", { path: browser.path, url }); await dismiss(pending); })}>
            <span className="browser-choice-icon" aria-hidden="true">{browser.icon?.startsWith("data:image/png;base64,") ? <img src={browser.icon} alt="" /> : browser.name.slice(0, 1)}</span><span>{browser.name}</span><span className="browser-choice-arrow" aria-hidden="true">↗</span>
          </button>)}
        </div>
        {!choices.length && <p className="browser-chooser-note">{t("No browsers found. Add a browser in Settings → Browser routing.")}</p>}
        {local ? <><h3>{t("Local profiles")} <span>{profiles.length}</span></h3>
          {profiles.length > 5 && <input className="browser-chooser-search" aria-label={t("Find a profile")} placeholder={t("Find a profile…")} value={filter} onChange={event => setFilter(event.target.value)} />}
          <div className="browser-chooser-profiles">
            {visibleProfiles.map(profile => {
              const info = profileRoutingInfo(profile);
              const countryLabel = info.country ? t("Last checked proxy country: {country}", {country: info.country.code}) : "";
              return <button type="button" className="browser-choice profile-choice" key={profile.id} disabled={busy} onClick={() => void selectProfile(profile.id)}>
                <span className="browser-choice-icon" aria-hidden="true">◎</span><span title={profile.name || profile.id}>{profile.name || profile.id}</span>
                <span className="profile-routing-info">
                  <span className="profile-routing-chip" title={t("Browser engine")}>{info.engine.label}</span>
                  {info.fingerprint && <span className="profile-routing-chip" title={t("Fingerprint system")}>{info.fingerprint.label}</span>}
                  {info.country && <span className="profile-routing-flag" role="img" aria-label={countryLabel} title={countryLabel}>{info.country.flag}</span>}
                </span>
              </button>;
            })}
          </div>
          {!profiles.length && <p className="browser-chooser-note">{t("Create a local profile to add it here.")}</p>}
          {!!profiles.length && !visibleProfiles.length && <p className="browser-chooser-note">{t("No matching profiles.")}</p>}
        </> : <p className="browser-chooser-note">{t("Switch to Local in the main window to use local profiles.")}</p>}
      </div>
      {(error || closeError) && <p className="browser-chooser-error" role="alert">{error || closeError}</p>}
      <footer className="browser-chooser-footer">
        <span role="status">{busy ? t("Opening…") : urls.length > 1 ? t("{count} links waiting", {count: urls.length}) : t("Choose once for this link")}</span>
        <button type="button" disabled={busy} onClick={dismissCurrent}>{t("Dismiss")} <kbd>Esc</kbd></button>
      </footer>
    </section>
  </div>;
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
  const { t } = useTranslation();
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke as Invoke | undefined;
  const supported = !!invoke && /Mac/.test(navigator.platform);
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [added, setAdded] = useState<Browser[]>(readAddedBrowsers);
  const [order, setOrder] = useState<string[]>(readBrowserOrder);
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
    void invoke<string[]>("browser_order").then(value => { if (active) setOrder(value); }).catch(() => { if (active) setError("Could not load saved browser order."); });
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
  const choices = orderedBrowsers(browsers, added, order);
  const reorder = (path: string, delta: number) => run(async () => {
    const next = moveBrowser(choices, path, delta);
    await invoke("save_browser_order", {order: next});
    try { localStorage.setItem(orderKey, JSON.stringify(next)); } catch { /* native storage is authoritative */ }
    setOrder(next);
    window.dispatchEvent(new Event("aliasmode-browsers-changed"));
  });
  return <section className="settings-card" aria-label={t("Browser routing")}>
    <header><h2>{t("Browser routing")}</h2></header>
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
      <h3>{t("Installed browsers")}</h3>
      <p className="muted">{t("Move browsers up or down to set their order in the link chooser. Your order is saved on this Mac.")}</p>
      {choices.map((browser, index) => <div className="settings-row browser-order-row" key={browser.path}>
        <span><strong>{browser.name}</strong><br /><small className="muted">{browser.path}</small></span>
        <div className="browser-order-actions">
          <button type="button" className="btn ghost" aria-label={t("Move {name} up", {name: browser.name})} title={t("Move up")} disabled={busy || index === 0} onClick={() => void reorder(browser.path, -1)}>↑</button>
          <button type="button" className="btn ghost" aria-label={t("Move {name} down", {name: browser.name})} title={t("Move down")} disabled={busy || index === choices.length - 1} onClick={() => void reorder(browser.path, 1)}>↓</button>
        {added.some(item => item.path === browser.path) && <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(async () => saveAdded(added.filter(item => item.path !== browser.path)))}>Remove</button>}</div>
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
