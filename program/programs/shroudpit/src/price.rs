use anchor_lang::prelude::*;

use crate::error::ShroudError;

/// MagicBlock real-time pricing oracle program: owner of the feed accounts on the ER.
pub const PRICE_ORACLE_PROGRAM_ID: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

// Layout of a feed account (same field order as Pyth's PriceUpdateV2):
// 8 discriminator + 32 write authority + 1 verification level + 32 feed id = 73,
// then price i64, conf u64, exponent i32, publish_time i64.
const PRICE_OFFSET: usize = 73;
const PUBLISH_TIME_OFFSET: usize = 93;
const MIN_LEN: usize = PUBLISH_TIME_OFFSET + 8;

/// Feed address for a Pyth Lazer id: PDA of the oracle program.
pub fn feed_address(pyth_lazer_id: u32) -> Pubkey {
    let id = pyth_lazer_id.to_string();
    Pubkey::find_program_address(
        &[b"price_feed", b"pyth-lazer", id.as_bytes()],
        &PRICE_ORACLE_PROGRAM_ID,
    )
    .0
}

pub struct Quote {
    pub price: i64,
    pub publish_time: i64,
}

/// Reads a feed. The account address and owner are checked explicitly because the feed is
/// not a Pyth receiver account and must not be loaded as one.
pub fn read_quote(info: &AccountInfo, pinned: &Pubkey) -> Result<Quote> {
    require_keys_eq!(*info.key, *pinned, ShroudError::WrongFeed);
    require_keys_eq!(*info.owner, PRICE_ORACLE_PROGRAM_ID, ShroudError::WrongFeed);
    let data = info.try_borrow_data()?;
    require!(data.len() >= MIN_LEN, ShroudError::WrongFeed);
    let price = i64::from_le_bytes(data[PRICE_OFFSET..PRICE_OFFSET + 8].try_into().unwrap());
    let publish_time = i64::from_le_bytes(
        data[PUBLISH_TIME_OFFSET..PUBLISH_TIME_OFFSET + 8]
            .try_into()
            .unwrap(),
    );
    require!(price > 0, ShroudError::InvalidPrice);
    Ok(Quote { price, publish_time })
}

/// A quote usable "now": positive, not stale, not from the future.
pub fn fresh_quote(info: &AccountInfo, pinned: &Pubkey, now: i64, max_age: i64) -> Result<Quote> {
    let q = read_quote(info, pinned)?;
    require!(q.publish_time <= now + 5, ShroudError::StalePrice);
    require!(now - q.publish_time <= max_age, ShroudError::StalePrice);
    Ok(q)
}
