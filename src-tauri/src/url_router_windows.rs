//! Windows browser registration is installed by installer-hooks.nsh.
use super::{Browser, DefaultBrowserStatus};
use ::windows::{
    core::{PCWSTR, PWSTR},
    Win32::UI::Shell::{AssocQueryStringW, ASSOCF_IS_PROTOCOL, ASSOCSTR_PROGID},
};
use std::{
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};
use tauri_plugin_shell::ShellExt;
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    RegKey,
};

const PROG_ID: &str = "AliasMode.Url";

/// Render the installed application's own Shell icon to a small transparent PNG.
pub fn app_icon(path: &str) -> Option<String> {
    use ::windows::Win32::{
        Graphics::Gdi::*,
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::{
            Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON},
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_MASK, DI_NORMAL},
        },
    };
    use base64::Engine;
    let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let mut info = SHFILEINFOW::default();
        let found = SHGetFileInfoW(
            PCWSTR(path.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if initialized {
            CoUninitialize();
        }
        if found == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let dc = CreateCompatibleDC(None);
        let result = (|| {
            if dc.is_invalid() {
                return None;
            }
            let mut bitmap_info = BITMAPINFO::default();
            bitmap_info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 48,
                biHeight: -48,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap =
                CreateDIBSection(Some(dc), &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0)
                    .ok()?;
            let previous = SelectObject(dc, bitmap.into());
            let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), 48 * 48 * 4);
            pixels.fill(0);
            let drawn = DrawIconEx(dc, 0, 0, info.hIcon, 48, 48, 0, None, DI_NORMAL);
            let mut rgba = pixels.to_vec();
            // Older icons use a separate transparency mask instead of an alpha channel.
            if rgba.chunks_exact(4).all(|pixel| pixel[3] == 0) {
                let _ = DrawIconEx(dc, 0, 0, info.hIcon, 48, 48, 0, None, DI_MASK);
                for (pixel, mask) in rgba.chunks_exact_mut(4).zip(pixels.chunks_exact(4)) {
                    pixel[3] = if mask[0] == 0 { 255 } else { 0 };
                }
            }
            SelectObject(dc, previous);
            let _ = DeleteObject(bitmap.into());
            drawn.ok()?;
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                let alpha = u16::from(pixel[3]);
                if alpha > 0 && alpha < 255 {
                    for channel in &mut pixel[..3] {
                        *channel = (u16::from(*channel) * 255 / alpha).min(255) as u8;
                    }
                }
            }
            let mut bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut bytes, 48, 48);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
            }
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })();
        if !dc.is_invalid() {
            let _ = DeleteDC(dc);
        }
        let _ = DestroyIcon(info.hIcon);
        result
    }
}

pub fn browser_with_icon(path: &str) -> Result<Browser, String> {
    let mut browser = browser(path)?;
    browser.icon = super::cached_icon(&browser.path, || app_icon(&browser.path));
    Ok(browser)
}

pub fn browser(value: &str) -> Result<Browser, String> {
    let path = Path::new(value);
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        || !path.is_file()
    {
        return Err("Choose an installed browser .exe file".into());
    }
    let path = std::fs::canonicalize(path).map_err(|_| "Browser not found")?;
    if std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::canonicalize(exe).ok())
        .as_ref()
        == Some(&path)
    {
        return Err("Cannot route a link back to AliasMode".into());
    }
    Ok(Browser {
        name: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: crate::cli_compatible_windows_path(&path)
            .to_string_lossy()
            .into_owned(),
        icon: None,
    })
}

// Read the executable only; registry command templates are never passed to a shell.
fn command_executable(command: &str) -> Option<&str> {
    let command = command.trim();
    if let Some(quoted) = command.strip_prefix('"') {
        return quoted.split_once('"').map(|(path, _)| path);
    }
    command
        .to_ascii_lowercase()
        .find(".exe")
        .map(|end| &command[..end + 4])
}

