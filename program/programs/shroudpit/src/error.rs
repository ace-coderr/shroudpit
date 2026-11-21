use anchor_lang::prelude::*;

#[error_code]
pub enum ShroudError {
    #[msg("invalid league parameters")]
    InvalidParams,
    #[msg("league is not in the required state")]
    WrongStatus,
    #[msg("league is full")]
    LeagueFull,
    #[msg("only the league creator can do this")]
    NotCreator,
    #[msg("validator must be the TEE validator")]
    WrongValidator,
    #[msg("entry permission is not initialised")]
    PermissionMissing,
    #[msg("price feed account is not the pinned feed")]
    WrongFeed,
    #[msg("price is stale")]
    StalePrice,
    #[msg("price is not valid")]
    InvalidPrice,
    #[msg("round is closed")]
    RoundClosed,
    #[msg("round has not closed yet")]
    RoundOpen,
    #[msg("settlement price is outside the settlement window")]
    OutsideSettleWindow,
    #[msg("invalid position")]
    InvalidPosition,
    #[msg("wrong set of entries supplied")]
    BadEntries,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("the nonce phase is closed")]
    NoncePhaseClosed,
    #[msg("a nonce was already committed this round")]
    NonceAlreadyCommitted,
    #[msg("nonce must not be all zero")]
    ZeroNonce,
    #[msg("the nonce phase is still open")]
    NoncePhaseOpen,
    #[msg("not enough nonces were committed")]
    NotEnoughNonces,
    #[msg("the VRF wait has not expired")]
    VrfWaitNotExpired,
    #[msg("secret account does not belong to this league")]
    WrongSecret,
}
