//! Contract-compatible winner selection (`sha256-slot-le-u64-v1`).

use sha2::{Digest, Sha256};

pub const SOLANA_RANDOMNESS_VERSION: &str = "sha256-slot-le-u64-v1";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct RandomnessError(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinnerSelection {
    pub random_value: u64,
    pub winner_index: u32,
}

/// Contract rejection sampling over overlapping little-endian u64 windows.
pub fn select_winner_from_entropy(entropy: &[u8], tickets: u64) -> Result<WinnerSelection, RandomnessError> {
    if entropy.len() != 32 {
        return Err(RandomnessError("Entropy must contain 32 bytes".into()));
    }
    if !(1..=0xffff_ffff).contains(&tickets) {
        return Err(RandomnessError("Ticket count must be a positive u32".into()));
    }
    let read = |start: usize| u64::from_le_bytes(entropy[start..start + 8].try_into().expect("8 bytes"));
    if tickets == 1 {
        return Ok(WinnerSelection { random_value: read(0), winner_index: 0 });
    }
    let max_valid = u64::MAX - (u64::MAX % tickets);
    for start in 0..=entropy.len() - 8 {
        let random_value = read(start);
        if random_value < max_valid {
            return Ok(WinnerSelection { random_value, winner_index: (random_value % tickets) as u32 });
        }
    }
    Err(RandomnessError("Unable to generate unbiased random number - game must be cancelled".into()))
}

pub fn create_winner_seed(secret: &[u8], last_slot: u64) -> Result<[u8; 40], RandomnessError> {
    if secret.len() != 32 {
        return Err(RandomnessError("Secret must contain 32 bytes".into()));
    }
    let mut seed = [0u8; 40];
    seed[..32].copy_from_slice(secret);
    seed[32..].copy_from_slice(&last_slot.to_le_bytes());
    Ok(seed)
}

pub fn calculate_winner(secret: &[u8], last_slot: u64, tickets: u64) -> Result<WinnerSelection, RandomnessError> {
    let seed = create_winner_seed(secret, last_slot)?;
    let entropy = Sha256::digest(seed);
    select_winner_from_entropy(&entropy, tickets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_ticket_wins() {
        let s = select_winner_from_entropy(&[0xff; 32], 1).unwrap();
        assert_eq!(s.winner_index, 0);
        assert_eq!(s.random_value, u64::MAX);
    }

    #[test]
    fn rejects_biased_windows() {
        // All windows equal u64::MAX, which is never below maxValid for 3 tickets.
        assert!(select_winner_from_entropy(&[0xff; 32], 3).is_err());
        let mut entropy = [0xff; 32];
        entropy[31] = 0;
        // Window 24 = 0x00ffffffffffffff.
        let s = select_winner_from_entropy(&entropy, 3).unwrap();
        assert_eq!(s.random_value, 0x00ff_ffff_ffff_ffff);
        assert_eq!(s.winner_index, (0x00ff_ffff_ffff_ffffu64 % 3) as u32);
    }

    #[test]
    fn validates_inputs() {
        assert!(select_winner_from_entropy(&[0; 31], 2).is_err());
        assert!(select_winner_from_entropy(&[0; 32], 0).is_err());
        assert!(select_winner_from_entropy(&[0; 32], 1 << 32).is_err());
        assert!(create_winner_seed(&[0; 31], 0).is_err());
    }

    #[test]
    fn matches_typescript_known_answers() {
        // Generated with @timbagame/protocol 0.14.2 `calculateWinner`; the first row is the
        // vector the TypeScript oracle suite pinned (tests/oracle-service.test.ts).
        let cases: [(u8, u64, u64, u32, u64); 7] = [
            (1, 123_456, 100, 2, 14_809_389_532_232_907_002),
            (1, 123_456, 1, 0, 14_809_389_532_232_907_002),
            (7, 12_345, 10, 1, 1_428_052_397_348_301_901),
            (0, 0, 2, 0, 10_125_002_298_327_184_428),
            (255, u64::MAX, 4_294_967_295, 3_496_189_253, 14_218_936_971_049_291_118),
            (42, 987_654_321, 3, 0, 14_221_578_400_757_830_401),
            (3, 1, 7, 2, 3_093_185_059_403_452_673),
        ];
        for (byte, slot, tickets, winner_index, random_value) in cases {
            let selection = calculate_winner(&[byte; 32], slot, tickets).unwrap();
            assert_eq!(
                (selection.winner_index, selection.random_value),
                (winner_index, random_value),
                "secret {byte:#04x}, slot {slot}, tickets {tickets}"
            );
        }
    }

    proptest::proptest! {
        #[test]
        fn winner_is_always_in_bounds(secret in proptest::array::uniform32(proptest::num::u8::ANY), slot in proptest::num::u64::ANY, tickets in 1u64..=u32::MAX as u64) {
            if let Ok(selection) = calculate_winner(&secret, slot, tickets) {
                proptest::prop_assert!(u64::from(selection.winner_index) < tickets);
            }
        }
    }

    #[test]
    fn calculate_is_deterministic() {
        let a = calculate_winner(&[7; 32], 12345, 10).unwrap();
        let b = calculate_winner(&[7; 32], 12345, 10).unwrap();
        assert_eq!(a, b);
        assert!(a.winner_index < 10);
    }
}
