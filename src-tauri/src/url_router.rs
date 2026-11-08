//! Local-only URL inbox. Never log links: they may contain authentication tokens.
use crate::credentials::{authorize, CredentialOrigin};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

#[derive(Default)]
pub struct UrlInbox(pub Mutex<Vec<String>>);

/// Temporary presentation only: never persist chooser dimensions as dashboard geometry.
#[derive(Default)]
pub struct ChooserPresentation(Mutex<Option<WindowSnapshot>>);

struct WindowSnapshot {
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
    visible: bool,
    minimized: bool,
    maximized: bool,
    fullscreen: bool,
    resizable: bool,
    closable: bool,
}

impl WindowSnapshot {
    fn capture(window: &WebviewWindow) -> tauri::Result<Self> {
        Ok(Self {
            size: window.inner_size()?,
            position: window.outer_position()?,
            visible: window.is_visible()?,
            minimized: window.is_minimized()?,
            maximized: window.is_maximized()?,
            fullscreen: window.is_fullscreen()?,
            resizable: window.is_resizable()?,
            closable: window.is_closable()?,
        })
    }

    fn restore(&self, window: &WebviewWindow) -> tauri::Result<()> {
        // Attempt every operation even if one fails, especially restoring Close.
        let mut result = Ok(());
        let mut apply = |next: tauri::Result<()>| {
            if result.is_ok() {
                result = next;
            }
        };
        if !self.visible || self.minimized {
            apply(window.hide());
        }
        apply(window.set_resizable(self.resizable));
        apply(window.set_closable(self.closable));
        apply(window.set_min_size(Some(LogicalSize::new(960.0, 640.0))));
        apply(window.set_size(self.size));
        apply(window.set_position(self.position));
        if self.maximized {
            apply(window.maximize());
        }
        if self.fullscreen {
            apply(window.set_fullscreen(true));
        }
        if self.visible {
            apply(window.show());
        }
        if self.minimized {
            apply(window.minimize());
        }
        // Do not focus the dashboard: the selected browser should keep focus.
        result
    }
}

fn chooser_size(height: Option<f64>, available: Option<(f64, f64)>) -> (f64, f64) {
    let height = height
        .filter(|value| value.is_finite())
        .unwrap_or(520.0)
        .clamp(300.0, 620.0);
    let (width_limit, height_limit) = available.unwrap_or((480.0, 620.0));
    (
        480.0_f64.min(width_limit.max(1.0)),
        height.min(height_limit.max(1.0)),
    )
}

pub(crate) fn chooser_active(app: &tauri::AppHandle) -> bool {
    app.state::<ChooserPresentation>()
        .0
        .lock()
        .map(|state| state.is_some())
        .unwrap_or(false)
}

fn restore_dashboard(window: &WebviewWindow) -> Result<(), String> {
    let state = window.app_handle().state::<ChooserPresentation>();
    let mut state = state.0.lock().map_err(|_| "Chooser window unavailable")?;
    if let Some(snapshot) = state.as_ref() {
        snapshot
            .restore(window)
            .map_err(|_| "Could not restore the dashboard window")?;
        *state = None;
    }
    Ok(())
}

