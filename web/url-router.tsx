import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "./i18n.tsx";

export type Browser = { name: string; path: string; icon?: string | null };
export type RoutingPreferences = { order: string[]; added: string[]; profiles: string[] };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const emptyPreferences: RoutingPreferences = { order: [], added: [], profiles: [] };

export function orderedItems<T>(items: T[], order: string[], key: (item: T) => string): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(key(a)) ?? Infinity) - (rank.get(key(b)) ?? Infinity));
}
export function orderedBrowsers(installed: Browser[], added: Browser[], order: string[]): Browser[] {
  const unique = [...installed, ...added.filter(item => !installed.some(found => found.path === item.path))];
  return orderedItems(unique, order, item => item.path);
}
export function moveTo(items: string[], from: string, target: string): string[] {
  const next = [...items], before = next.indexOf(from), after = next.indexOf(target);
  if (before >= 0 && after >= 0 && before !== after) next.splice(after, 0, next.splice(before, 1)[0]!);
  return next;
}
export function linkSummary(value: string): string {
  try { const url = new URL(value); return url.host + (url.pathname === "/" ? "" : url.pathname); }
  catch { return value; }
}
export function isRoutableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16384) return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
}

export function AppIcon({ icon, fallback }: { icon?: string | null; fallback: string }) {
  return <span className="browser-choice-icon" aria-hidden="true">{icon?.startsWith("data:image/png;base64,")
    ? <img src={icon} alt="" draggable={false} /> : <span className="app-icon-fallback">{fallback}</span>}</span>;
}

/** Native HTML dragging, with arrow keys on the same handle as a keyboard alternative. */
export function useReorder(ids: string[], save: (ids: string[]) => void, disabled = false) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const reset = () => { setDragged(null); setTarget(null); };
  const row = (id: string) => ({
    "data-dragging": dragged === id || undefined,
    "data-drop-target": target === id && dragged !== id || undefined,
    onDragOver: (event: DragEvent) => {
      if (disabled || !dragged) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setTarget(id);
    },
    onDrop: (event: DragEvent) => {
      if (disabled || !dragged) return;
      event.preventDefault(); event.stopPropagation(); if (dragged !== id) save(moveTo(ids, dragged, id)); reset();
    },
  });
  const handle = (id: string, name: string) => <button type="button" className="browser-drag-handle"
    draggable={!disabled} disabled={disabled} aria-label={`Reorder ${name}`} title="Drag to reorder; arrow keys also work"
    onClick={event => event.stopPropagation()}
    onDragStart={event => { event.dataTransfer.setData("text/plain", id); event.dataTransfer.effectAllowed = "move"; setDragged(id); }}
    onDragEnd={reset}
    onKeyDown={(event: KeyboardEvent) => {
      if (disabled || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = ids.indexOf(id), delta = ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1;
      if (ids[index + delta]) save(moveTo(ids, id, ids[index + delta]!));
    }}><span aria-hidden="true">⠿</span></button>;
  return { row, handle };
}

