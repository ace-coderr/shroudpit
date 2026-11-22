use anchor_lang::prelude::*;

pub const LEAGUE_SEED: &[u8] = b"league";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const SECRET_SEED: &[u8] = b"secret";
pub const CARD_SEED: &[u8] = b"card";
pub const TROPHY_SEED: &[u8] = b"trophy";

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
/// Bounds how far a settler can slide the settlement moment.
pub const SETTLE_WINDOW_SECS: i64 = 60;

/// Entries revealed per transaction. The validator rejects a commit bundle whose data totals more
/// than about 2.7 KB (measured on devnet: 3 entries plus the secret pass, 8 entries fail), and an
/// entry is about 540 bytes, so reveal at most 4 at a time.
pub const REVEAL_CHUNK: usize = 4;

/// The TEE validator of the Private Ephemeral Rollup (devnet). Entries must only ever be
/// delegated here so positions stay inside the enclave.
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// PDA ["magic-fee-vault", TEE_VALIDATOR] under the delegation program. The commit intent needs it
/// when the payer is a delegated account, which the league PDA is.
pub const MAGIC_FEE_VAULT: Pubkey = pubkey!("EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b");

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
    /// Final round settled; entries are being revealed in chunks, then the league is finished.
    Finishing = 6,
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
    /// Entries committed and undelegated so far during the final reveal.
    pub revealed_count: u8,
}

/// Everything that fixes one round's close time. Kept for every round so each can be audited after
/// the league ends.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct RoundSecret {
    pub epoch: u16,
    pub started_at: i64,
    /// Unix time the round closes.
    pub close_at: i64,
    /// Slot recorded at lock-in.
    pub lock_slot: u64,
    /// sha256 over the league, epoch, lock slot and every committed (player, nonce).
    pub base_seed: [u8; 32],
    /// VRF output, when it was mixed in.
    pub randomness: [u8; 32],
    pub vrf_used: bool,
}

/// Private (no members) for the whole league. Committed to the base layer only when the final
/// round settles, so no close time or seed is public before then.
#[account]
#[derive(InitSpace)]
pub struct Secret {
    pub league: Pubkey,
    pub bump: u8,
    /// The round in progress.
    pub current: RoundSecret,
    /// Finished rounds, by round index.
    pub history: [RoundSecret; MAX_ROUNDS as usize],
}

/// One player's closing position and nonce for a finished round.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct RoundPos {
    pub nonce: [u8; 32],
    /// The nonce was committed for this round's epoch.
    pub committed: bool,
    /// False when the round was voided.
    pub scored: bool,
    pub side: i8,
    pub leverage: u8,
    pub entry_price: i64,
    /// Return for the round in basis points.
    pub ret_bps: i64,
}

/// Private to its owner for the whole league. Committed to the base layer only when the final
/// round settles, so no position is public before the league is over.
#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub league: Pubkey,
    pub player: Pubkey,
    pub bump: u8,
    /// Round the live fields below belong to; a mismatch means they are stale and are reset.
    pub round: u8,
    /// Private nonce committed for the current epoch. Immutable once committed.
    pub nonce: [u8; 32],
    pub nonce_epoch: u16,
    /// -1 short, 0 flat, 1 long.
    pub side: i8,
    pub leverage: u8,
    pub entry_price: i64,
    /// Realised return this round in basis points (marked at each adjustment).
    pub ret_bps: i64,
    /// Closing position and nonce of every finished round.
    pub history: [RoundPos; MAX_ROUNDS as usize],
    /// Set when this entry is committed during the final reveal.
    pub revealed: bool,
}

/// Public score card, committed after every round. Holds scores only: no position, no nonce.
#[account]
#[derive(InitSpace)]
pub struct Card {
    pub league: Pubkey,
    pub player: Pubkey,
    pub bump: u8,
    pub rounds_scored: u8,
    pub sum_ret_bps: i64,
    pub sum_sq_ret_bps: i64,
    pub last_ret_bps: i64,
    pub rating: i64,
}
