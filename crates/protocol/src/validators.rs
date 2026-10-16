//! Port of the `@timbagame/protocol/common` string validators.

const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const U64_MAX: &str = "18446744073709551615";

fn is_base58(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| BASE58_ALPHABET.contains(&b))
}

/// Callers bound the encoded length and check the alphabet first.
fn has_base58_decoded_length(value: &str, expected: usize) -> bool {
    bs58::decode(value).into_vec().is_ok_and(|bytes| bytes.len() == expected)
}

pub fn is_solana_address(value: &str) -> bool {
    (32..=44).contains(&value.len()) && is_base58(value) && has_base58_decoded_length(value, 32)
}

pub fn is_solana_signature(value: &str) -> bool {
    (64..=88).contains(&value.len()) && is_base58(value) && has_base58_decoded_length(value, 64)
}

/// Strict padded base64 (`BASE64_PATTERN`) without length limits.
pub fn is_strict_base64(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return false;
    }
    let is_char = |b: u8| b.is_ascii_alphanumeric() || b == b'+' || b == b'/';
    let n = bytes.len();
    for (i, &b) in bytes.iter().enumerate() {
        if is_char(b) {
            continue;
        }
        // Padding is only allowed in the final quad: "xx==" or "xxx=".
        let in_last_quad = i + 4 >= n && n >= 4;
        if b != b'=' || !in_last_quad {
            return false;
        }
        let pos_in_quad = i - (n - 4);
        let ok = match pos_in_quad {
            3 => true,
            2 => bytes[3 + n - 4] == b'=',
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

pub fn is_base64_transaction(value: &str) -> bool {
    (1..=16_384).contains(&value.len()) && is_strict_base64(value)
}

pub fn is_hex32(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn is_u64_string(value: &str) -> bool {
    if value.is_empty() || value.len() > U64_MAX.len() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if value.len() > 1 && value.starts_with('0') {
        return false;
    }
    value.len() < U64_MAX.len() || value <= U64_MAX
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_and_signatures() {
        assert!(is_solana_address("11111111111111111111111111111111"));
        assert!(is_solana_address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
        assert!(!is_solana_address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5D0"));
        assert!(!is_solana_address("1111111111111111111111111111111"));
        let sig = bs58::encode([9u8; 64]).into_string();
        assert!(is_solana_signature(&sig));
        assert!(!is_solana_signature(&bs58::encode([9u8; 63]).into_string()));
    }

    #[test]
    fn base64() {
        assert!(is_strict_base64(""));
        assert!(is_strict_base64("AAAA"));
        assert!(is_strict_base64("AA=="));
        assert!(is_strict_base64("AAA="));
        assert!(is_strict_base64("AAAAAA=="));
        assert!(!is_strict_base64("A==="));
        assert!(!is_strict_base64("AA=A"));
        assert!(!is_strict_base64("AAA"));
        assert!(!is_strict_base64("AA==AAAA"));
        assert!(!is_base64_transaction(""));
    }

    #[test]
    fn u64_and_hex() {
        assert!(is_u64_string("0"));
        assert!(is_u64_string(U64_MAX));
        assert!(!is_u64_string("18446744073709551616"));
        assert!(!is_u64_string("01"));
        assert!(!is_u64_string("-1"));
        assert!(is_hex32(&"aB".repeat(32)));
        assert!(!is_hex32(&"g".repeat(64)));
    }
}
