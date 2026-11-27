import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openProfile, type UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { profileRoutingInfo } from "./profile-routing-info.ts";
import { THEME_KEY, readThemeChoice } from "./theme.ts";
import { AppIcon, isRoutableUrl, linkSummary, orderedItems, useBrowserChoices, useReorder } from "./url-router.tsx";

type PendingBrowserUrl = { id: string; url: string };
export type LinkSnapshot = { revision: string; urls: PendingBrowserUrl[] };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type ChooserProfile = Pick<UiProfile, "id" | "name" | "engine" | "chromiumRuntime" | "fingerprintOs" | "proxyCountryCode" | "serial" | "customNo">;

/** Replies and event-triggered reads can arrive in either order. */
export function acceptSnapshot(current: LinkSnapshot, next: LinkSnapshot): LinkSnapshot {
  if (!/^\d+$/.test(next.revision) || BigInt(next.revision) < BigInt(current.revision)) return current;
  return { revision: next.revision, urls: next.urls.filter(item => /^\d+$/.test(item.id) && isRoutableUrl(item.url)) };
}

/** This entry fetches only local routing data; it never mounts the dashboard. */
export function BrowserChooserView() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ChooserProfile[]>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [local, setLocal] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch {}
      const theme = readThemeChoice(document.cookie, stored);
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply(); media.addEventListener("change", apply);
    window.addEventListener("focus", apply); window.addEventListener("storage", apply);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("focus", apply); window.removeEventListener("storage", apply); };
  }, []);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const response = await fetch("/ui/api/browser-chooser");
        if (!response.ok) throw Error("Could not read chooser data");
        const { local, profiles, iconPaths } = await response.json() as { local: boolean; profiles: ChooserProfile[]; iconPaths: Record<string, string> };
        if (active && generation === request) { setLocal(local); setProfiles(profiles); setError(""); }
        const invoke = (window as any).__TAURI_INTERNALS__?.invoke as Invoke | undefined;
        if (invoke && Object.keys(iconPaths).length) {
          void invoke<Array<{ path: string; icon: string | null }>>("browser_icons", { paths: Object.values(iconPaths) }).then(items => {
            if (active && generation === request) setIcons(Object.fromEntries(Object.entries(iconPaths).flatMap(([key, path]) => {
              const icon = items.find(item => item.path === path)?.icon; return icon ? [[key, icon]] : [];
            })));
          }).catch(() => {});
        }
      } catch { if (active && generation === request) setError(t("Could not load local profiles.")); }
      finally { if (active && generation === request) setLoaded(true); }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [t]);
  return <BrowserChooser profiles={profiles} local={local} dataError={error} loadingProfiles={!loaded} icons={icons} />;
}

