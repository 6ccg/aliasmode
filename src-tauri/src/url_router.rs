//! Local-only URL inbox. Never log links: they may contain authentication tokens.
use crate::credentials::{authorize, CredentialOrigin};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};
use tauri::{Emitter, Manager, State, WebviewWindow};
#[cfg(any(target_os = "macos", windows))]
use tauri::{LogicalSize, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
#[path = "url_router_windows.rs"]
mod windows;

#[path = "url_inbox.rs"]
mod inbox;
#[cfg(any(target_os = "macos", windows))]
use inbox::LaunchVisibility;
use inbox::UrlQueue;

#[derive(Default)]
pub struct UrlInbox(Mutex<UrlQueue>);

#[derive(Default)]
#[cfg(any(target_os = "macos", windows))]
pub struct DesktopLaunch(pub Mutex<LaunchVisibility>);

#[derive(Serialize)]
pub struct PendingBrowserUrls {
    revision: String,
    urls: Vec<PendingBrowserUrl>,
}

#[derive(Clone, Serialize)]
pub struct PendingBrowserUrl {
    // A string keeps IPC identities exact even beyond JavaScript's integer range.
    id: String,
    url: String,
}

fn pending_urls(inbox: &UrlQueue) -> PendingBrowserUrls {
    PendingBrowserUrls {
        revision: inbox.revision().to_string(),
        urls: inbox
            .pending()
            .iter()
            .map(|item| PendingBrowserUrl {
                id: item.id.to_string(),
                url: item.url.clone(),
            })
            .collect(),
    }
}

#[cfg(any(target_os = "macos", windows, test))]
fn chooser_size(available: Option<(f64, f64)>) -> (f64, f64) {
    let (width_limit, height_limit) = available.unwrap_or((480.0, 520.0));
    (
        480.0_f64.min(width_limit.max(1.0)),
        520.0_f64.min(height_limit.max(1.0)),
    )
}

#[cfg(any(target_os = "macos", windows))]
fn position_chooser(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|point| window.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let work = monitor.work_area();
        let scale = monitor.scale_factor();
        // Leave room for the native titlebar and a small work-area margin.
        let (width, height) = chooser_size(Some((
            f64::from(work.size.width) / scale - 24.0,
            f64::from(work.size.height) / scale - 64.0,
        )));
        // Move while hidden before measuring, so a change in monitor scale is
        // reflected in outer_size rather than centering with the old screen's DPI.
        window.set_position(work.position)?;
        window.set_size(LogicalSize::new(width, height))?;
        let outer = window.outer_size()?;
        window.set_position(PhysicalPosition::new(
            work.position.x
                + (i64::from(work.size.width).saturating_sub(i64::from(outer.width)) / 2).max(0)
                    as i32,
            work.position.y
                + (i64::from(work.size.height).saturating_sub(i64::from(outer.height)) / 2).max(0)
                    as i32,
        ))?;
    }
    Ok(())
}

/// Pre-created once, from its own HTML/React entry. No dashboard window operations.
#[cfg(any(target_os = "macos", windows))]
pub fn create_chooser(app: &tauri::App, origin: &str) -> tauri::Result<()> {
    let port = url::Url::parse(origin)
        .expect("validated sidecar origin")
        .port();
    let window = WebviewWindowBuilder::new(
        app,
        "chooser",
        WebviewUrl::External(
            format!("{origin}/chooser")
                .parse()
                .expect("validated sidecar origin"),
        ),
    )
    .title("AliasMode")
    .visible(false)
    .disable_drag_drop_handler()
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .focused(false)
    .inner_size(480.0, 520.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(true)
    .always_on_top(true)
    .background_color(tauri::window::Color(248, 247, 245, 255))
    .on_navigation(move |url| {
        url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == port
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()?;
    position_chooser(&window)?;
    // Tauri 2.11 exposes ns_window(), but not FullScreenAuxiliary. AppKit access
    // stays on the main thread and the borrowed NSWindow never escapes this call.
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let native = window.ns_window()?;
        let native = unsafe { &*native.cast::<NSWindow>() };
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary,
        );
        native.setHidesOnDeactivate(false);
    }
    let chooser = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let inbox = chooser.state::<UrlInbox>();
            if let Ok(pending) = inbox.0.lock() {
                if let Some(item) = pending.pending().first() {
                    // Identity only. Busy frontend operations retain ownership of the link.
                    let _ = chooser.emit_to(
                        "chooser",
                        "browser-chooser-close-requested",
                        item.id.to_string(),
                    );
                } else {
                    let _ = chooser.hide();
                }
            };
        }
    });
    Ok(())
}

