use anchor_lang::prelude::*;

pub const LEAGUE_SEED: &[u8] = b"league";
pub const ENTRY_SEED: &[u8] = b"entry";

pub const MAX_PLAYERS: u8 = 8;
pub const MAX_ROUNDS: u8 = 8;
pub const MAX_LEVERAGE: u8 = 5;
pub const MIN_ROUND_SECS: u32 = 30;
pub const MAX_ROUND_SECS: u32 = 2 * 60 * 60;

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
    /// Randomness requested, close time not yet known.
    AwaitingVrf = 1,
    /// Round live: positions can be set until the hidden close time.
    Live = 2,
    /// A round settled; another is waiting to be started.
    Between = 3,
    /// All rounds settled; league is committed and undelegated.
    Finished = 4,
}

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
    pub min_secs: u32,
    pub max_secs: u32,
    /// Pinned price feed account (MagicBlock pricing oracle PDA).
    pub feed: Pubkey,
    /// Hidden until settlement: unix time the round closes (set by the VRF callback).
    pub close_at: i64,
    pub round_started_at: i64,
    /// Latest VRF output, kept so a settlement can be audited against the VRF proof.
    pub randomness: [u8; 32],
    /// Price used to settle the most recent round, and its publish time.
    pub settle_price: i64,
    pub settle_time: i64,
    /// Set when the league finishes: highest rating (ties: lowest key).
    pub winner: Pubkey,
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
