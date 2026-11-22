pub mod error;
pub mod price;
pub mod rating;
pub mod state;

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, spl_token::instruction::AuthorityType, Mint, MintTo, SetAuthority, Token, TokenAccount},
};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::CreateEphemeralPermissionCpi,
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder},
    vrf::{
        consts::{program_identity_pubkey, scoped_vrf_identity_const, DEFAULT_EPHEMERAL_QUEUE},
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

use error::ShroudError;
use state::*;

declare_id!("E8DAQoqcTTi4TNYM2Q2MEzy3rxKHfqzBoMKrCPVbCsEF");

/// The identity PDA this program signs randomness requests with. A `const` item so the PDA is
/// derived at compile time rather than on every call.
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);

/// The scoped identity that must sign the VRF callback. The `#[vrf_callback]` macro would derive
/// this inside the account constraint, i.e. at run time, which costs about 260k compute units
/// and makes the callback fail. Declaring the field ourselves with a compile-time constant
/// keeps the same check at no cost.
const VRF_CALLBACK_IDENTITY: Pubkey =
    Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0);

#[ephemeral]
#[program]
pub mod shroudpit {
    use super::*;

    // ------------------------------------------------------------------
    // Base layer
    // ------------------------------------------------------------------

    /// Create a league and its private `Secret` account. The creator pre-funds the rent of the
    /// secret's ephemeral permission and a small commit buffer on the league.
    pub fn create_league(
        ctx: Context<CreateLeague>,
        league_id: u64,
        n_rounds: u8,
        min_secs: u32,
        max_secs: u32,
        max_players: u8,
        feed_id: u32,
        close_mode: u8,
    ) -> Result<()> {
        require!(n_rounds >= 1 && n_rounds <= MAX_ROUNDS, ShroudError::InvalidParams);
        require!(
            min_secs >= MIN_ROUND_SECS && max_secs >= min_secs && max_secs <= MAX_ROUND_SECS,
            ShroudError::InvalidParams
        );
        require!(max_players >= 2 && max_players <= MAX_PLAYERS, ShroudError::InvalidParams);
        require!(close_mode <= CloseMode::NoncesSlotAndVrf as u8, ShroudError::InvalidParams);

        let buffer = ephemeral_rollups_sdk::ephemeral_accounts::rent(
            EphemeralPermission::size_of(0) as u32,
        );
        for to in [
            ctx.accounts.league.to_account_info(),
            ctx.accounts.secret.to_account_info(),
        ] {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to,
                    },
                ),
                buffer,
            )?;
        }

        let league_key = ctx.accounts.league.key();
        let league = &mut ctx.accounts.league;
        league.creator = ctx.accounts.creator.key();
        league.id = league_id;
        league.status = Status::Open as u8;
        league.n_rounds = n_rounds;
        league.max_players = max_players;
        league.bump = ctx.bumps.league;
        league.close_mode = close_mode;
        league.min_secs = min_secs;
        league.max_secs = max_secs;
        league.feed = price::feed_address(feed_id);

        let secret = &mut ctx.accounts.secret;
        secret.league = league_key;
        secret.bump = ctx.bumps.secret;
        Ok(())
    }

    /// Join an open league. A second join by the same wallet fails because the entry PDA
    /// already exists. The player pre-funds the rent of their entry's ephemeral permission.
    pub fn join_league(ctx: Context<JoinLeague>) -> Result<()> {
        let league = &mut ctx.accounts.league;
        require!(league.status == Status::Open as u8, ShroudError::WrongStatus);
        require!(league.player_count < league.max_players, ShroudError::LeagueFull);
        league.player_count += 1;

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.entry.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32),
        )?;

        let entry = &mut ctx.accounts.entry;
        entry.league = league.key();
        entry.player = ctx.accounts.player.key();
        entry.bump = ctx.bumps.entry;
        let card = &mut ctx.accounts.card;
        card.league = league.key();
        card.player = ctx.accounts.player.key();
        card.bump = ctx.bumps.card;
        Ok(())
    }

    /// Delegate the caller's entry and score card to the TEE validator.
    pub fn delegate_entry(ctx: Context<DelegateEntry>) -> Result<()> {
        let league = ctx.accounts.league.key();
        let player = ctx.accounts.player.key();
        ctx.accounts.delegate_entry(
            &ctx.accounts.player,
            &[ENTRY_SEED, league.as_ref(), player.as_ref()],
            DelegateConfig {
                validator: Some(ctx.accounts.validator.key()),
                ..Default::default()
            },
        )?;
        ctx.accounts.delegate_card(
            &ctx.accounts.player,
            &[CARD_SEED, league.as_ref(), player.as_ref()],
            DelegateConfig {
                validator: Some(ctx.accounts.validator.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Delegate the league and its secret to the TEE validator. Joining ends here.
    pub fn delegate_league(ctx: Context<DelegateLeague>) -> Result<()> {
        let creator = ctx.accounts.creator.key();
        let id = ctx.accounts.league_id_account_data()?;
        let league_key = ctx.accounts.league.key();
        let (secret_key, _) =
            Pubkey::find_program_address(&[SECRET_SEED, league_key.as_ref()], &crate::ID);
        require_keys_eq!(secret_key, ctx.accounts.secret.key(), ShroudError::WrongSecret);
        let validator = ctx.accounts.validator.key();
        ctx.accounts.delegate_league(
            &ctx.accounts.creator,
            &[LEAGUE_SEED, creator.as_ref(), &id.to_le_bytes()],
            DelegateConfig {
                validator: Some(validator),
                ..Default::default()
            },
        )?;
        ctx.accounts.delegate_secret(
            &ctx.accounts.creator,
            &[SECRET_SEED, league_key.as_ref()],
            DelegateConfig {
                validator: Some(validator),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Private Ephemeral Rollup (TEE)
    // ------------------------------------------------------------------

    /// Make the secret unreadable to everyone (no members): nobody can read the hidden close
    /// time from RPC while the round is live. The league itself stays publicly readable.
    pub fn init_secret_permission(ctx: Context<InitSecretPermission>) -> Result<()> {
        if permission_exists(&ctx.accounts.permission) {
            return Ok(());
        }
        let secret = &ctx.accounts.secret;
        let signers: &[&[u8]] = &[SECRET_SEED, secret.league.as_ref(), &[secret.bump]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.secret.to_account_info(),
            permissioned_account: ctx.accounts.secret.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![],
            },
        }
        .invoke_signed(&[signers])?;
        Ok(())
    }

    /// Make an entry readable only by its owner. Always private, owner is the only member.
    pub fn init_entry_permission(ctx: Context<InitEntryPermission>) -> Result<()> {
        if permission_exists(&ctx.accounts.permission) {
            return Ok(());
        }
        let entry = &ctx.accounts.entry;
        let signers: &[&[u8]] = &[
            ENTRY_SEED,
            entry.league.as_ref(),
            entry.player.as_ref(),
            &[entry.bump],
        ];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.entry.to_account_info(),
            permissioned_account: ctx.accounts.entry.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                    pubkey: entry.player,
                }],
            },
        }
        .invoke_signed(&[signers])?;
        Ok(())
    }

    /// Creator opens a round: players now have `NONCE_WINDOW_SECS` to commit a private nonce.
    /// Also restarts a nonce phase that expired with too few nonces.
    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let league = &mut ctx.accounts.league;
        let restart = league.status == Status::Nonces as u8
            && now >= league.nonce_deadline
            && league.nonce_count < MIN_NONCES;
        require!(
            league.status == Status::Open as u8 || league.status == Status::Between as u8 || restart,
            ShroudError::WrongStatus
        );
        require!(league.player_count >= 2, ShroudError::WrongStatus);
        league.epoch = league.epoch.checked_add(1).ok_or(ShroudError::Overflow)?;
        league.status = Status::Nonces as u8;
        league.nonce_deadline = now + NONCE_WINDOW_SECS;
        league.nonce_count = 0;
        Ok(())
    }

    /// Commit a private nonce for this round. Nonces are immutable once committed and must be in
    /// before lock-in, so no player can choose their nonce after seeing anyone else's.
    pub fn commit_nonce(ctx: Context<CommitNonce>, nonce: [u8; 32]) -> Result<()> {
        require!(nonce != [0u8; 32], ShroudError::ZeroNonce);
        require_private_permission(&ctx.accounts.permission, &ctx.accounts.entry.key())?;
        let now = Clock::get()?.unix_timestamp;
        let league = &mut ctx.accounts.league;
        require!(league.status == Status::Nonces as u8, ShroudError::NoncePhaseClosed);
        require!(now < league.nonce_deadline, ShroudError::NoncePhaseClosed);
        let entry = &mut ctx.accounts.entry;
        require!(entry.nonce_epoch != league.epoch, ShroudError::NonceAlreadyCommitted);
        entry.nonce = nonce;
        entry.nonce_epoch = league.epoch;
        league.nonce_count += 1;
        Ok(())
    }

    /// Close the nonce phase and derive the hidden close time. Callable by anyone once every
    /// player has committed or the nonce deadline has passed.
    ///
    /// base seed = sha256(league, epoch, slot at lock-in, every committed (player, nonce)).
    /// With `CloseMode::NoncesSlotAndVrf` a VRF request is made and its output is mixed in when it
    /// arrives; if it does not arrive within `VRF_WAIT_SECS`, `finalize_without_vrf` derives the
    /// close time from the base seed alone.
    pub fn lock_in<'info>(ctx: Context<'info, LockIn<'info>>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let league_key = ctx.accounts.league.key();
        let (epoch, player_count, close_mode) = {
            let l = &ctx.accounts.league;
            require!(l.status == Status::Nonces as u8, ShroudError::WrongStatus);
            require!(
                l.nonce_count == l.player_count || now >= l.nonce_deadline,
                ShroudError::NoncePhaseOpen
            );
            require!(l.nonce_count >= MIN_NONCES, ShroudError::NotEnoughNonces);
            (l.epoch, l.player_count as usize, l.close_mode)
        };
        require!(ctx.remaining_accounts.len() == player_count, ShroudError::BadEntries);

        let mut buf: Vec<u8> = Vec::with_capacity(48 + player_count * 64);
        buf.extend_from_slice(league_key.as_ref());
        buf.extend_from_slice(&epoch.to_le_bytes());
        buf.extend_from_slice(&clock.slot.to_le_bytes());
        let mut prev: Option<Pubkey> = None;
        for acc in ctx.remaining_accounts {
            let entry = load_entry(acc, &league_key, &mut prev)?;
            if entry.nonce_epoch == epoch {
                buf.extend_from_slice(entry.player.as_ref());
                buf.extend_from_slice(&entry.nonce);
            }
        }
        let base = hashv(&[&buf]).to_bytes();
        ctx.accounts.secret.current.epoch = epoch;
        ctx.accounts.secret.current.lock_slot = clock.slot;
        ctx.accounts.secret.current.base_seed = base;

        if close_mode == CloseMode::NoncesAndSlot as u8 {
            finish_close(&mut ctx.accounts.league, &mut ctx.accounts.secret, None, now);
            return Ok(());
        }

        ctx.accounts.league.status = Status::AwaitingVrf as u8;
        ctx.accounts.league.vrf_deadline = now + VRF_WAIT_SECS;
        let params = RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackClose::DISCRIMINATOR.to_vec(),
            caller_seed: base,
            accounts_metas: Some(vec![
                SerializableAccountMeta {
                    pubkey: league_key,
                    is_signer: false,
                    is_writable: true,
                },
                SerializableAccountMeta {
                    pubkey: ctx.accounts.secret.key(),
                    is_signer: false,
                    is_writable: true,
                },
            ]),
            callback_args: None,
            ..Default::default()
        };
        let ix = create_request_randomness_ix_const(params, PROGRAM_IDENTITY);
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback: mix the VRF output into the base seed and set the hidden close time. Only
    /// the VRF program can invoke this and only while a request is outstanding, so a result
    /// cannot be replayed, injected, or applied after the close time was already derived.
    pub fn callback_close(ctx: Context<CallbackClose>, randomness: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let league = &mut ctx.accounts.league;
        require!(league.status == Status::AwaitingVrf as u8, ShroudError::WrongStatus);
        finish_close(league, &mut ctx.accounts.secret, Some(randomness), now);
        Ok(())
    }

    /// If the VRF output did not arrive in time, derive the close time from the base seed alone.
    pub fn finalize_without_vrf(ctx: Context<FinalizeWithoutVrf>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let league = &mut ctx.accounts.league;
        require!(league.status == Status::AwaitingVrf as u8, ShroudError::WrongStatus);
        require!(now >= league.vrf_deadline, ShroudError::VrfWaitNotExpired);
        finish_close(league, &mut ctx.accounts.secret, None, now);
        Ok(())
    }

    /// Set or adjust the caller's paper position. Marks the previous position to the current
    /// price first, then opens the new one at the current price.
    pub fn set_position(ctx: Context<SetPosition>, side: i8, leverage: u8) -> Result<()> {
        require!((-1..=1).contains(&side), ShroudError::InvalidPosition);
        require!(
            (side == 0 && leverage == 0) || (side != 0 && leverage >= 1 && leverage <= MAX_LEVERAGE),
            ShroudError::InvalidPosition
        );
        require_private_permission(&ctx.accounts.permission, &ctx.accounts.entry.key())?;

        let league = &ctx.accounts.league;
        let now = Clock::get()?.unix_timestamp;
        require!(league.status == Status::Live as u8, ShroudError::WrongStatus);
        require!(now < ctx.accounts.secret.current.close_at, ShroudError::RoundClosed);

        let q = price::fresh_quote(&ctx.accounts.price_feed, &league.feed, now, MAX_PRICE_AGE_SECS)?;

        let entry = &mut ctx.accounts.entry;
        if entry.round != league.round {
            entry.reset_for_round(league.round);
        }
        let pnl = rating::pnl_bps(entry.side, entry.leverage, entry.entry_price, q.price);
        entry.ret_bps = (entry.ret_bps + pnl).max(-10_000);
        entry.side = side;
        entry.leverage = leverage;
        entry.entry_price = if side == 0 { 0 } else { q.price };
        Ok(())
    }

    // ------------------------------------------------------------------
    // Trophy (base layer, after the league has finished)
    // ------------------------------------------------------------------

    /// The winner claims an owned devnet asset: a 0-decimal SPL token, supply 1, minted to their
    /// wallet. The mint is a PDA of the league, so it can exist only once, and its mint authority
    /// is removed straight after minting so the supply can never grow.
    pub fn claim_trophy(ctx: Context<ClaimTrophy>) -> Result<()> {
        let l = &ctx.accounts.league;
        require!(l.status == Status::Finished as u8, ShroudError::WrongStatus);
        require_keys_eq!(l.winner, ctx.accounts.winner.key(), ShroudError::NotWinner);
        let id = l.id.to_le_bytes();
        let bump = [l.bump];
        let seeds: &[&[u8]] = &[LEAGUE_SEED, l.creator.as_ref(), &id, &bump];
        let token_program = ctx.accounts.token_program.key();
        token::mint_to(
            CpiContext::new_with_signer(
                token_program,
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.winner_token.to_account_info(),
                    authority: ctx.accounts.league.to_account_info(),
                },
                &[seeds],
            ),
            1,
        )?;
        token::set_authority(
            CpiContext::new_with_signer(
                token_program,
                SetAuthority {
                    current_authority: ctx.accounts.league.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        Ok(())
    }

    /// Final reveal, step 1 of 2. Permissionless. Commits and undelegates up to `REVEAL_CHUNK`
    /// entries, publishing their positions and nonces. Call repeatedly until every entry is out.
    pub fn reveal_entries<'info>(ctx: Context<'info, RevealEntries<'info>>) -> Result<()> {
        let a = ctx.accounts;
        require!(a.league.status == Status::Finishing as u8, ShroudError::WrongStatus);
        let remaining = ctx.remaining_accounts;
        require!(!remaining.is_empty() && remaining.len() <= REVEAL_CHUNK, ShroudError::ChunkTooLarge);
        let league_key = a.league.key();
        let mut prev: Option<Pubkey> = None;
        let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(remaining.len());
        for acc in remaining {
            let mut entry = load_entry(acc, &league_key, &mut prev)?;
            require!(acc.is_writable, ShroudError::BadEntries);
            require!(!entry.revealed, ShroudError::EntryRevealed);
            entry.revealed = true;
            entry.exit(&crate::ID)?;
            infos.push(acc.clone());
        }
        a.league.revealed_count += remaining.len() as u8;
        require!(a.league.revealed_count <= a.league.player_count, ShroudError::BadEntries);
        a.league.exit(&crate::ID)?;

        let creator = a.league.creator;
        let id = a.league.id.to_le_bytes();
        let bump = [a.league.bump];
        let seeds: &[&[u8]] = &[LEAGUE_SEED, creator.as_ref(), &id, &bump];
        MagicIntentBundleBuilder::new(
            a.league.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&infos)
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Final reveal, step 2 of 2. Permissionless, once every entry has been revealed: commits and
    /// undelegates the league, the secret (every round's close time and seed) and the score cards.
    pub fn finish_league<'info>(ctx: Context<'info, FinishLeague<'info>>) -> Result<()> {
        let a = ctx.accounts;
        require!(a.league.status == Status::Finishing as u8, ShroudError::WrongStatus);
        require!(a.league.revealed_count == a.league.player_count, ShroudError::NotAllRevealed);
        let remaining = ctx.remaining_accounts;
        require!(remaining.len() == a.league.player_count as usize, ShroudError::BadEntries);
        let league_key = a.league.key();
        let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(remaining.len() + 2);
        for acc in remaining {
            let card: Account<Card> = Account::try_from(acc)?;
            require_keys_eq!(card.league, league_key, ShroudError::BadEntries);
            require!(acc.is_writable, ShroudError::BadEntries);
            infos.push(acc.clone());
        }
        a.league.status = Status::Finished as u8;
        a.league.exit(&crate::ID)?;
        infos.insert(0, a.secret.to_account_info());
        infos.insert(0, a.league.to_account_info());

        let creator = a.league.creator;
        let id = a.league.id.to_le_bytes();
        let bump = [a.league.bump];
        let seeds: &[&[u8]] = &[LEAGUE_SEED, creator.as_ref(), &id, &bump];
        MagicIntentBundleBuilder::new(
            a.league.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .magic_fee_vault(a.magic_fee_vault.to_account_info())
        .commit_and_undelegate(&infos)
        .build_and_invoke_signed(&[seeds])?;
        Ok(())
    }

    /// Permissionless and idempotent: callable by anyone, for example from any player's open desk.
    ///
    /// * before the hidden close, or once the round is no longer live: does nothing (Ok);
    /// * inside the settlement window: marks every entry to the settlement price, updates
    ///   ratings and reveals by committing (the last round also undelegates everything);
    /// * after the window: the round is voided (no scores) so a late or missing trigger can
    ///   never strand the league. This path does not read the price feed, so a broken feed
    ///   cannot deadlock it either.
    pub fn settle_and_reveal<'info>(mut ctx: Context<'info, Settle<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (live, feed) = {
            let l = &ctx.accounts.league;
            (l.status == Status::Live as u8, l.feed)
        };
        let close_at = ctx.accounts.secret.current.close_at;
        if !live || now < close_at {
            return Ok(());
        }
        let remaining = ctx.remaining_accounts;
        if now > close_at + SETTLE_WINDOW_SECS {
            return close_out(&mut ctx.accounts, remaining, None);
        }
        let q = price::read_quote(&ctx.accounts.price_feed, &feed)?;
        require!(
            q.publish_time >= close_at
                && q.publish_time <= close_at + SETTLE_WINDOW_SECS
                && q.publish_time <= now + 5,
            ShroudError::OutsideSettleWindow
        );
        close_out(&mut ctx.accounts, remaining, Some((q.price, q.publish_time)))
    }
}

