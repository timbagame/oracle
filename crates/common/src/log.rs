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

fn min_level() -> u8 {
    INIT.get_or_init(|| {
        if MIN_LEVEL.load(Ordering::Relaxed) != u8::MAX {
            return;
        }
        let silent = std::env::var("LOG_SILENT").map(|v| v == "1" || v == "true").unwrap_or(false);
        let level = if silent {
            Level::Silent
        } else {
            match std::env::var("LOG_LEVEL").unwrap_or_default().to_lowercase().as_str() {
                "debug" => Level::Debug,
                "warn" => Level::Warn,
                "error" => Level::Error,
                _ => Level::Info,
            }
        };
        MIN_LEVEL.store(level as u8, Ordering::Relaxed);
    });
    MIN_LEVEL.load(Ordering::Relaxed)
}

pub fn set_level(level: Level) {
    MIN_LEVEL.store(level as u8, Ordering::Relaxed);
    let _ = INIT.set(());
}

pub fn enabled(level: Level) -> bool {
    level as u8 >= min_level()
}

pub fn write(level: Level, message: std::fmt::Arguments<'_>) {
    if !enabled(level) {
        return;
    }
    let line = format!("[{}] {}", crate::time::now_iso(), message);
    match level {
        Level::Warn | Level::Error => eprintln!("{line}"),
        _ => println!("{line}"),
    }
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