/// Show only the head that React has committed. A stale reply cannot show
/// an empty window or raise it again after a successful browser launch.
#[tauri::command]
pub async fn present_browser_chooser(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    id: String,
    dark: bool,
) -> Result<(), String> {
    authorize(&window, &origin)?;
    if window.label() != "chooser" {
        return Err("Only the chooser can present links".into());
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        let inbox = window.state::<UrlInbox>();
        let pending = inbox.0.lock().map_err(|_| "URL inbox unavailable")?;
        if !pending
            .pending()
            .first()
            .is_some_and(|item| item.id.to_string() == id)
        {
            return Ok(());
        }
        if !window
            .is_visible()
            .map_err(|_| "Could not inspect chooser")?
        {
            position_chooser(&window).map_err(|_| "Could not position chooser")?;
        }
        let color = if dark {
            tauri::window::Color(21, 21, 26, 255)
        } else {
            tauri::window::Color(248, 247, 245, 255)
        };
        window
            .set_background_color(Some(color))
            .map_err(|_| "Could not prepare chooser")?;
        window.show().map_err(|_| "Could not show chooser")?;
        window
            .set_focus()
            .map_err(|_| "Could not focus chooser".to_owned())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (id, dark);
        Err("Browser routing is available on macOS and Windows".into())
    }
}

fn web_url(value: &str) -> bool {
    value.len() <= 16384
        && url::Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}

#[cfg(any(target_os = "macos", windows))]
pub fn receive(app: &tauri::AppHandle, urls: impl IntoIterator<Item = String>) -> bool {
    let inbox = app.state::<UrlInbox>();
    let mut received = false;
    if let Ok(mut pending) = inbox.0.lock() {
        for url in urls {
            if web_url(&url) {
                received |= pending.push(url);
            }
        }
    }
    if !received {
        return false;
    }
    if let Ok(mut launch) = app.state::<DesktopLaunch>().0.lock() {
        launch.link_received = true;
    }
    // No URL crosses the event bridge. Initial fetch covers events before mount.
    let _ = app.emit_to("chooser", "browser-links-changed", ());
    true
}

#[tauri::command]
pub fn pending_browser_urls(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    inbox: State<'_, UrlInbox>,
) -> Result<PendingBrowserUrls, String> {
    authorize(&window, &origin)?;
    let pending = inbox.0.lock().map_err(|_| "URL inbox unavailable")?;
    Ok(pending_urls(&pending))
}

#[tauri::command]
pub fn dismiss_browser_url(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    inbox: State<'_, UrlInbox>,
    id: String,
) -> Result<PendingBrowserUrls, String> {
    authorize(&window, &origin)?;
    let id = id.parse::<u64>().map_err(|_| "Invalid link request")?;
    let mut pending = inbox.0.lock().map_err(|_| "URL inbox unavailable")?;
    pending.dismiss(id);
    if pending.is_empty() {
        if let Some(chooser) = window.app_handle().get_webview_window("chooser") {
            chooser.hide().map_err(|_| "Could not hide chooser")?;
        }
    }
    let _ = window.emit_to("chooser", "browser-links-changed", ());
    Ok(pending_urls(&pending))
}

#[derive(Clone, Serialize)]
pub struct Browser {
    path: String,
    name: String,
    icon: Option<String>,
}

