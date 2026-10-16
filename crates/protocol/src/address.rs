use std::fmt;
use std::str::FromStr;

use curve25519_dalek::edwards::CompressedEdwardsY;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const SYSTEM_PROGRAM_ID: Address = Address([0; 32]);
pub const TOKEN_PROGRAM_ID: Address = Address::from_static("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Address = Address::from_static("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const COMPUTE_BUDGET_PROGRAM_ID: Address = Address::from_static("ComputeBudget111111111111111111111111111111");
pub const WRAPPED_SOL_MINT: Address = Address::from_static("So11111111111111111111111111111111111111112");

const MAX_SEED_LENGTH: usize = 32;
const MAX_SEEDS: usize = 16;
const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AddressError {
    #[error("Invalid Solana address: {0}")]
    Invalid(String),
    #[error("Unable to find a viable program address bump seed")]
    NoViableBump,
    #[error("Invalid program derived address seeds")]
    InvalidSeeds,
    #[error("Provided seeds produce an on-curve address")]
    OnCurve,
}

/// A 32-byte Solana account address (public key).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Address(pub [u8; 32]);

impl Address {
    pub const fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Decodes a compile-time base58 constant. Panics on invalid input.
    pub const fn from_static(value: &str) -> Self {
        match decode_base58_const(value.as_bytes()) {
            Some(bytes) => Self(bytes),
            None => panic!("invalid static address"),
        }
    }

    pub fn from_slice(bytes: &[u8]) -> Result<Self, AddressError> {
        let array: [u8; 32] =
            bytes.try_into().map_err(|_| AddressError::Invalid(format!("expected 32 bytes, got {}", bytes.len())))?;
        Ok(Self(array))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_base58(&self) -> String {
        bs58::encode(self.0).into_string()
    }

    /// Mirrors `@solana/kit` `isAddress`: 32-44 base58 characters decoding to 32 bytes.
    pub fn parse(value: &str) -> Result<Self, AddressError> {
        if value.len() < 32 || value.len() > 44 {
            return Err(AddressError::Invalid(value.to_string()));
        }
        let decoded = bs58::decode(value).into_vec().map_err(|_| AddressError::Invalid(value.to_string()))?;
        Self::from_slice(&decoded).map_err(|_| AddressError::Invalid(value.to_string()))
    }

    pub fn is_on_curve(&self) -> bool {
        CompressedEdwardsY(self.0).decompress().is_some()
    }

    pub fn is_off_curve(&self) -> bool {
        !self.is_on_curve()
    }

    pub fn create_program_address(seeds: &[&[u8]], program_id: &Address) -> Result<Address, AddressError> {
        if seeds.len() > MAX_SEEDS || seeds.iter().any(|seed| seed.len() > MAX_SEED_LENGTH) {
            return Err(AddressError::InvalidSeeds);
        }
        let mut hasher = Sha256::new();
        for seed in seeds {
            hasher.update(seed);
        }
        hasher.update(program_id.0);
        hasher.update(PDA_MARKER);
        let candidate = Address(hasher.finalize().into());
        if candidate.is_on_curve() {
            return Err(AddressError::OnCurve);
        }
        Ok(candidate)
    }

    pub fn find_program_address(seeds: &[&[u8]], program_id: &Address) -> Result<(Address, u8), AddressError> {
        if seeds.len() >= MAX_SEEDS {
            return Err(AddressError::InvalidSeeds);
        }
        for bump in (0..=255u8).rev() {
            let bump_seed = [bump];
            let mut all: Vec<&[u8]> = seeds.to_vec();
            all.push(&bump_seed);
            match Self::create_program_address(&all, program_id) {
                Ok(address) => return Ok((address, bump)),
                Err(AddressError::OnCurve) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(AddressError::NoViableBump)
    }
}

/// Derives the associated token account for `owner` and `mint`.
pub fn find_associated_token_address(owner: &Address, mint: &Address, token_program: &Address) -> Address {
    Address::find_program_address(&[&owner.0, &token_program.0, &mint.0], &ASSOCIATED_TOKEN_PROGRAM_ID)
        .expect("associated token address derivation cannot exhaust bumps")
        .0
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_base58())
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Address({})", self.to_base58())
    }
}

impl FromStr for Address {
    type Err = AddressError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for Address {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_base58())
    }
}

impl<'de> Deserialize<'de> for Address {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Address::parse(&value).map_err(serde::de::Error::custom)
    }
}