impl Entry {
    fn reset_for_round(&mut self, round: u8) {
        self.round = round;
        self.side = 0;
        self.leverage = 0;
        self.entry_price = 0;
        self.ret_bps = 0;
    }
}

/// An ephemeral permission account is rent-free (0 lamports), so existence is judged from its
/// owner and data. Layout: byte 0 discriminator, byte 1 bump, bytes 2..34 the permissioned
/// account, byte 34 the privacy flag, then the members.
fn permission_exists(permission: &AccountInfo) -> bool {
    *permission.owner == PERMISSION_PROGRAM_ID && permission.data_len() >= 35
}

/// The permission must exist, belong to `permissioned`, and be private. Without this a position
/// or nonce could be written while the entry is still publicly readable.
fn require_private_permission(permission: &AccountInfo, permissioned: &Pubkey) -> Result<()> {
    require!(permission_exists(permission), ShroudError::PermissionMissing);
    let d = permission.try_borrow_data()?;
    require!(d[2..34] == permissioned.to_bytes(), ShroudError::PermissionMissing);
    require!(d[34] == 1, ShroudError::PermissionMissing);
    Ok(())
}

/// Derive the hidden close time and open the round. `vrf` is the VRF output when it was mixed in.
fn finish_close(league: &mut League, secret: &mut Secret, vrf: Option<[u8; 32]>, now: i64) {
    let base_seed = secret.current.base_seed;
    let seed = match vrf {
        Some(r) => {
            secret.current.randomness = r;
            hashv(&[&base_seed, &r]).to_bytes()
        }
        None => base_seed,
    };
    secret.current.vrf_used = vrf.is_some();
    let span = (league.max_secs - league.min_secs) as u64 + 1;
    let offset = u64::from_le_bytes(seed[0..8].try_into().unwrap()) % span;
    secret.current.started_at = now;
    secret.current.close_at = now + league.min_secs as i64 + offset as i64;
    league.round_started_at = now;
    league.status = Status::Live as u8;
}