type CachedIcon = (Option<SystemTime>, Option<String>);
static ICONS: OnceLock<Mutex<HashMap<String, CachedIcon>>> = OnceLock::new();
static CATALOG: Mutex<Option<(Instant, Vec<Browser>)>> = Mutex::new(None);

fn cached_icon(path: &str, extract: impl FnOnce() -> Option<String>) -> Option<String> {
    let stamp = std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    let cache = ICONS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some((modified, icon)) = cache.get(path) {
            if *modified == stamp {
                return icon.clone();
            }
        }
    }
    let icon = extract();
    if let Ok(mut cache) = cache.lock() {
        cache.insert(path.into(), (stamp, icon.clone()));
    }
    icon
}

#[derive(Serialize)]
pub struct BrowserIcon {
    path: String,
    icon: Option<String>,
}

#[tauri::command]
pub async fn browser_icons(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    paths: Vec<String>,
) -> Result<Vec<BrowserIcon>, String> {
    authorize(&window, &origin)?;
    #[cfg(target_os = "macos")]
    return on_browser_main_thread(window.app_handle(), move || {
        Ok(paths
            .into_iter()
            .map(|path| {
                let icon = app_icon(&path);
                BrowserIcon { path, icon }
            })
            .collect())
    })
    .await;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let icon = cached_icon(&path, || windows::app_icon(&path));
                BrowserIcon { path, icon }
            })
            .collect()
    })
    .await
    .map_err(|_| "Could not read application icons".into());
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = paths;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn browser(path: &str) -> Result<Browser, String> {
    use objc2_foundation::{NSBundle, NSString};
    let path = std::fs::canonicalize(path).map_err(|_| "Application not found")?;
    if path.extension().and_then(|s| s.to_str()) != Some("app") || !path.is_dir() {
        return Err("Choose an installed .app application".into());
    }
    let id = NSBundle::bundleWithPath(&NSString::from_str(&path.to_string_lossy()))
        .and_then(|bundle| bundle.bundleIdentifier())
        .ok_or("Cannot inspect application")?
        .to_string();
    if id.is_empty()
        || id == "com.aliasmode.desktop"
        || std::env::current_exe().is_ok_and(|exe| exe.starts_with(&path))
    {
        return Err("Cannot route a link back to AliasMode".into());
    }
    Ok(Browser {
        icon: None,
        name: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

#[cfg(target_os = "macos")]
fn browser_with_icon(path: &str) -> Result<Browser, String> {
    let mut selected = browser(path)?;
    selected.icon = app_icon(&selected.path);
    Ok(selected)
}

#[cfg(target_os = "macos")]
fn app_icon(path: &str) -> Option<String> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace,
        NSGraphicsContext, NSWorkspace,
    };
    use objc2_foundation::{
        NSDataBase64EncodingOptions, NSDictionary, NSPoint, NSRect, NSSize, NSString,
    };
    let path = std::fs::canonicalize(path).ok()?;
    // Runtime executables live inside .app bundles; read the app's real icon.
    let path = path
        .ancestors()
        .find(|part| part.extension().is_some_and(|ext| ext == "app"))
        .unwrap_or(&path);
    let path = path.to_string_lossy();
    cached_icon(&path, || {
        let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(&path));
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(), std::ptr::null_mut(), 48, 48, 8, 4, true, false, NSDeviceRGBColorSpace, 0, 0,
        )
        }?;
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        image.drawInRect_fromRect_operation_fraction(
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(48.0, 48.0)),
            NSRect::ZERO,
            NSCompositingOperation::Copy,
            1.0,
        );
        NSGraphicsContext::restoreGraphicsState_class();
        let png = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }?;
        if png.length() > 256 * 1024 {
            return None;
        }
        Some(format!(
            "data:image/png;base64,{}",
            png.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty())
        ))
    })
}