pub fn installed_browsers() -> Vec<Browser> {
    let mut result = Vec::<Browser>::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        for key in [
            r"SOFTWARE\Clients\StartMenuInternet",
            r"SOFTWARE\WOW6432Node\Clients\StartMenuInternet",
        ] {
            let Ok(clients) = root.open_subkey(key) else {
                continue;
            };
            for name in clients.enum_keys().flatten() {
                if name.eq_ignore_ascii_case("AliasMode") {
                    continue;
                }
                let Ok(client) = clients.open_subkey(&name) else {
                    continue;
                };
                let command = client
                    .open_subkey(r"shell\open\command")
                    .and_then(|key| key.get_value::<String, _>(""));
                let Ok(command) = command else { continue };
                let Some(path) = command_executable(&command) else {
                    continue;
                };
                let Ok(mut item) = browser(path) else {
                    continue;
                };
                if result
                    .iter()
                    .any(|old| old.path.eq_ignore_ascii_case(&item.path))
                {
                    continue;
                }
                if let Ok(name) = client.get_value::<String, _>("") {
                    if !name.is_empty() {
                        item.name = name;
                    }
                }
                result.push(item);
            }
        }
    }
    // Portable/current-user installs do not always register a browser client.
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        for (name, relative) in [
            ("Google Chrome", r"Google\Chrome\Application\chrome.exe"),
            ("Microsoft Edge", r"Microsoft\Edge\Application\msedge.exe"),
            ("Firefox", r"Mozilla Firefox\firefox.exe"),
            (
                "Brave",
                r"BraveSoftware\Brave-Browser\Application\brave.exe",
            ),
            ("Vivaldi", r"Vivaldi\Application\vivaldi.exe"),
        ] {
            if let Ok(mut item) = browser(&root.join(relative).to_string_lossy()) {
                if result
                    .iter()
                    .any(|old| old.path.eq_ignore_ascii_case(&item.path))
                {
                    continue;
                }
                item.name = name.into();
                result.push(item);
            }
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

pub fn open_browser_url(path: &str, url: &str) -> Result<(), String> {
    let selected = browser(path)?;
    Command::new(selected.path)
        .arg(url)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|_| "Could not open browser")?;
    Ok(())
}

fn handler(scheme: &str) -> Option<String> {
    let scheme: Vec<u16> = scheme.encode_utf16().chain(Some(0)).collect();
    let mut buffer = vec![0_u16; 1024];
    let mut size = buffer.len() as u32;
    unsafe {
        if AssocQueryStringW(
            ASSOCF_IS_PROTOCOL,
            ASSOCSTR_PROGID,
            PCWSTR(scheme.as_ptr()),
            PCWSTR::null(),
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut size,
        )
        .is_err()
        {
            return None;
        }
    }
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

pub fn status() -> Result<DefaultBrowserStatus, String> {
    let http_handler = handler("http");
    let https_handler = handler("https");
    Ok(DefaultBrowserStatus {
        is_default: [&http_handler, &https_handler].iter().all(|value| {
            value
                .as_deref()
                .is_some_and(|id| id.eq_ignore_ascii_case(PROG_ID))
        }),
        http_handler,
        https_handler,
    })
}

pub fn request(app: tauri::AppHandle) -> Result<DefaultBrowserStatus, String> {
    let registered = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"SOFTWARE\RegisteredApplications")
        .and_then(|key| key.get_value::<String, _>("AliasMode"));
    if registered.is_err() {
        return Err("Install AliasMode before choosing it in Windows Default apps.".into());
    }
    #[allow(deprecated)]
    app.shell()
        .open("ms-settings:defaultapps?registeredAppUser=AliasMode", None)
        .map_err(|_| "Could not open Windows Default apps")?;
    status()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "reads an installed application icon; run manually on Windows"]
    fn installed_application_icon_and_cache() {
        use base64::Engine;
        let path = std::env::var("ALIASMODE_TEST_ICON_PATH").expect("application path");
        let started = std::time::Instant::now();
        let first = super::super::cached_icon(&path, || app_icon(&path)).expect("application icon");
        let cold = started.elapsed();
        let started = std::time::Instant::now();
        let second = super::super::cached_icon(&path, || {
            panic!("cached icon should not be extracted twice")
        });
        let warm = started.elapsed();
        assert_eq!(Some(&first), second.as_ref());
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(first.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
        let reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (48, 48));
        if let Ok(output) = std::env::var("ALIASMODE_TEST_ICON_OUTPUT") {
            std::fs::write(output, &bytes).unwrap();
        }
        println!(
            "native icon: {} bytes, extraction {:?}, cached {:?}",
            bytes.len(),
            cold,
            warm
        );
    }
    #[test]
    fn extracts_only_the_browser_executable() {
        assert_eq!(
            command_executable(r#""C:\Program Files\Browser\browser.exe" --single-argument "%1""#),
            Some(r"C:\Program Files\Browser\browser.exe")
        );
        assert_eq!(
            command_executable(r"C:\Browser\browser.exe -url %1"),
            Some(r"C:\Browser\browser.exe")
        );
        assert_eq!(command_executable(""), None);
    }
}