/// The frontend calls this only after rendering the chooser-only view. Never show
/// the dashboard first, and never replace the original snapshot for the next URL.
#[tauri::command]
pub fn present_browser_chooser(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    inbox: State<'_, UrlInbox>,
    presentation: State<'_, ChooserPresentation>,
    height: Option<f64>,
) -> Result<(), String> {
    authorize(&window, &origin)?;
    let pending = inbox.0.lock().map_err(|_| "URL inbox unavailable")?;
    if pending.is_empty() {
        return Ok(());
    }
    let mut state = presentation
        .0
        .lock()
        .map_err(|_| "Chooser window unavailable")?;
    if state.is_some() {
        return Ok(());
    }
    let snapshot =
        WindowSnapshot::capture(&window).map_err(|_| "Could not inspect dashboard window")?;
    let available = window.current_monitor().ok().flatten().map(|monitor| {
        let work = monitor.work_area();
        (
            f64::from(work.size.width) / monitor.scale_factor() - 32.0,
            f64::from(work.size.height) / monitor.scale_factor() - 64.0,
        )
    });
    let (width, height) = chooser_size(height, available);
    let result = (|| -> tauri::Result<()> {
        if snapshot.fullscreen {
            window.set_fullscreen(false)?;
        }
        if snapshot.maximized {
            window.unmaximize()?;
        }
        window.set_min_size(Some(LogicalSize::new(width.min(320.0), height.min(300.0))))?;
        window.set_size(LogicalSize::new(width, height))?;
        window.set_resizable(false)?;
        window.set_closable(false)?;
        window.center()?;
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = snapshot.restore(&window);
        return Err("Could not show the compact browser chooser".into());
    }
    *state = Some(snapshot);
    Ok(())
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

pub fn receive(app: &tauri::AppHandle, urls: impl IntoIterator<Item = String>) {
    let inbox = app.state::<UrlInbox>();
    let mut received = false;
    if let Ok(mut pending) = inbox.0.lock() {
        for url in urls {
            if web_url(&url) && pending.len() < 100 {
                pending.push(url);
                received = true;
            }
        }
    }
    if !received {
        return;
    }
    // A ready frontend presents the first URL. Subsequent OS links may bring
    // the already compact chooser forward without flashing the dashboard.
    if chooser_active(app) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
pub fn pending_browser_urls(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    inbox: State<'_, UrlInbox>,
) -> Result<Vec<String>, String> {
    authorize(&window, &origin)?;
    Ok(inbox.0.lock().map_err(|_| "URL inbox unavailable")?.clone())
}

#[tauri::command]
pub fn dismiss_browser_url(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    inbox: State<'_, UrlInbox>,
    url: String,
) -> Result<(), String> {
    authorize(&window, &origin)?;
    let mut pending = inbox.0.lock().map_err(|_| "URL inbox unavailable")?;
    if let Some(index) = pending.iter().position(|item| item == &url) {
        pending.remove(index);
    }
    if pending.is_empty() {
        restore_dashboard(&window)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Browser {
    path: String,
    name: String,
    icon: Option<String>,
}

#[cfg(target_os = "macos")]
fn browser(path: &str) -> Result<Browser, String> {
    let path = std::fs::canonicalize(path).map_err(|_| "Application not found")?;
    if path.extension().and_then(|s| s.to_str()) != Some("app") || !path.is_dir() {
        return Err("Choose an installed .app application".into());
    }
    let output = std::process::Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(path.join("Contents/Info.plist"))
        .output()
        .map_err(|_| "Cannot inspect application")?;
    let id = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success()
        || id.is_empty()
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
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDataBase64EncodingOptions, NSDictionary, NSString};
    let mut selected = browser(path)?;
    // Called only by the main-thread closure below. No files leave this machine.
    selected.icon = (|| {
        let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(&selected.path));
        let tiff = image.TIFFRepresentation()?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
        // Empty properties contain no incorrectly typed values.
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
    })();
    Ok(selected)
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
) -> Result<Vec<Browser>, String> {
    authorize(&window, &origin)?;
    #[cfg(target_os = "macos")]
    {
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
                    if let Ok(item) =
                        browser_with_icon(&root.join(format!("{name}.app")).to_string_lossy())
                    {
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
        .await
    }
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
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
    #[cfg(not(target_os = "macos"))]
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
    #[cfg(not(target_os = "macos"))]
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
    #[cfg(not(target_os = "macos"))]
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
    #[cfg(not(target_os = "macos"))]
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
        assert_eq!(chooser_size(None, None), (480.0, 520.0));
        assert_eq!(chooser_size(Some(100.0), None), (480.0, 300.0));
        assert_eq!(chooser_size(Some(999.0), None), (480.0, 620.0));
        assert_eq!(chooser_size(Some(f64::NAN), None), (480.0, 520.0));
        assert_eq!(chooser_size(Some(f64::INFINITY), None), (480.0, 520.0));
        assert_eq!(chooser_size(None, Some((420.0, 400.0))), (420.0, 400.0));
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