#[cfg(target_os = "macos")]
async fn on_browser_main_thread<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(work());
    })
    .map_err(|_| "Could not inspect browser applications")?;
    receive
        .await
        .map_err(|_| "Could not inspect browser applications")?
}

#[tauri::command]
pub async fn installed_browsers(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    refresh: Option<bool>,
) -> Result<Vec<Browser>, String> {
    authorize(&window, &origin)?;
    if !refresh.unwrap_or(false) {
        if let Ok(cache) = CATALOG.lock() {
            if let Some((at, browsers)) = cache.as_ref() {
                if at.elapsed() < Duration::from_secs(60) {
                    return Ok(browsers.clone());
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    let result = {
        on_browser_main_thread(window.app_handle(), || {
            let mut result = Vec::new();
            let mut roots = vec![
                std::path::PathBuf::from("/Applications"),
                std::path::PathBuf::from("/System/Applications"),
            ];
            if let Some(home) = std::env::var_os("HOME") {
                roots.push(std::path::PathBuf::from(home).join("Applications"));
            }
            for root in roots {
                for name in [
                    "Safari",
                    "Google Chrome",
                    "Microsoft Edge",
                    "Brave Browser",
                    "Firefox",
                    "Chromium",
                    "Vivaldi",
                    "Opera",
                    "Arc",
                ] {
                    if let Ok(item) = browser(&root.join(format!("{name}.app")).to_string_lossy()) {
                        if !result
                            .iter()
                            .any(|existing: &Browser| existing.path == item.path)
                        {
                            result.push(item);
                        }
                    }
                }
            }
            Ok(result)
        })
        .await?
    };
    #[cfg(windows)]
    let result = tauri::async_runtime::spawn_blocking(windows::installed_browsers)
        .await
        .map_err(|_| "Could not discover browsers")?;
    #[cfg(not(any(target_os = "macos", windows)))]
    let result = Vec::new();
    if let Ok(mut cache) = CATALOG.lock() {
        *cache = Some((Instant::now(), result.clone()));
    }
    Ok(result)
}

#[tauri::command]
pub async fn validate_browser_application(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    path: String,
) -> Result<Browser, String> {
    authorize(&window, &origin)?;
    #[cfg(target_os = "macos")]
    {
        on_browser_main_thread(window.app_handle(), move || browser_with_icon(&path)).await
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || windows::browser_with_icon(&path))
            .await
            .map_err(|_| "Could not read application")?
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Err("Browser routing is available on macOS".into())
    }
}

#[tauri::command]
pub fn open_browser_url(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    path: String,
    url: String,
) -> Result<(), String> {
    authorize(&window, &origin)?;
    if !web_url(&url) {
        return Err("Only HTTP and HTTPS links are supported".into());
    }
    #[cfg(target_os = "macos")]
    {
        let selected = browser(&path)?;
        let status = std::process::Command::new("/usr/bin/open")
            .arg("-a")
            .arg(selected.path)
            .arg("--")
            .arg(url)
            .status()
            .map_err(|_| "Could not open browser")?;
        if status.success() {
            Ok(())
        } else {
            Err("Browser could not open the link".into())
        }
    }
    #[cfg(windows)]
    {
        windows::open_browser_url(&path, &url)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Err("Browser routing is available on macOS".into())
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBrowserStatus {
    is_default: bool,
    http_handler: Option<String>,
    https_handler: Option<String>,
}

impl DefaultBrowserStatus {
    #[cfg(any(target_os = "macos", test))]
    fn new(http_handler: Option<String>, https_handler: Option<String>) -> Self {
        Self {
            is_default: http_handler.as_deref() == Some("com.aliasmode.desktop")
                && https_handler.as_deref() == Some("com.aliasmode.desktop"),
            http_handler,
            https_handler,
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn default_request_cancelled(domain: &str, code: isize) -> bool {
    (domain == "NSCocoaErrorDomain" && code == 3072)
        || (domain == "NSOSStatusErrorDomain" && code == -128)
}

#[cfg(target_os = "macos")]
mod default_browser {
    use super::{default_request_cancelled, DefaultBrowserStatus};
    use block2::RcBlock;
    use objc2::{runtime::NSObjectProtocol, sel};
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };
    use tokio::sync::oneshot;

    // Protect against double clicks or simultaneous IPC requests, not just the UI button.
    static REQUEST_PENDING: AtomicBool = AtomicBool::new(false);
    struct RequestGuard;
    impl Drop for RequestGuard {
        fn drop(&mut self) {
            REQUEST_PENDING.store(false, Ordering::Release);
        }
    }

    fn read_status() -> DefaultBrowserStatus {
        let workspace = NSWorkspace::sharedWorkspace();
        let handler = |scheme: &str| {
            // Resolving this URL consults Launch Services locally; it never opens the URL.
            let url =
                NSURL::URLWithString(&NSString::from_str(&format!("{scheme}://example.invalid/")))?;
            let application = workspace.URLForApplicationToOpenURL(&url)?;
            NSBundle::bundleWithURL(&application)?
                .bundleIdentifier()
                .map(|id| id.to_string())
        };
        DefaultBrowserStatus::new(handler("http"), handler("https"))
    }

    pub async fn status(app: tauri::AppHandle) -> Result<DefaultBrowserStatus, String> {
        let (send, receive) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = send.send(read_status());
        })
        .map_err(|_| "Could not inspect the default browser")?;
        receive
            .await
            .map_err(|_| "Could not inspect the default browser".into())
    }

    // NSWorkspace owns the completion block until the system confirmation finishes.
    // No Launch Services setter, AppleScript, or preference-file modification is used.
    async fn request_scheme(app: &tauri::AppHandle, scheme: &'static str) -> Result<bool, String> {
        let (send, receive) = oneshot::channel();
        app.run_on_main_thread(move || {
            let workspace = NSWorkspace::sharedWorkspace();
            if !workspace.respondsToSelector(sel!(setDefaultApplicationAtURL:toOpenURLsWithScheme:completionHandler:)) {
                let _ = send.send(Err("This macOS version cannot show the default-browser request. Select AliasMode in System Settings → Default web browser.".into()));
                return;
            }
            let bundle = NSBundle::mainBundle();
            if bundle.bundleIdentifier().as_deref().map(|id| id.to_string()).as_deref() != Some("com.aliasmode.desktop") {
                let _ = send.send(Err("Install and run the AliasMode app from Applications before setting it as the default browser.".into()));
                return;
            }
            let send = Mutex::new(Some(send));
            let completion = RcBlock::new(move |error: *mut NSError| {
                // NSError is valid for the lifetime of this callback. Copy its message here;
                // never pass Objective-C objects across the async channel.
                let result = match unsafe { error.as_ref() } {
                    None => Ok(true),
                    Some(error) if default_request_cancelled(&error.domain().to_string(), error.code()) => Ok(false),
                    Some(error) => Err(error.localizedDescription().to_string()),
                };
                if let Ok(mut sender) = send.lock() {
                    if let Some(sender) = sender.take() { let _ = sender.send(result); }
                }
            });
            workspace.setDefaultApplicationAtURL_toOpenURLsWithScheme_completionHandler(
                &bundle.bundleURL(), &NSString::from_str(scheme), Some(&completion),
            );
        }).map_err(|_| "Could not show the macOS default-browser request")?;
        receive
            .await
            .map_err(|_| "The macOS default-browser request did not complete".to_owned())?
    }

    pub async fn request(app: tauri::AppHandle) -> Result<DefaultBrowserStatus, String> {
        if REQUEST_PENDING.swap(true, Ordering::AcqRel) {
            return Err("A default-browser request is already open".into());
        }
        let _guard = RequestGuard;
        let current = status(app.clone()).await?;
        if current.is_default {
            return Ok(current);
        }
        // macOS normally applies the browser choice to both schemes. Only request the
        // second scheme if still necessary; cancellation must never open another prompt.
        if current.http_handler.as_deref() != Some("com.aliasmode.desktop")
            && !request_scheme(&app, "http").await?
        {
            return status(app).await;
        }
        let current = status(app.clone()).await?;
        if current.https_handler.as_deref() != Some("com.aliasmode.desktop") {
            request_scheme(&app, "https").await?;
        }
        status(app).await
    }
}

#[tauri::command]
pub async fn default_browser_status(
    app: tauri::AppHandle,
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
) -> Result<DefaultBrowserStatus, String> {
    authorize(&window, &origin)?;
    #[cfg(target_os = "macos")]
    {
        default_browser::status(app).await
    }
    #[cfg(windows)]
    {
        let _ = app;
        windows::status()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Err("Default browser settings are available on macOS".into())
    }
}

#[tauri::command]
pub async fn request_default_browser(
    app: tauri::AppHandle,
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
) -> Result<DefaultBrowserStatus, String> {
    authorize(&window, &origin)?;
    #[cfg(target_os = "macos")]
    {
        default_browser::request(app).await
    }
    #[cfg(windows)]
    {
        windows::request(app)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Err("Default browser settings are available on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{chooser_size, default_request_cancelled, web_url, DefaultBrowserStatus};
    #[test]
    fn chooser_is_compact_and_fits_the_monitor() {
        assert_eq!(chooser_size(None), (480.0, 520.0));
        assert_eq!(chooser_size(Some((420.0, 400.0))), (420.0, 400.0));
        assert_eq!(chooser_size(Some((1920.0, 1080.0))), (480.0, 520.0));
        assert_eq!(chooser_size(Some((0.0, -10.0))), (1.0, 1.0));
    }

    #[test]
    fn ipc_snapshots_preserve_revision_and_duplicate_occurrence_ids() {
        let mut queue = super::UrlQueue::default();
        queue.push("https://example.com".into());
        queue.push("https://example.com".into());
        queue.dismiss(queue.pending()[0].id);
        assert_eq!(
            serde_json::to_value(super::pending_urls(&queue)).unwrap(),
            serde_json::json!({
                "revision": "3", "urls": [{"id": "2", "url": "https://example.com"}],
            })
        );
    }

    #[test]
    fn cancellation_is_not_reported_as_a_failed_request() {
        assert!(default_request_cancelled("NSCocoaErrorDomain", 3072));
        assert!(default_request_cancelled("NSOSStatusErrorDomain", -128));
        assert!(!default_request_cancelled("NSCocoaErrorDomain", -128));
        assert!(!default_request_cancelled("NSOSStatusErrorDomain", -10814));
    }
    #[test]
    fn default_status_uses_the_frontend_schema() {
        let status = DefaultBrowserStatus::new(None, None);
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            serde_json::json!({
                "isDefault": false, "httpHandler": null, "httpsHandler": null,
            })
        );
    }
    #[test]
    fn default_requires_both_web_schemes() {
        let own = Some("com.aliasmode.desktop".to_owned());
        let other = Some("com.apple.Safari".to_owned());
        assert!(DefaultBrowserStatus::new(own.clone(), own.clone()).is_default);
        assert!(!DefaultBrowserStatus::new(own.clone(), other.clone()).is_default);
        assert!(!DefaultBrowserStatus::new(other, own.clone()).is_default);
        assert!(!DefaultBrowserStatus::new(own, None).is_default);
        assert!(!DefaultBrowserStatus::new(None, None).is_default);
    }
    #[test]
    fn only_safe_web_links() {
        assert!(web_url("https://example.com/path?q=1#anchor"));
        assert!(web_url("http://localhost:8000/"));
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "--args",
            "https://user:secret@example.com",
            "not a url",
        ] {
            assert!(!web_url(url));
        }
        assert!(!web_url(&format!(
            "https://example.com/{}",
            "a".repeat(16384)
        )));
    }
}
