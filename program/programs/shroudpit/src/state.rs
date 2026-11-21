use anchor_lang::prelude::*;

pub const LEAGUE_SEED: &[u8] = b"league";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const SECRET_SEED: &[u8] = b"secret";

pub const MAX_PLAYERS: u8 = 8;
pub const MAX_ROUNDS: u8 = 8;
pub const MAX_LEVERAGE: u8 = 5;
pub const MIN_ROUND_SECS: u32 = 30;
pub const MAX_ROUND_SECS: u32 = 2 * 60 * 60;

/// Players have this long to commit their private nonce after a round is opened.
pub const NONCE_WINDOW_SECS: i64 = 45;
/// At least this many nonces must be committed before the close time can be derived.
pub const MIN_NONCES: u8 = 2;
/// With VRF mixing enabled, lock-in waits this long for the VRF output before deriving the
/// close time from the nonces and slot alone.
pub const VRF_WAIT_SECS: i64 = 20;

/// Price must be at most this old (seconds) when a position is set.
pub const MAX_PRICE_AGE_SECS: i64 = 5;
/// The settlement price must be published within this many seconds after the close.
/// Bounds how far a cranker can slide the settlement moment.
pub const SETTLE_WINDOW_SECS: i64 = 30;

/// The TEE validator of the Private Ephemeral Rollup (devnet). Entries must only ever be
/// delegated here so positions stay inside the enclave.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Accepting players (base layer).
    Open = 0,
    /// VRF requested, close time not yet derived.
    AwaitingVrf = 1,
    /// Round live: positions can be set until the hidden close time.
    Live = 2,
    /// A round settled; another is waiting to be started.
    Between = 3,
    /// All rounds settled; league is committed and undelegated.
    Finished = 4,
    /// Round opened: players are committing their private nonces.
    Nonces = 5,
}

/// How the hidden close time is derived. The nonce-and-slot path always applies; VRF output is
/// mixed in on top only when it is requested and arrives in time.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CloseMode {
    NoncesAndSlot = 0,
    NoncesSlotAndVrf = 1,
}

/// Publicly readable inside the TEE so clients can follow the phase. Everything that would
/// reveal the close time lives in `Secret`.
#[account]
#[derive(InitSpace)]
pub struct League {
    pub creator: Pubkey,
    pub id: u64,
    pub status: u8,
    pub n_rounds: u8,
    /// Index of the current / next round.
    pub round: u8,
    pub player_count: u8,
    pub max_players: u8,
    pub bump: u8,
    pub close_mode: u8,
    pub min_secs: u32,
    pub max_secs: u32,
    /// Pinned price feed account (MagicBlock pricing oracle PDA).
    pub feed: Pubkey,
    /// Incremented every time a nonce phase opens, so stale nonces can never be reused.
    pub epoch: u16,
    pub nonce_deadline: i64,
    pub nonce_count: u8,
    pub vrf_deadline: i64,
    pub round_started_at: i64,
    /// Price used to settle the most recent round, and its publish time.
    pub settle_price: i64,
    pub settle_time: i64,
    /// Set when the league finishes: highest rating (ties: lowest key).
    pub winner: Pubkey,
}

/// Private (no members) while the round is live; revealed when committed at settlement so the
/// derivation of the close time can be audited.
#[account]
#[derive(InitSpace)]
pub struct Secret {
    pub league: Pubkey,
    pub bump: u8,
    pub vrf_used: bool,
    /// Unix time the round closes.
    pub close_at: i64,
    /// Slot recorded at lock-in.
    pub lock_slot: u64,
    /// sha256 over the league, epoch, lock slot and every committed (player, nonce).
    pub base_seed: [u8; 32],
    /// VRF output, when it was mixed in.
    pub randomness: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub league: Pubkey,
    pub player: Pubkey,
    pub bump: u8,
    /// Round this position belongs to; a mismatch means the position is stale and is reset.
    pub round: u8,
    // ---- hidden while the round is live ----
    /// Private nonce committed for the current epoch. Immutable once committed.
    pub nonce: [u8; 32],
    pub nonce_epoch: u16,
    /// -1 short, 0 flat, 1 long.
    pub side: i8,
    pub leverage: u8,
    pub entry_price: i64,
    /// Realised return this round in basis points (marked at each adjustment).
    pub ret_bps: i64,
    // ---- record, revealed at settlement ----
    pub rounds_scored: u8,
    pub sum_ret_bps: i64,
    pub sum_sq_ret_bps: i64,
    pub last_ret_bps: i64,
    pub rating: i64,
}