/// Load and verify an entry passed as a remaining account: owned by this program, belongs to the
/// league, is the canonical PDA for its player, and keys are strictly ascending (so no
/// duplicates and a canonical order).
fn load_entry<'info>(
    acc: &'info AccountInfo<'info>,
    league_key: &Pubkey,
    prev: &mut Option<Pubkey>,
) -> Result<Account<'info, Entry>> {
    // Anchor checks owner and discriminator.
    let entry: Account<Entry> = Account::try_from(acc)?;
    require_keys_eq!(entry.league, *league_key, ShroudError::BadEntries);
    let expected = Pubkey::create_program_address(
        &[ENTRY_SEED, league_key.as_ref(), entry.player.as_ref(), &[entry.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(ShroudError::BadEntries))?;
    require_keys_eq!(expected, *acc.key, ShroudError::BadEntries);
    if let Some(p) = *prev {
        require!(*acc.key > p, ShroudError::BadEntries);
    }
    *prev = Some(*acc.key);
    Ok(entry)
}

/// Shared tail of settle and abort: score (or not), record the round, advance the league, commit.
///
/// `remaining` holds `[entry, card]` pairs in ascending entry-key order. Every round commits the
/// league and the public score cards; positions, nonces and the secret are committed only by the
/// final round, which also undelegates everything.
fn close_out<'info>(
    a: &mut Settle<'info>,
    remaining: &'info [AccountInfo<'info>],
    settle: Option<(i64, i64)>,
) -> Result<()> {
    let league_key = a.league.key();
    let count = a.league.player_count as usize;
    require!(remaining.len() == count * 2, ShroudError::BadEntries);

    let round = a.league.round;
    let epoch = a.league.epoch;
    let finishing = round + 1 == a.league.n_rounds;
    let mut prev: Option<Pubkey> = None;
    let mut best: Option<(i64, Pubkey)> = None;
    let mut cards: Vec<AccountInfo<'info>> = Vec::with_capacity(count);
    let mut entries: Vec<AccountInfo<'info>> = Vec::with_capacity(count);

    for pair in remaining.chunks(2) {
        let (acc, card_acc) = (&pair[0], &pair[1]);
        let mut entry = load_entry(acc, &league_key, &mut prev)?;
        require!(acc.is_writable && card_acc.is_writable, ShroudError::BadEntries);
        let mut card: Account<Card> = Account::try_from(card_acc)?;
        require_keys_eq!(card.league, league_key, ShroudError::BadEntries);
        require_keys_eq!(card.player, entry.player, ShroudError::BadEntries);
        let expected_card = Pubkey::create_program_address(
            &[CARD_SEED, league_key.as_ref(), card.player.as_ref(), &[card.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(ShroudError::BadEntries))?;
        require_keys_eq!(expected_card, *card_acc.key, ShroudError::BadEntries);

        if entry.round != round {
            entry.reset_for_round(round);
        }
        let mut total = 0;
        if let Some((price, _)) = settle {
            let pnl = rating::pnl_bps(entry.side, entry.leverage, entry.entry_price, price);
            total = (entry.ret_bps + pnl).clamp(-10_000, 1_000_000);
            card.last_ret_bps = total;
            card.rounds_scored += 1;
            card.sum_ret_bps += total;
            card.sum_sq_ret_bps += total * total;
            card.rating = rating::rating(card.rounds_scored, card.sum_ret_bps, card.sum_sq_ret_bps);
        }
        // record the closing position and nonce for the end-of-league reveal
        let committed = entry.nonce_epoch == epoch && epoch > 0;
        let slot = round as usize;
        entry.history[slot] = RoundPos {
            nonce: if committed { entry.nonce } else { [0u8; 32] },
            committed,
            scored: settle.is_some(),
            side: entry.side,
            leverage: entry.leverage,
            entry_price: entry.entry_price,
            ret_bps: total,
        };
        match best {
            Some((r, _)) if card.rating <= r => {}
            // Entries are visited in ascending key order and only a strictly higher rating
            // replaces the leader, so ties go to the lowest entry key.
            _ => best = Some((card.rating, entry.player)),
        }
        entry.exit(&crate::ID)?;
        card.exit(&crate::ID)?;
        entries.push(acc.clone());
        cards.push(card_acc.clone());
    }

    {
        let league = &mut a.league;
        if let Some((price, time)) = settle {
            league.settle_price = price;
            league.settle_time = time;
        }
        // file the round's secret away; it stays private until the final commit
        let current = a.secret.current;
        a.secret.history[round as usize] = current;
        league.round += 1;
        if finishing {
            league.status = Status::Finishing as u8;
            if let Some((_, player)) = best {
                league.winner = player;
            }
        } else {
            league.status = Status::Between as u8;
        }
    }
    // Serialise before the commit CPI reads the accounts.
    a.league.exit(&crate::ID)?;
    a.secret.exit(&crate::ID)?;

    // Every round commits only the league and the public score cards. Entries and the secret stay
    // sealed until the final reveal, which runs in separate transactions because one commit bundle
    // is limited to about 2.7 KB of account data.
    let _ = entries;
    let mut infos: Vec<AccountInfo<'info>> = vec![a.league.to_account_info()];
    infos.extend(cards);

    // The league PDA pays for the commit and signs for itself, so no external signer (and no
    // keeper) is needed: any caller can trigger settlement.
    let creator = a.league.creator;
    let id = a.league.id.to_le_bytes();
    let bump = [a.league.bump];
    let seeds: &[&[u8]] = &[LEAGUE_SEED, creator.as_ref(), &id, &bump];
    let builder = MagicIntentBundleBuilder::new(
        a.league.to_account_info(),
        a.magic_context.to_account_info(),
        a.magic_program.to_account_info(),
    )
    .magic_fee_vault(a.magic_fee_vault.to_account_info());
    builder.commit(&infos).build_and_invoke_signed(&[seeds])?;
    Ok(())
}

// ----------------------------------------------------------------------
// Accounts
// ----------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(league_id: u64)]
pub struct CreateLeague<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + League::INIT_SPACE,
        seeds = [LEAGUE_SEED, creator.key().as_ref(), &league_id.to_le_bytes()],
        bump
    )]
    pub league: Account<'info, League>,
    #[account(
        init,
        payer = creator,
        space = 8 + Secret::INIT_SPACE,
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump
    )]
    pub secret: Box<Account<'info, Secret>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinLeague<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        init,
        payer = player,
        space = 8 + Entry::INIT_SPACE,
        seeds = [ENTRY_SEED, league.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub entry: Box<Account<'info, Entry>>,
    #[account(
        init,
        payer = player,
        space = 8 + Card::INIT_SPACE,
        seeds = [CARD_SEED, league.key().as_ref(), player.key().as_ref()],
        bump
    )]
    pub card: Box<Account<'info, Card>>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateEntry<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: only used to derive the entry address
    pub league: UncheckedAccount<'info>,
    /// CHECK: the entry PDA being delegated
    #[account(mut, del, seeds = [ENTRY_SEED, league.key().as_ref(), player.key().as_ref()], bump)]
    pub entry: UncheckedAccount<'info>,
    /// CHECK: the player's score card PDA being delegated
    #[account(mut, del, seeds = [CARD_SEED, league.key().as_ref(), player.key().as_ref()], bump)]
    pub card: UncheckedAccount<'info>,
    /// CHECK: must be the TEE validator so positions stay in the enclave
    #[account(address = TEE_VALIDATOR @ ShroudError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateLeague<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the league PDA being delegated; creator and id are validated in the handler
    #[account(mut, del)]
    pub league: UncheckedAccount<'info>,
    /// CHECK: the league's secret PDA; checked against the league in the handler
    #[account(mut, del)]
    pub secret: UncheckedAccount<'info>,
    /// CHECK: must be the TEE validator
    #[account(address = TEE_VALIDATOR @ ShroudError::WrongValidator)]
    pub validator: UncheckedAccount<'info>,
}