export function BrowserChooser({ profiles, local, dataError = "", loadingProfiles = false, icons = {} }: { profiles: ChooserProfile[]; local: boolean; dataError?: string; loadingProfiles?: boolean; icons?: Record<string, string> }) {
  const { t } = useTranslation();
  const { invoke, supported, choices, preferences, ready, loading, saving, error: preferencesError, save } = useBrowserChoices();
  const [snapshot, setSnapshot] = useState<LinkSnapshot>({ revision: "0", urls: [] });
  const queue = useRef(snapshot);
  const nativeClose = useRef<(id: string) => void>(() => {});
  const [listenersReady, setListenersReady] = useState(false);
  const [filter, setFilter] = useState("");
  const [showFullUrl, setShowFullUrl] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operationBusy = useRef(false);
  const updateQueue = (next: LinkSnapshot) => {
    const accepted = acceptSnapshot(queue.current, next);
    queue.current = accepted;
    setSnapshot(accepted);
  };
  useEffect(() => {
    if (!supported || !invoke) return;
    let active = true;
    let subscriptions: UnlistenFn[] = [];
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void invoke<LinkSnapshot>("pending_browser_urls").then(value => {
        if (active) updateQueue(value);
      }).catch(error => { if (active) setError(String(error)); });
    };
    // Subscribe before the initial read, closing the mount/event race. A failed
    // subscription retries setup only; there is no periodic queue polling.
    const register = async () => {
      const installed: UnlistenFn[] = [];
      try {
        installed.push(await listen<string>("browser-chooser-close-requested", event => {
          if (active) nativeClose.current(event.payload);
        }, { target: "chooser" }));
        installed.push(await listen("browser-links-changed", () => { if (active) refresh(); }, { target: "chooser" }));
        if (!active) { installed.forEach(dispose => dispose()); return; }
        subscriptions = installed;
        setListenersReady(true); setError("");
        refresh();
      } catch (error) {
        installed.forEach(dispose => dispose());
        if (active) { setError(String(error)); retry = setTimeout(() => void register(), 1000); }
      }
    };
    void register();
    return () => {
      active = false; subscriptions.forEach(dispose => dispose()); clearTimeout(retry);
    };
  }, [supported, invoke]);
  const pending = snapshot.urls[0];
  const url = pending?.url;
  useEffect(() => {
    if (!pending || !invoke || !listenersReady) return;
    setFilter(""); setShowFullUrl(false); setError("");
    dialog.current?.focus();
    let active = true;
    // React has committed. Hidden webviews may suspend rAF, so use the native
    // presentation command directly; its background matches the rendered surface.
    void invoke("present_browser_chooser", { id: pending.id, dark: document.documentElement.dataset.theme === "dark" }).catch(error => {
      if (active && queue.current.urls[0]?.id === pending.id) setError(String(error));
    });
    return () => { active = false; };
  }, [pending?.id, invoke, listenersReady]);
  const dismiss = async (item: PendingBrowserUrl) => {
    if (!invoke) return;
    updateQueue(await invoke<LinkSnapshot>("dismiss_browser_url", { id: item.id }));
    setError("");
  };
  const run = async (action: () => Promise<unknown>) => {
    if (operationBusy.current || !pending || queue.current.urls[0]?.id !== pending.id) return;
    operationBusy.current = true; setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { operationBusy.current = false; setBusy(false); }
  };
  const dismissCurrent = () => { if (pending) void run(() => dismiss(pending)); };
  nativeClose.current = id => {
    const current = queue.current.urls[0];
    if (pending?.id === id && current?.id === id) void run(() => dismiss(current));
  };
  const orderedProfiles = orderedItems(profiles, preferences.profiles, profile => profile.id);
  const browserSort = useReorder(choices.map(item => item.path), order => void save({ order }), busy || saving || !ready);
  const profileSort = useReorder(orderedProfiles.map(item => item.id), profiles => void save({ profiles }), busy || saving || !ready);
  if (!supported || !invoke || !pending || !url) return null;
  const selectProfile = (id: string) => run(async () => {
    const opened = await openProfile(id);
    if (opened?.ok === false) throw new Error(opened.error || "Profile could not be opened");
    const response = await fetch(`/ui/api/profiles/${encodeURIComponent(id)}/open-url`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Link could not be opened");
    await dismiss(pending);
  });
  const visibleProfiles = orderedProfiles.filter(profile => (profile.name || profile.id).toLowerCase().includes(filter.toLowerCase()));
  return <div className="browser-chooser-backdrop">
    <section ref={dialog} className="browser-chooser" role="dialog" aria-modal="true" aria-labelledby="browser-chooser-title" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape" || (event.metaKey && event.key.toLowerCase() === "w")) {
          event.preventDefault(); event.stopPropagation(); if (!event.repeat) dismissCurrent();
        }
        if (event.key === "Tab") {
          const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')];
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <header className="browser-chooser-header">
        <div><h2 id="browser-chooser-title">{t("Open link with…")}</h2><p>Choose a browser or a local Profile</p></div>
      </header>
      <div className="browser-chooser-link">
        <div className="browser-chooser-summary"><span aria-hidden="true">↗</span><span title={linkSummary(url)}>{linkSummary(url)}</span>
          <button type="button" className="browser-chooser-detail" aria-label={t(showFullUrl ? "Hide full link" : "Show full link")} aria-expanded={showFullUrl} aria-controls="browser-chooser-full-url" onClick={() => setShowFullUrl(value => !value)}>•••</button>
        </div>
        {showFullUrl && <p id="browser-chooser-full-url" tabIndex={0}>{url}</p>}
      </div>
      <div className="browser-chooser-content">
        <h3>{t("Browsers")}<span className="chooser-sort-hint">Drag to arrange</span></h3>
        <div className="browser-chooser-grid">
          {choices.map(browser => <div className="browser-sort-item" key={browser.path} {...browserSort.row(browser.path)}>
            <button type="button" className="browser-choice" title={browser.path} disabled={busy}
            onClick={() => void run(async () => { await invoke("open_browser_url", { path: browser.path, url }); await dismiss(pending); })}>
            <AppIcon icon={browser.icon} fallback={browser.name.slice(0, 1)} /><span>{browser.name}</span>
          </button>{browserSort.handle(browser.path, browser.name)}</div>)}
        </div>
        {loading && <p className="browser-chooser-note" role="status">Loading browsers…</p>}
        {!loading && !choices.length && <p className="browser-chooser-note">{t("No browsers found. Add a browser in Settings → Browser routing.")}</p>}
        {loadingProfiles ? <p className="browser-chooser-note" role="status">Loading profiles…</p> : local ? <><h3>{t("Local profiles")} <span>{profiles.length}</span></h3>
          {profiles.length > 5 && <input className="browser-chooser-search" aria-label={t("Find a profile")} placeholder={t("Find a profile…")} value={filter} onChange={event => setFilter(event.target.value)} />}
          <div className="browser-chooser-profiles">
            {visibleProfiles.map(profile => {
              const info = profileRoutingInfo(profile);
              const countryLabel = info.country ? t("Last checked proxy country: {country}", {country: info.country.code}) : "";
              const number = profile.customNo || profile.serial || "";
              const icon = icons[profile.engine === "firefox" ? "firefox" : profile.chromiumRuntime || "cloakbrowser"];
              return <div className="browser-sort-item profile-sort-item" key={profile.id} {...profileSort.row(profile.id)}>
                <button type="button" className="browser-choice profile-choice" disabled={busy} onClick={() => void selectProfile(profile.id)}>
                <span className="profile-icon"><AppIcon icon={icon} fallback={String(number || profile.name.slice(0, 1))} />{icon && number && <span className="profile-icon-number">{number}</span>}</span><span title={profile.name || profile.id}>{profile.name || profile.id}</span>
                <span className="profile-routing-info">
                  <span className="profile-routing-chip" title={t("Browser engine")}>{info.engine.label}</span>
                  {info.fingerprint && <span className="profile-routing-chip" title={t("Fingerprint system")}>{info.fingerprint.label}</span>}
                  {info.country && <span className="profile-routing-flag" role="img" aria-label={countryLabel} title={countryLabel}>{info.country.flag}</span>}
                </span>
              </button>{profileSort.handle(profile.id, profile.name || profile.id)}</div>;
            })}
          </div>
          {!profiles.length && <p className="browser-chooser-note">{t("Create a local profile to add it here.")}</p>}
          {!!profiles.length && !visibleProfiles.length && <p className="browser-chooser-note">{t("No matching profiles.")}</p>}
        </> : <p className="browser-chooser-note">{t("Switch to Local in the main window to use local profiles.")}</p>}
      </div>
      {(error || dataError || preferencesError) && <p className="browser-chooser-error" role="alert">{error || dataError || preferencesError}</p>}
      <footer className="browser-chooser-footer">
        <span role="status">{busy ? t("Opening…") : snapshot.urls.length > 1 ? t("{count} links waiting", {count: snapshot.urls.length}) : t("Choose once for this link")}</span>
        <button type="button" disabled={busy} onClick={dismissCurrent}>{t("Dismiss")} <kbd>Esc</kbd></button>
      </footer>
    </section>
  </div>;
}
