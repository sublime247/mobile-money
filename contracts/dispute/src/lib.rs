#![no_std]
//! Escrow dispute arbitration with on-chain evidence anchoring (issue #2423).
//!
//! Buyers, sellers and the mediator of a trade can anchor the hash of an
//! off-chain IPFS evidence document into the dispute record. Once written the
//! hash is immutable contract storage: arbitrators and observers can verify
//! that a document existed at a given point in the dispute without trusting
//! either counterparty to preserve it.

mod storage;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address,
    BytesN, Env, Symbol, Vec,
};

use storage::DISPUTE;

const EVIDENCE: Symbol = symbol_short!("EVIDENCE");

/// Maximum number of evidence hashes that may be anchored to one dispute.
pub const MAX_EVIDENCE_HASHES: u32 = 10;

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum DisputeError {
    /// A dispute with this trade id already exists.
    AlreadyExists = 1,
    /// No dispute with this trade id exists.
    NotFound = 2,
    /// Caller is neither buyer, seller nor mediator for this dispute.
    UnauthorizedSubmitter = 3,
    /// The dispute already holds the maximum number of evidence hashes.
    EvidenceLimitReached = 4,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Dispute {
    pub trade_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub mediator: Address,
    pub evidence_count: u32,
}

#[contractevent(topics = ["dispute", "evidence_anchored"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceAnchored {
    #[topic]
    pub trade_id: u64,
    pub submitter: Address,
    pub ipfs_hash: BytesN<32>,
}

#[contract]
pub struct DisputeContract;

#[contractimpl]
impl DisputeContract {
    /// Open a dispute for a trade. The buyer authorizes creation so a third
    /// party cannot open a dispute on someone else's behalf.
    pub fn open_dispute(
        env: Env,
        trade_id: u64,
        buyer: Address,
        seller: Address,
        mediator: Address,
    ) -> Result<(), DisputeError> {
        buyer.require_auth();

        let key = (DISPUTE, trade_id);
        if env.storage().instance().has(&key) {
            return Err(DisputeError::AlreadyExists);
        }

        env.storage().instance().set(
            &key,
            &Dispute {
                trade_id,
                buyer,
                seller,
                mediator,
                evidence_count: 0,
            },
        );
        env.storage()
            .instance()
            .set(&(EVIDENCE, trade_id), &Vec::<BytesN<32>>::new(&env));
        env.storage().instance().extend_ttl(1000, 10000);
        Ok(())
    }

    /// Anchor an IPFS evidence hash. Only the dispute's buyer, seller or
    /// mediator may submit, and at most [`MAX_EVIDENCE_HASHES`] hashes are
    /// kept per dispute.
    pub fn submit_evidence_hash(
        env: Env,
        trade_id: u64,
        submitter: Address,
        ipfs_hash: BytesN<32>,
    ) -> Result<(), DisputeError> {
        let mut dispute: Dispute = env
            .storage()
            .instance()
            .get(&(DISPUTE, trade_id))
            .ok_or(DisputeError::NotFound)?;

        if submitter != dispute.buyer
            && submitter != dispute.seller
            && submitter != dispute.mediator
        {
            return Err(DisputeError::UnauthorizedSubmitter);
        }
        submitter.require_auth();

        let mut evidence: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&(EVIDENCE, trade_id))
            .unwrap_or_else(|| Vec::new(&env));
        if evidence.len() >= MAX_EVIDENCE_HASHES {
            return Err(DisputeError::EvidenceLimitReached);
        }

        evidence.push_back(ipfs_hash.clone());
        env.storage()
            .instance()
            .set(&(EVIDENCE, trade_id), &evidence);
        dispute.evidence_count = evidence.len();
        env.storage().instance().set(&(DISPUTE, trade_id), &dispute);
        env.storage().instance().extend_ttl(1000, 10000);

        EvidenceAnchored {
            trade_id,
            submitter,
            ipfs_hash,
        }
        .publish(&env);

        Ok(())
    }

    /// All evidence hashes anchored for a dispute, in submission order.
    pub fn get_evidence_hashes(env: Env, trade_id: u64) -> Result<Vec<BytesN<32>>, DisputeError> {
        env.storage()
            .instance()
            .get(&(EVIDENCE, trade_id))
            .ok_or(DisputeError::NotFound)
    }

    /// Dispute metadata including the current evidence count.
    pub fn get_dispute(env: Env, trade_id: u64) -> Result<Dispute, DisputeError> {
        env.storage()
            .instance()
            .get(&(DISPUTE, trade_id))
            .ok_or(DisputeError::NotFound)
    }
}