impl<'info> DelegateLeague<'info> {
    /// Read the league id and check the PDA belongs to the signing creator.
    fn league_id_account_data(&self) -> Result<u64> {
        let data = self.league.try_borrow_data()?;
        let league = League::try_deserialize(&mut &data[..])?;
        require_keys_eq!(league.creator, self.creator.key(), ShroudError::NotCreator);
        let (expected, _) = Pubkey::find_program_address(
            &[LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
            &crate::ID,
        );
        require_keys_eq!(expected, self.league.key(), ShroudError::NotCreator);
        Ok(league.id)
    }
}

#[derive(Accounts)]
pub struct InitSecretPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        mut,
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump = secret.bump,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
    /// CHECK: verified by the permission program; address pinned to the expected PDA
    #[account(mut, seeds = [PERMISSION_SEED, secret.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: verified by the magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitEntryPermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [ENTRY_SEED, entry.league.as_ref(), entry.player.as_ref()],
        bump = entry.bump
    )]
    pub entry: Box<Account<'info, Entry>>,
    /// CHECK: verified by the permission program; address pinned to the expected PDA
    #[account(mut, seeds = [PERMISSION_SEED, entry.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: verified by the magic program
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: magic program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(constraint = creator.key() == league.creator @ ShroudError::NotCreator)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
}

