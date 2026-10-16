//! Little-endian fixed-size readers shared by the account and event codecs.

use crate::Address;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct DecodeError(pub String);

impl DecodeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Cursor over a byte slice. Every read fails instead of panicking when the
/// buffer is too short, matching the kit codecs which throw on short input.
pub struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.offset)
    }

    pub fn bytes(&mut self, len: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.offset.checked_add(len).filter(|end| *end <= self.data.len()).ok_or_else(|| {
            DecodeError::new(format!("Codec [decode] expected {len} bytes, got {}", self.remaining()))
        })?;
        let slice = &self.data[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    pub fn array<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.bytes(N)?);
        Ok(out)
    }

    pub fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.bytes(1)?[0])
    }

    pub fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    pub fn u64(&mut self) -> Result<u64, DecodeError> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    /// Kit boolean decoder semantics: only `1` is true.
    pub fn bool(&mut self) -> Result<bool, DecodeError> {
        Ok(self.u8()? == 1)
    }

    pub fn address(&mut self) -> Result<Address, DecodeError> {
        Ok(Address(self.array()?))
    }
}
