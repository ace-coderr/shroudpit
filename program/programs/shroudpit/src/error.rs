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
    #[msg("settlement window has not expired")]
    WindowNotExpired,
    #[msg("invalid position")]
    InvalidPosition,
    #[msg("wrong set of entries supplied")]
    BadEntries,
    #[msg("arithmetic overflow")]
    Overflow,
}
