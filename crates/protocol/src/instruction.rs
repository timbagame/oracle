use crate::Address;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountMeta {
    pub address: Address,
    pub signer: bool,
    pub writable: bool,
}

impl AccountMeta {
    pub const fn readonly(address: Address) -> Self {
        Self { address, signer: false, writable: false }
    }
    pub const fn writable(address: Address) -> Self {
        Self { address, signer: false, writable: true }
    }
    pub const fn readonly_signer(address: Address) -> Self {
        Self { address, signer: true, writable: false }
    }
    pub const fn writable_signer(address: Address) -> Self {
        Self { address, signer: true, writable: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instruction {
    pub program_id: Address,
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}
