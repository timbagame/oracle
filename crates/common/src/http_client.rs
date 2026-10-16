//! Outbound HTTP clients. reqwest is built without a bundled TLS crypto provider,
//! so every client shares rustls' ring provider with the WebSocket transport.

use std::sync::Once;

/// Installs ring as the process-wide rustls provider. Safe to call repeatedly.
pub fn install_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        // Fails only if a provider is already installed, which serves as well.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// `reqwest::Client::builder()`, with the crypto provider installed first.
pub fn client_builder() -> reqwest::ClientBuilder {
    install_crypto_provider();
    reqwest::Client::builder()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_clients_with_the_ring_provider() {
        client_builder().build().expect("client builds once a provider is installed");
        let provider = rustls::crypto::CryptoProvider::get_default().expect("provider installed");
        assert!(!provider.cipher_suites.is_empty());
        install_crypto_provider();
        client_builder().https_only(true).build().expect("repeat installs are harmless");
    }
}
