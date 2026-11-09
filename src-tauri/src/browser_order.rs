//! Browser chooser preferences are native app data, independent of the sidecar's port.
use crate::credentials::{authorize, CredentialOrigin};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{Manager, State, WebviewWindow};

const MAX_BROWSERS: usize = 100;
const MAX_PATH_BYTES: usize = 4096;
// JSON may escape each byte into six characters. Bound reads before parsing.
const MAX_FILE_BYTES: u64 = (MAX_BROWSERS * (MAX_PATH_BYTES * 6 + 4) + 128) as u64;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BrowserOrder {
    version: u32,
    order: Vec<String>,
}

fn validate_order(order: Vec<String>) -> Result<Vec<String>, String> {
    if order.len() > MAX_BROWSERS {
        return Err("Browser order contains too many applications".into());
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in order {
        let path = Path::new(&value);
        if value.len() > MAX_PATH_BYTES
            || value.chars().any(char::is_control)
            || !path.is_absolute()
            || path.extension().and_then(|ext| ext.to_str()) != Some("app")
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("Browser order must contain absolute .app paths".into());
        }
        // Do not inspect or launch applications here. Removed apps may remain in saved order.
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    Ok(result)
}

fn read_order(path: &Path) -> Result<Vec<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read browser order".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read browser order")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Saved browser order is too large".into());
    }
    let saved: BrowserOrder =
        serde_json::from_slice(&bytes).map_err(|_| "Saved browser order is invalid")?;
    if saved.version != 1 {
        return Err("Saved browser order version is unsupported".into());
    }
    validate_order(saved.order)
}

fn write_order(path: &Path, order: Vec<String>) -> Result<(), String> {
    let order = validate_order(order)?;
    let directory = path
        .parent()
        .ok_or("Browser order location is unavailable")?;
    fs::create_dir_all(directory).map_err(|_| "Could not create browser preferences directory")?;
    let bytes = serde_json::to_vec(&BrowserOrder { version: 1, order })
        .map_err(|_| "Could not encode browser order")?;
    // A unique same-directory file prevents concurrent requests from colliding. Persist
    // atomically replaces the old file; failure preserves it and drops the temporary file.
    let mut temporary =
        tempfile::NamedTempFile::new_in(directory).map_err(|_| "Could not save browser order")?;
    temporary
        .write_all(&bytes)
        .map_err(|_| "Could not save browser order")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Could not save browser order")?;
    temporary
        .persist(path)
        .map_err(|_| "Could not replace browser order")?;
    Ok(())
}

fn preferences_path(window: &WebviewWindow) -> Result<PathBuf, String> {
    window
        .app_handle()
        .path()
        .app_data_dir()
        .map(|directory| directory.join("browser-order.json"))
        .map_err(|_| "Browser preferences location is unavailable".into())
}

#[tauri::command]
pub fn browser_order(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
) -> Result<Vec<String>, String> {
    authorize(&window, &origin)?;
    read_order(&preferences_path(&window)?)
}

#[tauri::command]
pub fn save_browser_order(
    window: WebviewWindow,
    origin: State<'_, CredentialOrigin>,
    order: Vec<String>,
) -> Result<(), String> {
    authorize(&window, &origin)?;
    write_order(&preferences_path(&window)?, order)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_path(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("{name}.app"))
            .to_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn missing_file_and_restart_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences/browser-order.json");
        assert_eq!(read_order(&path).unwrap(), Vec::<String>::new());
        let order = vec![app_path("Firefox"), app_path("Safari")];
        write_order(&path, order.clone()).unwrap();
        assert_eq!(read_order(&path).unwrap(), order);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap()
                ["version"],
            1
        );
        write_order(&path, vec![]).unwrap();
        assert!(read_order(&path).unwrap().is_empty());
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn deduplicates_without_reordering() {
        let a = app_path("A");
        let b = app_path("B");
        assert_eq!(
            validate_order(vec![b.clone(), a.clone(), b.clone()]).unwrap(),
            vec![b, a]
        );
    }

    #[test]
    fn validates_limits_and_application_paths() {
        for bad in [
            "",
            "Safari.app",
            "https://example.com/A.app",
            "/Applications/A",
            "/Applications/A.app/Contents",
            "/Applications/../A.app",
            "/Applications/A\0.app",
            "/Applications/A\n.app",
        ] {
            assert!(validate_order(vec![bad.into()]).is_err(), "{bad:?}");
        }
        assert!(validate_order(vec!["/A.app".into(); 101]).is_err());
        let base = app_path("");
        let limit = app_path(&"a".repeat(MAX_PATH_BYTES - base.len()));
        assert!(validate_order(vec![limit.clone()]).is_ok());
        assert!(validate_order(vec![format!("{limit}.app")]).is_err());
        assert!(validate_order(vec![app_path("浏览器")]).is_ok());
    }

    #[test]
    fn malformed_and_future_files_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("browser-order.json");
        for bytes in [
            "",
            "{}",
            "[]",
            r#"{"version":2,"order":[]}"#,
            r#"{"version":1,"order":["relative.app"]}"#,
            r#"{"version":1,"order":[],"extra":true}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(read_order(&path).is_err());
        }
        fs::write(&path, vec![b' '; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_order(&path).is_err());
        assert!(read_order(dir.path()).is_err());
    }

    #[test]
    fn failed_save_preserves_existing_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("browser-order.json");
        let order = vec![app_path("A")];
        write_order(&path, order.clone()).unwrap();
        assert!(write_order(&path, vec!["relative.app".into()]).is_err());
        assert_eq!(read_order(&path).unwrap(), order);
        // An existing directory cannot be replaced, and temporary files are cleaned up.
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        assert!(write_order(&blocked, vec![]).is_err());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
