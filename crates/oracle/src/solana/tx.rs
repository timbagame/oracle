//! Legacy transaction compilation and signing for operator-paid transactions.

use base64::Engine;
use timba_protocol::transaction::{LegacyMessage, Transaction};
use timba_protocol::{Address, Instruction};

use super::keypair::Keypair;

/// Compiles a legacy message paid by `fee_payer`, signs it with every provided
/// keypair and returns the base64 wire transaction.
pub fn sign_legacy_transaction(
    fee_payer: &Keypair,
    extra_signers: &[&Keypair],
    blockhash: &Address,
    instructions: &[Instruction],
) -> anyhow::Result<(Transaction, String)> {
    let message = LegacyMessage::compile(&fee_payer.address(), blockhash, instructions)
        .map_err(|error| anyhow::anyhow!("Failed to compile transaction: {error}"))?;
    let mut transaction = Transaction::from_message(&message);
    for signer in std::iter::once(fee_payer).chain(extra_signers.iter().copied()) {
        let signature = signer.sign(&transaction.message_bytes);
        transaction
            .set_signature(&signer.address(), signature)
            .map_err(|error| anyhow::anyhow!("Failed to sign transaction: {error}"))?;
    }
    if !transaction.is_fully_signed() {
        anyhow::bail!("Transaction is missing required signatures");
    }
    let wire = base64::engine::general_purpose::STANDARD.encode(transaction.encode());
    Ok((transaction, wire))
}