/** Both windows share native preferences and the shell's cached application icons. */
export function useBrowserChoices() {
  const invoke = typeof window === "undefined" ? undefined : (window as any).__TAURI_INTERNALS__?.invoke as Invoke | undefined;
  const supported = !!invoke && /Mac|Win/.test(navigator.platform);
  const [preferences, setPreferences] = useState<RoutingPreferences>(emptyPreferences);
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [added, setAdded] = useState<Browser[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const refresh = async (force = false) => {
    if (!invoke) return;
    try {
      const list = await invoke<Browser[]>("installed_browsers", { refresh: force });
      if (active.current) setBrowsers(list);
      // Choices are usable immediately; Shell icon extraction never delays them.
      void invoke<Array<{ path: string; icon: string | null }>>("browser_icons", { paths: list.map(item => item.path) }).then(icons => {
        if (active.current) setBrowsers(current => current.map(item => ({ ...item, icon: icons.find(icon => icon.path === item.path)?.icon ?? item.icon })));
      }).catch(() => {});
    }
    catch { if (active.current) setError("Could not read installed browsers."); }
    finally { if (active.current) setLoading(false); }
  };
  useEffect(() => {
    if (!supported || !invoke) return;
    active.current = true;
    const load = () => void invoke<RoutingPreferences>("browser_preferences").then(value => {
      if (active.current) { setPreferences(value); setReady(true); }
    }).catch(() => { if (active.current) setError("Could not load browser preferences."); });
    load(); void refresh();
    const subscription = listen("browser-preferences-changed", load).catch(() => undefined);
    return () => { active.current = false; void subscription.then(stop => stop?.()); };
  }, [supported, invoke]);
  useEffect(() => {
    if (!invoke || !ready) return;
    let current = true;
    void Promise.all(preferences.added.map(path => invoke<Browser>("validate_browser_application", { path }).catch(() => null)))
      .then(items => { if (current) setAdded(items.filter((item): item is Browser => item !== null)); });
    return () => { current = false; };
  }, [invoke, ready, preferences.added.join("\0")]);
  const save = async (patch: Partial<RoutingPreferences>) => {
    if (!invoke || !ready || saving) return;
    const previous = preferences;
    setPreferences({ ...preferences, ...patch }); setSaving(true); setError("");
    try { setPreferences(await invoke<RoutingPreferences>("save_routing_preferences", { patch })); }
    catch (error) { setPreferences(previous); setError(String(error)); }
    finally { setSaving(false); }
  };
  return { invoke, supported, preferences, choices: orderedBrowsers(browsers, added, preferences.order), ready, loading, saving, error, save, refresh };
}

type DefaultBrowserStatus = { isDefault: boolean; httpHandler: string | null; httpsHandler: string | null };
export function BrowserRoutingSettings() {
  const { t } = useTranslation();
  const { invoke, supported, preferences, choices, ready, saving, error, save, refresh } = useBrowserChoices();
  const windows = /Win/.test(navigator.platform);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<DefaultBrowserStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const sorting = useReorder(choices.map(item => item.path), order => void save({ order }), !ready || saving || busy);
  useEffect(() => {
    if (!supported || !invoke) return;
    let active = true;
    const readStatus = () => void invoke<DefaultBrowserStatus>("default_browser_status").then(value => { if (active) setStatus(value); }).catch(() => {});
    readStatus(); window.addEventListener("focus", readStatus);
    return () => { active = false; window.removeEventListener("focus", readStatus); };
  }, [supported, invoke]);
  if (!supported || !invoke) return null;
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setActionError("");
    try { await action(); } catch (error) { setActionError(String(error)); } finally { setBusy(false); }
  };
  return <section className="settings-card" aria-label={t("Browser routing")}>
    <header><h2>{t("Browser routing")}</h2></header>
    <div className="card-body">
      <h3>Default web browser</h3>
      <p role="status">{status?.isDefault ? "AliasMode is your default browser." : "Choose AliasMode as your default to select a browser or Profile for each link."}</p>
      <p className="muted">{windows ? "Windows will open Default apps for your confirmation." : "macOS will ask you to confirm the browser change."}</p>
      <button type="button" className="btn primary" disabled={busy || status?.isDefault} onClick={() => void run(async () => { setStatus(await invoke("request_default_browser")); })}>
        {busy ? "Working…" : "Set AliasMode as default browser"}
      </button>
      <h3>{t("Installed browsers")}</h3>
      <p className="muted">Drag the handle to arrange your browsers. The chooser uses the same order.</p>
      <div className="browser-settings-list">
        {choices.map(browser => <div className="browser-settings-row" key={browser.path} {...sorting.row(browser.path)}>
          {sorting.handle(browser.path, browser.name)}
          <AppIcon icon={browser.icon} fallback={browser.name.slice(0, 1)} />
          <span className="browser-settings-name"><strong>{browser.name}</strong><small title={browser.path}>{browser.path}</small></span>
          {preferences.added.includes(browser.path) && <button type="button" className="btn ghost" disabled={saving}
            onClick={() => void save({ added: preferences.added.filter(path => path !== browser.path) })}>Remove</button>}
        </div>)}
      </div>
      <button type="button" className="btn ghost" onClick={() => void refresh(true)}>Refresh browsers</button>
      <label className="fld"><span>Add another browser ({windows ? ".exe" : ".app"} path)</span><input value={path} disabled={busy} placeholder={windows ? "C:\\Program Files\\Mozilla Firefox\\firefox.exe" : "/Applications/Firefox.app"} onChange={event => setPath(event.target.value)} /></label>
      <button type="button" className="btn" disabled={busy || saving || !ready || !path.trim()} onClick={() => void run(async () => {
        const browser = await invoke<Browser>("validate_browser_application", { path: path.trim() });
        await save({ added: [...new Set([...preferences.added, browser.path])] }); setPath("");
      })}>Add browser</button>
      {(error || actionError) && <p role="alert">{error || actionError}</p>}
    </div>
  </section>;
}
