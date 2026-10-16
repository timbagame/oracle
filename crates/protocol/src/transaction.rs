//! Legacy Solana transaction wire codec with `@solana/kit` compatible
//! compilation (account ordering, role merging and signature maps).

use std::cmp::Ordering;
use std::collections::HashSet;

use base64::Engine;

use crate::codec::DecodeError;
use crate::instruction::{AccountMeta, Instruction};
use crate::Address;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MessageHeader {
    pub num_required_signatures: u8,
    pub num_readonly_signed_accounts: u8,
    pub num_readonly_unsigned_accounts: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledInstruction {
    pub program_id_index: u8,
    pub account_indices: Vec<u8>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyMessage {
    pub header: MessageHeader,
    pub account_keys: Vec<Address>,
    pub recent_blockhash: Address,
    pub instructions: Vec<CompiledInstruction>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransactionError {
    #[error("{0}")]
    Decode(#[from] DecodeError),
    #[error("Unsupported transaction version: {0}")]
    UnsupportedVersion(u8),
    #[error("Transaction signatures do not match the message signers")]
    SignatureMismatch,
    #[error("Invoked programs cannot pay fees")]
    ProgramPaysFees,
    #[error("Invoked programs must not be writable")]
    ProgramWritable,
    #[error("Transaction has too many accounts")]
    TooManyAccounts,
    #[error("Address {0} cannot sign this transaction")]
    CannotSign(Address),
    #[error("Invalid base64 transaction")]
    InvalidBase64,
}

// ---------------------------------------------------------------------------
// shortvec
// ---------------------------------------------------------------------------

pub fn encode_short_u16(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
            out.push(byte);
        } else {
            out.push(byte);
            break;
        }
    }
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], DecodeError> {
        if self.pos + len > self.data.len() {
            return Err(DecodeError::new("Unexpected end of transaction data"));
        }
        let out = &self.data[self.pos..self.pos + len];
        self.pos += len;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    fn short_u16(&mut self) -> Result<usize, DecodeError> {
        let mut value = 0usize;
        for i in 0..3 {
            let byte = self.u8()?;
            value |= ((byte & 0x7f) as usize) << (7 * i);
            if byte & 0x80 == 0 {
                if value > u16::MAX as usize {
                    return Err(DecodeError::new("Invalid shortvec length"));
                }
                return Ok(value);
            }
        }
        Err(DecodeError::new("Invalid shortvec length"))
    }

    fn address(&mut self) -> Result<Address, DecodeError> {
        Ok(Address::from_slice(self.take(32)?).expect("32 bytes"))
    }
}

// ---------------------------------------------------------------------------
// Address ordering (Intl.Collator('en', { caseFirst: 'lower', sensitivity: 'variant' }))
// ---------------------------------------------------------------------------

fn primary_weight(byte: u8) -> (u8, u8) {
    match byte {
        b'0'..=b'9' => (1, byte),
        b'a'..=b'z' => (2, byte),
        b'A'..=b'Z' => (2, byte.to_ascii_lowercase()),
        other => (0, other),
    }
}

/// Kit's address comparator for base58 strings: digits before letters,
/// letters case-insensitive at the primary level, lowercase first on ties.
pub fn compare_addresses(left: &str, right: &str) -> Ordering {
    let l = left.as_bytes();
    let r = right.as_bytes();
    let primary = l.iter().map(|b| primary_weight(*b)).cmp(r.iter().map(|b| primary_weight(*b)));
    if primary != Ordering::Equal {
        return primary;
    }
    let tertiary = |b: &u8| if b.is_ascii_uppercase() { 1u8 } else { 0u8 };
    l.iter().map(tertiary).cmp(r.iter().map(tertiary))
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    FeePayer,
    Static,
}

#[derive(Clone, Copy)]
struct Entry {
    address: Address,
    kind: EntryKind,
    signer: bool,
    writable: bool,
}

impl LegacyMessage {
    /// Mirrors kit `compileTransactionMessage` for legacy messages.
    pub fn compile(
        fee_payer: &Address,
        recent_blockhash: &Address,
        instructions: &[Instruction],
    ) -> Result<Self, TransactionError> {
        let mut entries: Vec<Entry> =
            vec![Entry { address: *fee_payer, kind: EntryKind::FeePayer, signer: true, writable: true }];
        let mut invoked: HashSet<Address> = HashSet::new();
        let position = |entries: &Vec<Entry>, address: &Address| entries.iter().position(|e| &e.address == address);

        for instruction in instructions {
            invoked.insert(instruction.program_id);
            match position(&entries, &instruction.program_id) {
                Some(index) => {
                    let entry = entries[index];
                    if entry.writable {
                        return Err(match entry.kind {
                            EntryKind::FeePayer => TransactionError::ProgramPaysFees,
                            EntryKind::Static => TransactionError::ProgramWritable,
                        });
                    }
                }
                None => entries.push(Entry {
                    address: instruction.program_id,
                    kind: EntryKind::Static,
                    signer: false,
                    writable: false,
                }),
            }
            for meta in &instruction.accounts {
                match position(&entries, &meta.address) {
                    Some(index) => {
                        let entry = &mut entries[index];
                        if entry.kind == EntryKind::FeePayer {
                            continue;
                        }
                        if invoked.contains(&meta.address) && meta.writable {
                            return Err(TransactionError::ProgramWritable);
                        }
                        entry.signer |= meta.signer;
                        entry.writable |= meta.writable;
                    }
                    None => entries.push(Entry {
                        address: meta.address,
                        kind: EntryKind::Static,
                        signer: meta.signer,
                        writable: meta.writable,
                    }),
                }
            }
        }

        let mut keyed: Vec<(String, Entry)> = entries.into_iter().map(|e| (e.address.to_base58(), e)).collect();
        keyed.sort_by(|(la, le), (ra, re)| {
            if le.kind != re.kind {
                return if le.kind == EntryKind::FeePayer { Ordering::Less } else { Ordering::Greater };
            }
            if le.signer != re.signer {
                return if le.signer { Ordering::Less } else { Ordering::Greater };
            }
            if le.writable != re.writable {
                return if le.writable { Ordering::Less } else { Ordering::Greater };
            }
            compare_addresses(la, ra)
        });
        if keyed.len() > 256 {
            return Err(TransactionError::TooManyAccounts);
        }

        let mut header = MessageHeader::default();
        for (_, e) in &keyed {
            if e.signer {
                header.num_required_signatures += 1;
                if !e.writable {
                    header.num_readonly_signed_accounts += 1;
                }
            } else if !e.writable {
                header.num_readonly_unsigned_accounts += 1;
            }
        }
        let account_keys: Vec<Address> = keyed.iter().map(|(_, e)| e.address).collect();
        let index_of = |address: &Address| account_keys.iter().position(|a| a == address).expect("indexed") as u8;
        let compiled = instructions
            .iter()
            .map(|ix| CompiledInstruction {
                program_id_index: index_of(&ix.program_id),
                account_indices: ix.accounts.iter().map(|m| index_of(&m.address)).collect(),
                data: ix.data.clone(),
            })
            .collect();
        Ok(Self { header, account_keys, recent_blockhash: *recent_blockhash, instructions: compiled })
    }

    pub fn is_signer(&self, index: usize) -> bool {
        index < self.header.num_required_signatures as usize
    }

    pub fn is_writable(&self, index: usize) -> bool {
        let signers = self.header.num_required_signatures as usize;
        if index < signers {
            index < signers - self.header.num_readonly_signed_accounts as usize
        } else {
            index < self.account_keys.len().saturating_sub(self.header.num_readonly_unsigned_accounts as usize)
        }
    }

    pub fn fee_payer(&self) -> Option<&Address> {
        self.account_keys.first()
    }

    /// Mirrors kit `decompileTransactionMessage` for static accounts.
    pub fn decompile(&self) -> Result<Vec<Instruction>, DecodeError> {
        let key = |index: u8| {
            self.account_keys
                .get(index as usize)
                .copied()
                .ok_or_else(|| DecodeError::new("Instruction references a missing account"))
        };
        self.instructions
            .iter()
            .map(|ix| {
                Ok(Instruction {
                    program_id: key(ix.program_id_index)?,
                    accounts: ix
                        .account_indices
                        .iter()
                        .map(|&i| {
                            Ok(AccountMeta {
                                address: key(i)?,
                                signer: self.is_signer(i as usize),
                                writable: self.is_writable(i as usize),
                            })
                        })
                        .collect::<Result<_, DecodeError>>()?,
                    data: ix.data.clone(),
                })
            })
            .collect()
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut out = vec![
            self.header.num_required_signatures,
            self.header.num_readonly_signed_accounts,
            self.header.num_readonly_unsigned_accounts,
        ];
        encode_short_u16(&mut out, self.account_keys.len());
        for key in &self.account_keys {
            out.extend_from_slice(&key.0);
        }
        out.extend_from_slice(&self.recent_blockhash.0);
        encode_short_u16(&mut out, self.instructions.len());
        for ix in &self.instructions {
            out.push(ix.program_id_index);
            encode_short_u16(&mut out, ix.account_indices.len());
            out.extend_from_slice(&ix.account_indices);
            encode_short_u16(&mut out, ix.data.len());
            out.extend_from_slice(&ix.data);
        }
        out
    }

    /// Decodes a legacy message; versioned messages are rejected. Trailing
    /// bytes are ignored like the kit decoder.
    pub fn deserialize(bytes: &[u8]) -> Result<Self, TransactionError> {
        let mut c = Cursor { data: bytes, pos: 0 };
        let first = *bytes.first().ok_or_else(|| DecodeError::new("Empty message"))?;
        if first & 0x80 != 0 {
            return Err(TransactionError::UnsupportedVersion(first & 0x7f));
        }
        let header = MessageHeader {
            num_required_signatures: c.u8()?,
            num_readonly_signed_accounts: c.u8()?,
            num_readonly_unsigned_accounts: c.u8()?,
        };
        let key_count = c.short_u16()?;
        let account_keys = (0..key_count).map(|_| c.address()).collect::<Result<Vec<_>, _>>()?;
        let recent_blockhash = c.address()?;
        let ix_count = c.short_u16()?;
        let mut instructions = Vec::with_capacity(ix_count.min(64));
        for _ in 0..ix_count {
            let program_id_index = c.u8()?;
            let n = c.short_u16()?;
            let account_indices = c.take(n)?.to_vec();
            let n = c.short_u16()?;
            let data = c.take(n)?.to_vec();
            instructions.push(CompiledInstruction { program_id_index, account_indices, data });
        }
        Ok(Self { header, account_keys, recent_blockhash, instructions })
    }
}

/// Signer addresses (in message order) and their optional signatures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    pub message_bytes: Vec<u8>,
    pub signatures: Vec<(Address, Option<[u8; 64]>)>,
}

impl Transaction {
    pub fn from_message(message: &LegacyMessage) -> Self {
        let signers = message.account_keys[..message.header.num_required_signatures as usize]
            .iter()
            .map(|a| (*a, None))
            .collect();
        Self { message_bytes: message.serialize(), signatures: signers }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, TransactionError> {
        let mut c = Cursor { data: bytes, pos: 0 };
        let count = c.short_u16()?;
        let raw: Vec<[u8; 64]> =
            (0..count).map(|_| c.take(64).map(|s| s.try_into().expect("64"))).collect::<Result<_, _>>()?;
        let message_bytes = bytes[c.pos..].to_vec();
        // Signer addresses come from the static account prefix of either message version.
        let mut m = Cursor { data: &message_bytes, pos: 0 };
        let first = m.u8()?;
        let num_required = if first & 0x80 != 0 { m.u8()? } else { first };
        m.take(2)?;
        let key_count = m.short_u16()?;
        let keys = (0..key_count).map(|_| m.address()).collect::<Result<Vec<_>, _>>()?;
        let signers: Vec<Address> = keys.into_iter().take(num_required as usize).collect();
        if signers.len() != raw.len() {
            return Err(TransactionError::SignatureMismatch);
        }
        let signatures = signers
            .into_iter()
            .zip(raw)
            .map(|(address, sig)| (address, if sig.iter().all(|b| *b == 0) { None } else { Some(sig) }))
            .collect();
        Ok(Self { message_bytes, signatures })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + self.signatures.len() * 64 + self.message_bytes.len());
        encode_short_u16(&mut out, self.signatures.len());
        for (_, sig) in &self.signatures {
            out.extend_from_slice(&sig.unwrap_or([0; 64]));
        }
        out.extend_from_slice(&self.message_bytes);
        out
    }

    pub fn from_base64(value: &str) -> Result<Self, TransactionError> {
        let bytes =
            base64::engine::general_purpose::STANDARD.decode(value).map_err(|_| TransactionError::InvalidBase64)?;
        Self::decode(&bytes)
    }

    pub fn to_base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.encode())
    }

    pub fn signature_of(&self, address: &Address) -> Option<&[u8; 64]> {
        self.signatures.iter().find(|(a, _)| a == address).and_then(|(_, s)| s.as_ref())
    }

    pub fn set_signature(&mut self, address: &Address, signature: [u8; 64]) -> Result<(), TransactionError> {
        let slot =
            self.signatures.iter_mut().find(|(a, _)| a == address).ok_or(TransactionError::CannotSign(*address))?;
        slot.1 = Some(signature);
        Ok(())
    }

    pub fn is_fully_signed(&self) -> bool {
        self.signatures.iter().all(|(_, s)| s.is_some())
    }

    /// The transaction id: the fee payer's signature in base58.
    pub fn signature_base58(&self) -> Option<String> {
        self.signatures.first().and_then(|(_, s)| s.map(|s| bs58::encode(s).into_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::address::{SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID};

    #[test]
    fn collator_order() {
        let mut v = vec!["b", "B", "a", "A", "1", "9", "Ab", "aB", "ab"];
        v.sort_by(|a, b| compare_addresses(a, b));
        assert_eq!(v, vec!["1", "9", "a", "A", "ab", "aB", "Ab", "b", "B"]);
    }

    #[test]
    fn compile_orders_accounts_like_kit() {
        let payer = Address([9; 32]);
        let signer = Address([1; 32]);
        let writable = Address([2; 32]);
        let ix = Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMeta::readonly(SYSTEM_PROGRAM_ID),
                AccountMeta::writable(writable),
                AccountMeta::readonly_signer(signer),
                AccountMeta::readonly(writable),
            ],
            data: vec![1, 2, 3],
        };
        let message = LegacyMessage::compile(&payer, &Address([7; 32]), std::slice::from_ref(&ix)).unwrap();
        assert_eq!(message.account_keys, vec![payer, signer, writable, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID]);
        assert_eq!(
            message.header,
            MessageHeader {
                num_required_signatures: 2,
                num_readonly_signed_accounts: 1,
                num_readonly_unsigned_accounts: 2
            }
        );
        let bytes = message.serialize();
        assert_eq!(LegacyMessage::deserialize(&bytes).unwrap(), message);
        let decompiled = message.decompile().unwrap();
        assert_eq!(decompiled[0].accounts[1], AccountMeta::writable(writable));
        assert_eq!(decompiled[0].accounts[3], AccountMeta::writable(writable));

        let tx = Transaction::from_message(&message);
        assert_eq!(tx.signatures.len(), 2);
        let decoded = Transaction::decode(&tx.encode()).unwrap();
        assert_eq!(decoded, tx);
        let mut bad = tx.encode();
        bad[0] = 1;
        assert!(Transaction::decode(&bad).is_err());
    }

    #[test]
    fn program_cannot_be_writable() {
        let payer = Address([9; 32]);
        let ix = Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![AccountMeta::writable(TOKEN_PROGRAM_ID)],
            data: vec![],
        };
        assert_eq!(
            LegacyMessage::compile(&payer, &Address([7; 32]), &[ix]).unwrap_err(),
            TransactionError::ProgramWritable
        );
        let ix = Instruction { program_id: payer, accounts: vec![], data: vec![] };
        assert_eq!(
            LegacyMessage::compile(&payer, &Address([7; 32]), &[ix]).unwrap_err(),
            TransactionError::ProgramPaysFees
        );
    }

    #[test]
    fn rejects_versioned_messages() {
        assert_eq!(LegacyMessage::deserialize(&[0x80, 1, 0, 0]).unwrap_err(), TransactionError::UnsupportedVersion(0));
    }
}
