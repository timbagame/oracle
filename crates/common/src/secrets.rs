//! Protected secret files: regular files (no symlinks), 1..=4096 bytes, no
//! group/other permission bits, non-empty after trimming.

use std::path::{Path, PathBuf};

pub fn resolve_path(value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|d| d.join(path)).unwrap_or_else(|_| path.to_path_buf())
    }
}

pub fn read_protected_secret(file_path: &str, label: &str) -> Result<String, String> {
    let resolved = resolve_path(file_path);
    let meta = std::fs::symlink_metadata(&resolved)
        .map_err(|e| format!("ENOENT: {label} could not be read ({}): {e}", resolved.display()))?;
    if !meta.file_type().is_file() || meta.file_type().is_symlink() {
        return Err(format!("{label} must be a regular file, not a symlink"));
    }
    if meta.len() == 0 || meta.len() > 4096 {
        return Err(format!("{label} has an invalid size"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!("{label} has insecure permissions ({mode:o}); use 400 or 600"));
        }
    }
    // Node decodes invalid UTF-8 as U+FFFD instead of failing.
    let bytes = std::fs::read(&resolved).map_err(|e| format!("{label} could not be read: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let value = crate::env::js_trim(&text);
    if value.is_empty() {
        return Err(format!("{label} is empty"));
    }
    Ok(value.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn validates_permissions_and_content() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "  secret\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let path = file.to_str().unwrap();
        assert!(read_protected_secret(path, "T").unwrap_err().contains("insecure permissions (644)"));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_protected_secret(path, "T").unwrap(), "secret");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(read_protected_secret(link.to_str().unwrap(), "T").unwrap_err().contains("symlink"));
        std::fs::write(&file, "   \n").unwrap();
        assert_eq!(read_protected_secret(path, "T").unwrap_err(), "T is empty");
        for size in [0, 4097] {
            std::fs::write(&file, "x".repeat(size)).unwrap();
            assert_eq!(read_protected_secret(path, "T").unwrap_err(), "T has an invalid size");
        }
    }

    #[test]
    fn trims_byte_order_marks_and_decodes_like_node() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        let path = file.to_str().unwrap();
        for (content, expected) in [(&b"\xef\xbb\xbfsecret\r\n"[..], "secret"), (b"caf\xe9", "caf\u{fffd}")] {
            std::fs::write(&file, content).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(read_protected_secret(path, "T").unwrap(), expected);
        }
    }
}
