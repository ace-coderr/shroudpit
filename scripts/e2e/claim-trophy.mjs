// The winner of a finished league claims its trophy (an SPL token, supply 1), then the script
// verifies the token on-chain: supply, mint authority, owner and balance.
//   LEAGUE=<pubkey> KEYPAIR_DIR=/dir node scripts/e2e/claim-trophy.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { BASE_RPC, decode, explorerBase, loadKeypair, programFor, send } from './lib.mjs'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const programId = new PublicKey(idl.address)
const league = new PublicKey(process.env.LEAGUE)
const base = new Connection(BASE_RPC, 'confirmed')
const l = decode(programFor(idl, base, loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))), 'league', (await base.getAccountInfo(league)).data)
console.log('league status', l.status, '(4 = Finished) winner', l.winner.toBase58())

// the winner must be one of our local wallets
const wallets = readdirSync(process.env.KEYPAIR_DIR).filter((f) => /^shroudpit-(devnet|p\d)\.json$/.test(f)).map((f) => loadKeypair(join(process.env.KEYPAIR_DIR, f)))
const winner = wallets.find((w) => w.publicKey.equals(l.winner))
if (!winner) throw new Error('the winner is not one of the local wallets')

const mint = PublicKey.findProgramAddressSync([Buffer.from('trophy'), league.toBuffer()], programId)[0]
const prog = programFor(idl, base, winner)
const before = await base.getBalance(winner.publicKey)
const tx = await prog.methods.claimTrophy().accountsPartial({ winner: winner.publicKey, league }).transaction()
const sig = await send(base, tx, [winner])
const after = await base.getBalance(winner.publicKey)
console.log('claim_trophy:', explorerBase(sig))
console.log(`cost to the winner: ${((before - after) / 1e9).toFixed(5)} SOL`)

// verify what was minted
const info = await base.getParsedAccountInfo(mint)
const m = info.value.data.parsed.info
console.log('trophy mint', mint.toBase58(), '| supply', m.supply, '| decimals', m.decimals, '| mintAuthority', m.mintAuthority, '| freezeAuthority', m.freezeAuthority)
const toks = await base.getParsedTokenAccountsByOwner(winner.publicKey, { mint })
for (const t of toks.value) console.log('winner holds', t.account.data.parsed.info.tokenAmount.uiAmountString, 'in', t.pubkey.toBase58())

// a second claim must fail
try {
  await send(base, await prog.methods.claimTrophy().accountsPartial({ winner: winner.publicKey, league }).transaction(), [winner])
  console.log('SECOND CLAIM SUCCEEDED (bad)')
} catch (e) {
  console.log('second claim rejected, as expected:', e.message.slice(0, 80))
}
