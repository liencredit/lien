use anchor_lang::prelude::*;

// Replace with the real program id after `anchor keys sync` (or `anchor keys list`).
declare_id!("Lien1111111111111111111111111111111111111111");

#[program]
pub mod lien_score {
    use super::*;

    /// One-time setup: create the global config holding the authority allowed to
    /// write scores (the LIEN scoring service signer).
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Rotate the writing authority. Only the current authority may call this.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        Ok(())
    }

    /// Upsert an agent's LIEN score into its per-agent PDA. Gated to the config
    /// authority. `agent` is the 8004 asset pubkey (also the PDA seed).
    pub fn set_score(
        ctx: Context<SetScore>,
        agent: Pubkey,
        score: u16,
        band: u8,
        status: u8,
    ) -> Result<()> {
        require!((300..=850).contains(&score), LienError::ScoreOutOfRange);
        require!(band <= 4, LienError::InvalidBand); // poor..excellent
        require!(status <= 2, LienError::InvalidStatus); // good_standing/on_watch/defaulted

        let s = &mut ctx.accounts.score;
        s.agent = agent;
        s.score = score;
        s.band = band;
        s.status = status;
        s.updated_at = Clock::get()?.unix_timestamp;
        s.bump = ctx.bumps.score;

        emit!(ScoreUpdated {
            agent,
            score,
            band,
            status,
            updated_at: s.updated_at,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::SIZE,
        seeds = [Config::SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    #[account(
        mut,
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = authority @ LienError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct SetScore<'info> {
    #[account(
        seeds = [Config::SEED],
        bump = config.bump,
        has_one = authority @ LienError::Unauthorized
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ScoreAccount::SIZE,
        seeds = [ScoreAccount::SEED, agent.as_ref()],
        bump
    )]
    pub score: Account<'info, ScoreAccount>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const SEED: &'static [u8] = b"config";
    pub const SIZE: usize = 32 + 1;
}

#[account]
pub struct ScoreAccount {
    /// 8004 asset pubkey this score belongs to.
    pub agent: Pubkey,
    /// 300–850.
    pub score: u16,
    /// 0=poor,1=fair,2=good,3=very_good,4=excellent.
    pub band: u8,
    /// 0=good_standing,1=on_watch,2=defaulted.
    pub status: u8,
    /// Unix seconds of last write.
    pub updated_at: i64,
    pub bump: u8,
}

impl ScoreAccount {
    pub const SEED: &'static [u8] = b"lien-score";
    pub const SIZE: usize = 32 + 2 + 1 + 1 + 8 + 1;
}

#[event]
pub struct ScoreUpdated {
    pub agent: Pubkey,
    pub score: u16,
    pub band: u8,
    pub status: u8,
    pub updated_at: i64,
}

#[error_code]
pub enum LienError {
    #[msg("score must be between 300 and 850")]
    ScoreOutOfRange,
    #[msg("band must be 0..=4")]
    InvalidBand,
    #[msg("status must be 0..=2")]
    InvalidStatus,
    #[msg("signer is not the configured authority")]
    Unauthorized,
}
