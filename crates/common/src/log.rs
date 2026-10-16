//! Timestamped console logging matching the TypeScript logger output:
//! `[2024-01-01T00:00:00.000Z] message`. `LOG_LEVEL` (debug|info|warn|error)
//! sets the minimum level; `LOG_SILENT=1` disables output.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
    Silent = 4,
}

static MIN_LEVEL: AtomicU8 = AtomicU8::new(u8::MAX);
static INIT: OnceLock<()> = OnceLock::new();

fn level_from(silent: Option<&str>, level: Option<&str>) -> Level {
    if silent.is_some_and(|v| v == "1" || v == "true") {
        return Level::Silent;
    }
    match level.unwrap_or_default().to_lowercase().as_str() {
        "debug" => Level::Debug,
        "warn" => Level::Warn,
        "error" => Level::Error,
        _ => Level::Info,
    }
}

fn min_level() -> u8 {
    INIT.get_or_init(|| {
        let level = level_from(std::env::var("LOG_SILENT").ok().as_deref(), std::env::var("LOG_LEVEL").ok().as_deref());
        MIN_LEVEL.store(level as u8, Ordering::Relaxed);
    });
    MIN_LEVEL.load(Ordering::Relaxed)
}

/// Overrides `LOG_LEVEL`/`LOG_SILENT` for the rest of the process.
pub fn set_level(level: Level) {
    min_level();
    MIN_LEVEL.store(level as u8, Ordering::Relaxed);
}

pub fn enabled(level: Level) -> bool {
    level as u8 >= min_level()
}

pub fn write(level: Level, message: std::fmt::Arguments<'_>) {
    if !enabled(level) {
        return;
    }
    match level {
        Level::Warn | Level::Error => write_line(&mut std::io::stderr().lock(), message),
        _ => write_line(&mut std::io::stdout().lock(), message),
    }
}

/// Writes one timestamped line. Write errors are ignored: `println!` would panic
/// on a closed pipe (Rust ignores SIGPIPE), sometimes while the caller holds a lock.
fn write_line(out: &mut impl std::io::Write, message: std::fmt::Arguments<'_>) {
    let _ = writeln!(out, "[{}] {}", crate::time::now_iso(), message);
}

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => { $crate::log::write($crate::log::Level::Debug, format_args!($($arg)*)) };
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => { $crate::log::write($crate::log::Level::Info, format_args!($($arg)*)) };
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => { $crate::log::write($crate::log::Level::Warn, format_args!($($arg)*)) };
}

#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => { $crate::log::write($crate::log::Level::Error, format_args!($($arg)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_levels_from_the_environment_values() {
        assert_eq!(level_from(None, None), Level::Info);
        assert_eq!(level_from(Some("0"), Some("DEBUG")), Level::Debug);
        assert_eq!(level_from(None, Some("warn")), Level::Warn);
        assert_eq!(level_from(None, Some("error")), Level::Error);
        assert_eq!(level_from(None, Some("verbose")), Level::Info);
        assert_eq!(level_from(Some("1"), Some("debug")), Level::Silent);
        assert_eq!(level_from(Some("true"), None), Level::Silent);
    }

    struct Broken;

    impl std::io::Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            unreachable!("writeln! does not flush")
        }
    }

    #[test]
    fn writes_timestamped_lines_and_survives_a_closed_pipe() {
        let mut out = Vec::new();
        write_line(&mut out, format_args!("hello {}", 1));
        let line = String::from_utf8(out).unwrap();
        assert!(line.starts_with('[') && line.ends_with("] hello 1\n"), "{line}");
        write_line(&mut Broken, format_args!("dropped"));
    }

    #[test]
    fn filters_by_level() {
        // Loads LOG_LEVEL/LOG_SILENT first (unset under `cargo test`), then overrides.
        assert!(!enabled(Level::Debug));
        set_level(Level::Warn);
        assert!(!enabled(Level::Info) && enabled(Level::Warn) && enabled(Level::Error));
        crate::info!("filtered out");
        crate::debug!("filtered out");
        crate::warn!("shown on stderr");
        crate::error!("shown on stderr");
        set_level(Level::Info);
        crate::info!("shown on stdout");
        assert!(enabled(Level::Info) && !enabled(Level::Debug));
    }
}