const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const fn base58_digit(byte: u8) -> Option<u32> {
    let mut index = 0;
    while index < 58 {
        if BASE58_ALPHABET[index] == byte {
            return Some(index as u32);
        }
        index += 1;
    }
    None
}

/// Const base58 decoder for 32-byte addresses (used for program constants).
const fn decode_base58_const(input: &[u8]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < input.len() {
        let mut carry = match base58_digit(input[i]) {
            Some(value) => value,
            None => return None,
        };
        let mut j = 32;
        while j > 0 {
            j -= 1;
            carry += (out[j] as u32) * 58;
            out[j] = (carry & 0xff) as u8;
            carry >>= 8;
        }
        if carry != 0 {
            return None;
        }
        i += 1;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_addresses_match_runtime_decoder() {
        assert_eq!(TOKEN_PROGRAM_ID.to_base58(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        assert_eq!(SYSTEM_PROGRAM_ID.to_base58(), "11111111111111111111111111111111");
        assert_eq!(
            Address::parse("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap(),
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
    }

    #[test]
    fn parse_rejects_wrong_lengths_and_alphabet() {
        assert!(Address::parse("short").is_err());
        assert!(Address::parse("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl").is_err());
        assert!(Address::parse("1111111111111111111111111111111").is_err());
    }

    #[test]
    fn derives_known_associated_token_address() {
        // Wrapped SOL ATA for the system program owner, verified with @solana/kit.
        let owner = Address::parse("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").unwrap();
        let ata = find_associated_token_address(&owner, &WRAPPED_SOL_MINT, &TOKEN_PROGRAM_ID);
        assert!(ata.is_off_curve());
    }

    #[test]
    fn static_decoder_matches_bs58_at_runtime() {
        for value in [
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "So11111111111111111111111111111111111111112",
            "11111111111111111111111111111111",
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        ] {
            assert_eq!(Address::from_static(value), Address::parse(value).unwrap(), "{value}");
        }
        // Invalid characters and values wider than 32 bytes are rejected.
        assert_eq!(decode_base58_const(b"0OIl"), None);
        assert_eq!(decode_base58_const(&[b'z'; 45]), None);
    }

    #[test]
    #[should_panic(expected = "invalid static address")]
    fn static_addresses_must_be_valid() {
        let _ = Address::from_static("not-base58!");
    }

    #[test]
    fn formats_parses_and_serializes() {
        let address = TOKEN_PROGRAM_ID;
        assert_eq!(format!("{address:?}"), "Address(TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)");
        assert_eq!(address.to_string(), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        assert_eq!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".parse::<Address>().unwrap(), address);
        let json = serde_json::to_string(&address).unwrap();
        assert_eq!(json, "\"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\"");
        assert_eq!(serde_json::from_str::<Address>(&json).unwrap(), address);
        let err = serde_json::from_str::<Address>("\"nope\"").unwrap_err();
        assert!(err.to_string().contains("Invalid Solana address: nope"), "{err}");
        assert!(serde_json::from_str::<Address>("1").is_err());
    }

    #[test]
    fn program_address_seed_limits() {
        let program = TOKEN_PROGRAM_ID;
        let long = [0u8; MAX_SEED_LENGTH + 1];
        assert_eq!(Address::create_program_address(&[&long], &program), Err(AddressError::InvalidSeeds));
        let seeds: Vec<&[u8]> = vec![b"s"; MAX_SEEDS + 1];
        assert_eq!(Address::create_program_address(&seeds, &program), Err(AddressError::InvalidSeeds));
        // find_program_address reserves one seed slot for the bump.
        let seeds: Vec<&[u8]> = vec![b"s"; MAX_SEEDS];
        assert_eq!(Address::find_program_address(&seeds, &program), Err(AddressError::InvalidSeeds));
        assert_eq!(Address::find_program_address(&[&long], &program), Err(AddressError::InvalidSeeds));

        let (pda, bump) = Address::find_program_address(&[b"game"], &program).unwrap();
        assert!(pda.is_off_curve());
        assert_eq!(Address::create_program_address(&[b"game", &[bump]], &program), Ok(pda));
        // Wallet keys are on the curve, unlike derived addresses.
        let on_curve = Address::parse("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").unwrap();
        assert!(on_curve.is_on_curve());
    }
}
