use soroban_sdk::{symbol_short, Symbol};

/// Instance-storage key for the hot escrow state (`EscrowState`).
///
/// Every fund-moving entry point reads and writes exactly this entry, so it
/// deliberately holds only the fields those paths need.
pub const ESCROW: Symbol = symbol_short!("ESCROW");

/// Instance-storage key for the cold upgrade material (`EscrowAdmins`).
///
/// The admin signer list is an unbounded `Vec<Address>` that is only read by
/// `upgrade`. Keeping it in a separate entry means `release` / `refund` /
/// `self_refund` / `emergency_refund` never pay to serialise or deserialise
/// it on the hot path.
pub const ESCROW_ADMINS: Symbol = symbol_short!("ESC_ADM");

/// Instance-storage key for the reentrancy lock.
///
/// Set for the duration of an entry point that can move funds and cleared when
/// that entry point returns (see `ReentrancyGuard`), so a callback into the
/// contract — e.g. from the token it is transferring — cannot start a second
/// fund-moving call.
pub const REENTRANCY: Symbol = symbol_short!("REENTR");
