pub mod error;
pub mod price;
pub mod rating;
pub mod state;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_lang::system_program::{transfer, Transfer};
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
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
        consts::{program_identity_pubkey, DEFAULT_EPHEMERAL_QUEUE},
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

use error::ShroudError;
use state::*;

declare_id!("69VymhYdXWsBVy9h5D1xdM6MU7DbBXF7rQHvGoUcW6K9");

/// The identity PDA this program signs randomness requests with.
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);

#[ephemeral]
#[program]
pub mod shroudpit {
    use super::*;

    // ------------------------------------------------------------------
    // Base layer
    // ------------------------------------------------------------------

    /// Create a league. The creator pre-funds the rent of the league's ephemeral permission.
    pub fn create_league(
        ctx: Context<CreateLeague>,
        league_id: u64,
        n_rounds: u8,
        min_secs: u32,
        max_secs: u32,
        max_players: u8,
        feed_id: u32,
    ) -> Result<()> {
        require!(n_rounds >= 1 && n_rounds <= MAX_ROUNDS, ShroudError::InvalidParams);
        require!(
            min_secs >= MIN_ROUND_SECS && max_secs >= min_secs && max_secs <= MAX_ROUND_SECS,
            ShroudError::InvalidParams
        );
        require!(max_players >= 2 && max_players <= MAX_PLAYERS, ShroudError::InvalidParams);

        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.league.to_account_info(),
                },
            ),
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(0) as u32),
        )?;

        let league = &mut ctx.accounts.league;
        league.creator = ctx.accounts.creator.key();
        league.id = league_id;
        league.status = Status::Open as u8;
        league.n_rounds = n_rounds;
        league.round = 0;
        league.player_count = 0;
        league.max_players = max_players;
        league.bump = ctx.bumps.league;
        league.min_secs = min_secs;
        league.max_secs = max_secs;
        league.feed = price::feed_address(feed_id);
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
        Ok(())
    }

    /// Delegate the caller's entry to the TEE validator so the position stays private.
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
        Ok(())
    }

    /// Delegate the league to the TEE validator. Joining ends here.
    pub fn delegate_league(ctx: Context<DelegateLeague>) -> Result<()> {
        let creator = ctx.accounts.creator.key();
        let id = ctx.accounts.league_id_account_data()?;
        ctx.accounts.delegate_league(
            &ctx.accounts.creator,
            &[LEAGUE_SEED, creator.as_ref(), &id.to_le_bytes()],
            DelegateConfig {
                validator: Some(ctx.accounts.validator.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Private Ephemeral Rollup (TEE)
    // ------------------------------------------------------------------

    /// Make the league unreadable to everyone (no members): nobody can read the hidden
    /// close time from RPC while the round is live.
    pub fn init_league_permission(ctx: Context<InitLeaguePermission>) -> Result<()> {
        if ctx.accounts.permission.lamports() > 0 {
            return Ok(());
        }
        let league = &ctx.accounts.league;
        let id = league.id.to_le_bytes();
        let signers: &[&[u8]] = &[LEAGUE_SEED, league.creator.as_ref(), &id, &[league.bump]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.league.to_account_info(),
            permissioned_account: ctx.accounts.league.to_account_info(),
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
        if ctx.accounts.permission.lamports() > 0 {
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

    /// Creator starts a round: requests VRF randomness. The callback picks the hidden close.
    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        let league_key = ctx.accounts.league.key();
        let seed = {
            let league = &mut ctx.accounts.league;
            require!(
                league.status == Status::Open as u8 || league.status == Status::Between as u8,
                ShroudError::WrongStatus
            );
            require!(league.player_count >= 2, ShroudError::WrongStatus);
            league.status = Status::AwaitingVrf as u8;
            let mut seed = league_key.to_bytes();
            seed[31] ^= league.round;
            seed
        };

        let params = RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackClose::DISCRIMINATOR.to_vec(),
            caller_seed: seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: league_key,
                is_signer: false,
                is_writable: true,
            }]),
            callback_args: None,
            ..Default::default()
        };
        let ix = create_request_randomness_ix_const(params, PROGRAM_IDENTITY);
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback: derive the hidden close time. Only the VRF program can invoke this and
    /// only while a request is outstanding, so a result cannot be replayed or injected.
    pub fn callback_close(ctx: Context<CallbackClose>, randomness: [u8; 32]) -> Result<()> {
        let league = &mut ctx.accounts.league;
        require!(league.status == Status::AwaitingVrf as u8, ShroudError::WrongStatus);
        let now = Clock::get()?.unix_timestamp;
        let span = (league.max_secs - league.min_secs) as u64 + 1;
        let offset = u64::from_le_bytes(randomness[0..8].try_into().unwrap()) % span;
        league.randomness = randomness;
        league.round_started_at = now;
        league.close_at = now + league.min_secs as i64 + offset as i64;
        league.status = Status::Live as u8;
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
        let permission = &ctx.accounts.permission;
        require!(
            permission.lamports() > 0 && *permission.owner == PERMISSION_PROGRAM_ID,
            ShroudError::PermissionMissing
        );

        let league = &ctx.accounts.league;
        let now = Clock::get()?.unix_timestamp;
        require!(league.status == Status::Live as u8, ShroudError::WrongStatus);
        require!(now < league.close_at, ShroudError::RoundClosed);

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

    /// Permissionless and idempotent: callable by anyone, by a crank, or by a player's browser.
    ///
    /// * before the hidden close, or once the round is no longer live: does nothing (Ok);
    /// * inside the settlement window: marks every entry to the settlement price, updates
    ///   ratings and reveals by committing (the last round also undelegates everything);
    /// * after the window: the round is voided (no scores) so a late or missing trigger can
    ///   never strand the league. This path does not read the price feed, so a broken feed
    ///   cannot deadlock it either.
    pub fn settle_and_reveal<'info>(mut ctx: Context<'info, Settle<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (live, close_at, feed) = {
            let l = &ctx.accounts.league;
            (l.status == Status::Live as u8, l.close_at, l.feed)
        };
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

    /// Creator schedules a polling crank that calls `settle_and_reveal` every 2 seconds, so
    /// settlement needs no off-chain bot. The scheduled call is a no-op until the hidden close.
    pub fn schedule_settle<'info>(ctx: Context<'info, ScheduleSettle<'info>>) -> Result<()> {
        let league = &ctx.accounts.league;
        require!(
            league.status == Status::AwaitingVrf as u8 || league.status == Status::Live as u8,
            ShroudError::WrongStatus
        );
        require!(
            ctx.remaining_accounts.len() == league.player_count as usize,
            ShroudError::BadEntries
        );
        let league_key = league.key();

        let mut metas = vec![
            AccountMeta::new(league_key, false),
            AccountMeta::new_readonly(ctx.accounts.price_feed.key(), false),
            AccountMeta::new(ctx.accounts.magic_context.key(), false),
            AccountMeta::new_readonly(ctx.accounts.magic_program.key(), false),
        ];
        for e in ctx.remaining_accounts {
            metas.push(AccountMeta::new(*e.key, false));
        }
        let settle_ix = Instruction {
            program_id: crate::ID,
            accounts: metas.clone(),
            data: anchor_lang::InstructionData::data(&crate::instruction::SettleAndReveal {}),
        };

        // Task ids are shared by every program on the validator: derive one from the league
        // key and round so it is unique to this league and round.
        let kb = league_key.to_bytes();
        let mut b = [0u8; 8];
        for (i, v) in kb.iter().enumerate() {
            b[i % 8] ^= *v;
        }
        b[7] &= 0x7f;
        let task_id = i64::from_le_bytes(b) ^ league.round as i64;

        const INTERVAL_MS: i64 = 2_000;
        let covered_secs = league.max_secs as i64 + SETTLE_WINDOW_SECS + 20;
        let iterations = covered_secs * 1000 / INTERVAL_MS;

        let ix_data = bincode::serialize(&MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs {
            task_id,
            execution_interval_millis: INTERVAL_MS,
            iterations,
            instructions: vec![settle_ix],
        }))
        .map_err(|_| error!(ShroudError::Overflow))?;

        let mut cpi_metas = vec![AccountMeta::new(ctx.accounts.payer.key(), true)];
        cpi_metas.extend(metas);
        let schedule_ix = Instruction::new_with_bytes(MAGIC_PROGRAM_ID, &ix_data, cpi_metas);

        let mut infos = vec![
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.league.to_account_info(),
            ctx.accounts.price_feed.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        ];
        infos.extend(ctx.remaining_accounts.iter().cloned());
        invoke_signed(&schedule_ix, &infos, &[])?;
        Ok(())
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

/// Shared tail of settle and abort: score (or not), advance the league, commit.
fn close_out<'info>(
    a: &mut Settle<'info>,
    remaining: &'info [AccountInfo<'info>],
    settle: Option<(i64, i64)>,
) -> Result<()> {
    let league_key = a.league.key();
    let count = a.league.player_count as usize;
    require!(remaining.len() == count, ShroudError::BadEntries);

    let round = a.league.round;
    let finishing = round + 1 == a.league.n_rounds;
    let mut prev: Option<Pubkey> = None;
    let mut best: Option<(i64, Pubkey)> = None;
    let mut infos: Vec<AccountInfo<'info>> = Vec::with_capacity(count + 1);
    infos.push(a.league.to_account_info());

    for acc in remaining {
        // Anchor checks owner and discriminator.
        let mut entry: Account<Entry> = Account::try_from(acc)?;
        require!(acc.is_writable, ShroudError::BadEntries);
        require_keys_eq!(entry.league, league_key, ShroudError::BadEntries);
        let expected = Pubkey::create_program_address(
            &[ENTRY_SEED, league_key.as_ref(), entry.player.as_ref(), &[entry.bump]],
            &crate::ID,
        )
        .map_err(|_| error!(ShroudError::BadEntries))?;
        require_keys_eq!(expected, *acc.key, ShroudError::BadEntries);
        // Strictly ascending keys: no duplicates, and the set equals player_count entries.
        if let Some(p) = prev {
            require!(*acc.key > p, ShroudError::BadEntries);
        }
        prev = Some(*acc.key);

        if let Some((price, _)) = settle {
            if entry.round != round {
                entry.reset_for_round(round);
            }
            let pnl = rating::pnl_bps(entry.side, entry.leverage, entry.entry_price, price);
            let total = (entry.ret_bps + pnl).clamp(-10_000, 1_000_000);
            entry.last_ret_bps = total;
            entry.rounds_scored += 1;
            entry.sum_ret_bps += total;
            entry.sum_sq_ret_bps += total * total;
            entry.rating =
                rating::rating(entry.rounds_scored, entry.sum_ret_bps, entry.sum_sq_ret_bps);
        }
        match best {
            Some((r, _)) if entry.rating <= r => {}
            // Entries are visited in ascending key order and only a strictly higher rating
            // replaces the leader, so ties go to the lowest entry key.
            _ => best = Some((entry.rating, entry.player)),
        }
        entry.exit(&crate::ID)?;
        infos.push(acc.clone());
    }

    {
        let league = &mut a.league;
        if let Some((price, time)) = settle {
            league.settle_price = price;
            league.settle_time = time;
        }
        league.round += 1;
        if finishing {
            league.status = Status::Finished as u8;
            if let Some((_, player)) = best {
                league.winner = player;
            }
        } else {
            league.status = Status::Between as u8;
        }
    }
    // Serialise before the commit CPI reads the accounts.
    a.league.exit(&crate::ID)?;

    // The league PDA pays for the commit and signs for itself, so no external signer (and no
    // keeper) is needed: any caller or crank can trigger settlement.
    let creator = a.league.creator;
    let id = a.league.id.to_le_bytes();
    let bump = [a.league.bump];
    let seeds: &[&[u8]] = &[LEAGUE_SEED, creator.as_ref(), &id, &bump];
    let builder = MagicIntentBundleBuilder::new(
        a.league.to_account_info(),
        a.magic_context.to_account_info(),
        a.magic_program.to_account_info(),
    );
    if finishing {
        builder.commit_and_undelegate(&infos).build_and_invoke_signed(&[seeds])?;
    } else {
        builder.commit(&infos).build_and_invoke_signed(&[seeds])?;
    }
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
    pub entry: Account<'info, Entry>,
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
pub struct InitLeaguePermission<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    /// CHECK: verified by the permission program; address pinned to the expected PDA
    #[account(mut, seeds = [PERMISSION_SEED, league.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
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
    pub entry: Account<'info, Entry>,
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

#[vrf]
#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut, constraint = payer.key() == league.creator @ ShroudError::NotCreator)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    /// CHECK: the ER VRF queue
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackClose<'info> {
    #[account(mut)]
    pub league: Account<'info, League>,
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
        mut,
        seeds = [ENTRY_SEED, league.key().as_ref(), player.key().as_ref()],
        bump = entry.bump
    )]
    pub entry: Account<'info, Entry>,
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
    /// CHECK: pinned to league.feed and owner-checked in the handler
    pub price_feed: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct ScheduleSettle<'info> {
    #[account(mut, constraint = payer.key() == league.creator @ ShroudError::NotCreator)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [LEAGUE_SEED, league.creator.as_ref(), &league.id.to_le_bytes()],
        bump = league.bump
    )]
    pub league: Account<'info, League>,
    /// CHECK: pinned to league.feed
    #[account(address = league.feed @ ShroudError::WrongFeed)]
    pub price_feed: UncheckedAccount<'info>,
}