#[derive(Accounts)]
pub struct CommitNonce<'info> {
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        mut,
        seeds = [ENTRY_SEED, league.key().as_ref(), player.key().as_ref()],
        bump = entry.bump
    )]
    pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's permission account; existence and owner checked in the handler
    #[account(seeds = [PERMISSION_SEED, entry.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct LockIn<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        mut,
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump = secret.bump,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
    /// CHECK: the ER VRF queue
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// `vrf_program_identity` is declared here, with a compile-time constant address, instead of
/// being injected by `#[vrf_callback]` (see `VRF_CALLBACK_IDENTITY`).
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackClose<'info> {
    #[account(address = VRF_CALLBACK_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub league: Account<'info, League>,
    #[account(
        mut,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
}

#[derive(Accounts)]
pub struct FinalizeWithoutVrf<'info> {
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        mut,
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump = secret.bump,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
}

#[derive(Accounts)]
pub struct SetPosition<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump = secret.bump,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
    #[account(
        mut,
        seeds = [ENTRY_SEED, league.key().as_ref(), player.key().as_ref()],
        bump = entry.bump
    )]
    pub entry: Box<Account<'info, Entry>>,
    /// CHECK: the entry's permission account; existence and owner checked in the handler
    #[account(seeds = [PERMISSION_SEED, entry.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: pinned to league.feed and owner-checked in the handler
    pub price_feed: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    #[account(
        mut,
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump = secret.bump,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
    /// CHECK: pinned to league.feed and owner-checked in the handler
    pub price_feed: UncheckedAccount<'info>,
    /// CHECK: the magic fee vault PDA for the TEE validator
    #[account(mut, address = MAGIC_FEE_VAULT)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimTrophy<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    /// One mint per league: a second claim fails because the PDA already exists.
    #[account(
        init,
        payer = winner,
        seeds = [TROPHY_SEED, league.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = league
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = winner,
        associated_token::mint = mint,
        associated_token::authority = winner
    )]
    pub winner_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[commit]
#[derive(Accounts)]
pub struct RevealEntries<'info> {
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Box<Account<'info, League>>,
    /// CHECK: the magic fee vault PDA for the TEE validator
    #[account(mut, address = MAGIC_FEE_VAULT)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct FinishLeague<'info> {
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Box<Account<'info, League>>,
    #[account(
        mut,
        seeds = [SECRET_SEED, league.key().as_ref()],
        bump = secret.bump,
        constraint = secret.league == league.key() @ ShroudError::WrongSecret
    )]
    pub secret: Box<Account<'info, Secret>>,
    /// CHECK: the magic fee vault PDA for the TEE validator
    #[account(mut, address = MAGIC_FEE_VAULT)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}
