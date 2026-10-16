//! Ed25519 operator keypairs (Solana CLI JSON format) and loading rules from
//! `OracleService.loadOperatorKeypair`.

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use timba_common::{error, info, warn};
use timba_protocol::Address;

#[derive(Clone)]
pub struct Keypair {
    signing: SigningKey,
    address: Address,
}

impl std::fmt::Debug for Keypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keypair").field("address", &self.address).finish_non_exhaustive()
    }
}

impl Keypair {
    pub fn generate() -> Self {
        let signing = SigningKey::generate(&mut rand::rngs::OsRng);
        Self::from_signing(signing)
    }

    fn from_signing(signing: SigningKey) -> Self {
        let address = Address(signing.verifying_key().to_bytes());
        Self { signing, address }
    }

    /// 64 bytes: secret seed followed by the public key, which must match.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != 64 {
            return Err(format!("Key pair bytes must be of length 64, got {}.", bytes.len()));
        }
        let seed: [u8; 32] = bytes[..32].try_into().expect("32 bytes");
        let keypair = Self::from_signing(SigningKey::from_bytes(&seed));
        if keypair.address.0 != bytes[32..] {
            return Err("The provided private key does not match the provided public key.".into());
        }
        Ok(keypair)
    }

    pub fn to_bytes(&self) -> [u8; 64] {
        self.signing.to_keypair_bytes()
    }

    pub fn address(&self) -> Address {
        self.address
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }
}

pub fn verify_signature(address: &Address, message: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(&address.0) else { return false };
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(signature)).is_ok()
}

#[derive(Debug)]
enum LoadError {
    Missing,
    Permission(String),
    Other(String),
}

fn read_keypair_file(path: &str) -> Result<Keypair, LoadError> {
    let classify = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => LoadError::Missing,
        std::io::ErrorKind::PermissionDenied => LoadError::Permission(format!("EACCES: permission denied, {e}")),
        _ => LoadError::Other(e.to_string()),
    };
    let meta = std::fs::metadata(path).map_err(classify)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(LoadError::Other(format!(
                "Operator keypair file {path} has insecure permissions ({mode:o}). It must be accessible only by the owner (e.g. 600)."
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = meta;
    let content = std::fs::read_to_string(path).map_err(classify)?;
    let parsed: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| LoadError::Other(format!("JSON Parse error: {e}")))?;
    let array = parsed
        .as_array()
        .ok_or_else(|| LoadError::Other("Operator keypair file must contain an array of numbers".into()))?;
    let mut bytes = Vec::with_capacity(array.len());
    for value in array {
        let number = value
            .as_f64()
            .filter(|n| n.fract() == 0.0)
            .ok_or_else(|| LoadError::Other("Operator keypair file must contain integer byte values".into()))?;
        if !(0.0..=255.0).contains(&number) {
            return Err(LoadError::Other("Operator keypair file contains byte values outside the 0-255 range".into()));
        }
        bytes.push(number as u8);
    }
    Keypair::from_bytes(&bytes).map_err(LoadError::Other)
}

fn describe(source: &str, error: &LoadError) -> String {
    match error {
        LoadError::Missing => format!("{source} was not found."),
        LoadError::Permission(message) => format!("{source} could not be read: {message}"),
        LoadError::Other(message) => format!("{source} could not be loaded: {message}"),
    }
}

/// Loads the operator keypair, falling back to an ephemeral key when allowed.
pub fn load_operator_keypair(path: &str, source: &str, use_ephemeral: bool) -> Result<Keypair, String> {
    match read_keypair_file(path) {
        Ok(keypair) => {
            info!("✅ Loaded operator keypair: {}", keypair.address());
            Ok(keypair)
        }
        Err(err) if use_ephemeral => {
            let keypair = Keypair::generate();
            warn!("⚠️ Using ephemeral operator keypair {} because {}", keypair.address(), describe(source, &err));
            Ok(keypair)
        }
        Err(err) => {
            let message = match &err {
                LoadError::Missing => format!("ENOENT: no such file or directory, open '{path}'"),
                LoadError::Permission(m) | LoadError::Other(m) => m.clone(),
            };
            error!("❌ Failed to load operator keypair from {path}: {message}");
            Err(describe(source, &err))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_verifies() {
        let keypair = Keypair::generate();
        let restored = Keypair::from_bytes(&keypair.to_bytes()).unwrap();
        assert_eq!(restored.address(), keypair.address());
        let signature = keypair.sign(b"hello");
        assert!(verify_signature(&keypair.address(), b"hello", &signature));
        assert!(!verify_signature(&keypair.address(), b"hellO", &signature));
        let mut mismatched = keypair.to_bytes();
        mismatched[63] ^= 1;
        assert!(Keypair::from_bytes(&mismatched).is_err());
        assert!(Keypair::from_bytes(&[0; 10]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn loading_rules() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k.json");
        let p = path.to_str().unwrap();
        assert_eq!(load_operator_keypair(p, "k.json", false).unwrap_err(), "k.json was not found.");
        assert!(load_operator_keypair(p, "k.json", true).is_ok());

        let keypair = Keypair::generate();
        std::fs::write(&path, serde_json::to_string(&keypair.to_bytes().to_vec()).unwrap()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_operator_keypair(p, "k.json", false).unwrap_err().contains("insecure permissions (644)"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(load_operator_keypair(p, "k.json", false).unwrap().address(), keypair.address());

        std::fs::write(&path, "[1, 2.5]").unwrap();
        assert!(load_operator_keypair(p, "k.json", false).unwrap_err().contains("integer byte values"));
        std::fs::write(&path, "[300]").unwrap();
        assert!(load_operator_keypair(p, "k.json", false).unwrap_err().contains("0-255"));
        std::fs::write(&path, "{}").unwrap();
        assert!(load_operator_keypair(p, "k.json", false).unwrap_err().contains("array of numbers"));
    }

    #[test]
    fn debug_output_hides_the_secret() {
        let keypair = Keypair::generate();
        let printed = format!("{keypair:?}");
        assert!(printed.contains(&keypair.address().to_base58()), "{printed}");
        assert!(!printed.contains("signing"), "{printed}");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_locations_are_described() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plain");
        std::fs::write(&file, "x").unwrap();
        // A file where a directory is expected is neither missing nor forbidden.
        let behind_file = file.join("k.json");
        let err = load_operator_keypair(behind_file.to_str().unwrap(), "k.json", false).unwrap_err();
        assert!(err.starts_with("k.json could not be loaded: "), "{err}");

        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        let path = locked.join("k.json");
        std::fs::write(&path, "[]").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let strict = load_operator_keypair(path.to_str().unwrap(), "k.json", false);
        let ephemeral = load_operator_keypair(path.to_str().unwrap(), "k.json", true);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        let err = strict.unwrap_err();
        assert!(err.starts_with("k.json could not be read: EACCES: permission denied, "), "{err}");
        assert!(ephemeral.is_ok(), "an ephemeral key stands in for the unreadable one");
    }
}
