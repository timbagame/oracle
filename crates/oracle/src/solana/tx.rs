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

#[cfg(test)]
mod tests {
    use super::*;
    use timba_protocol::AccountMeta;

    fn instruction(signers: &[Address]) -> Instruction {
        Instruction {
            program_id: Address([7; 32]),
            accounts: signers.iter().map(|s| AccountMeta::writable_signer(*s)).collect(),
            data: vec![1, 2, 3],
        }
    }

    #[test]
    fn signs_with_the_fee_payer_and_extra_signers() {
        let payer = Keypair::generate();
        let extra = Keypair::generate();
        let blockhash = Address([9; 32]);
        let (transaction, wire) =
            sign_legacy_transaction(&payer, &[&extra], &blockhash, &[instruction(&[extra.address()])]).unwrap();
        assert!(transaction.is_fully_signed());
        assert_eq!(transaction.signatures[0].0, payer.address(), "the fee payer signs first");
        assert_eq!(transaction.signatures.len(), 2);
        assert_eq!(Transaction::from_base64(&wire).unwrap(), transaction);
        let payer_signature = transaction.signature_of(&payer.address()).unwrap();
        assert_eq!(*payer_signature, payer.sign(&transaction.message_bytes));
    }

    #[test]
    fn reports_missing_and_foreign_signers() {
        let payer = Keypair::generate();
        let missing = Keypair::generate();
        let err =
            sign_legacy_transaction(&payer, &[], &Address([9; 32]), &[instruction(&[missing.address()])]).unwrap_err();
        assert_eq!(err.to_string(), "Transaction is missing required signatures");

        let stranger = Keypair::generate();
        let err = sign_legacy_transaction(&payer, &[&stranger], &Address([9; 32]), &[instruction(&[])]).unwrap_err();
        assert!(err.to_string().starts_with("Failed to sign transaction:"), "{err}");
    }
}
