// Follow-up for 01-vrf: keep polling the league, and show the start_round logs and the queue.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { decode, loadKeypair, loadState, programFor, sleep, teeConnection } from './lib.mjs'

const idl = JSON.parse(readFileSync('program/target/idl/shroudpit.json', 'utf8'))
const creator = loadKeypair(join(process.env.KEYPAIR_DIR, 'shroudpit-devnet.json'))
const state = loadState()
const tee = await teeConnection(creator)
const prog = programFor(idl, tee, creator)
const league = new PublicKey(state.league)
const startSig = state.links.find((l) => l.label === 'start_round').sig

const tx = await tee.getTransaction(startSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
console.log('start_round logs:')
for (const l of tx?.meta?.logMessages ?? ['(no logs returned)']) console.log('  ', l)

const queue = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc')
const q0 = await tee.getAccountInfo(queue)
console.log('queue on TEE: owner', q0?.owner.toBase58(), 'len', q0?.data.length)

const minutes = Number(process.env.MINUTES ?? 3)
const end = Date.now() + minutes * 60_000
while (Date.now() < end) {
  const ai = await tee.getAccountInfo(league)
  const l = ai && decode(prog, 'league', ai.data)
  if (l && l.status === 2) {
    console.log('Live! close_at', l.closeAt.toString(), 'randomness', Buffer.from(l.randomness).toString('hex'))
    process.exit(0)
  }
  await sleep(5000)
}
const q1 = await tee.getAccountInfo(queue)
console.log('still status=1 after', minutes, 'min; queue data changed:', Buffer.compare(q0.data, q1.data) !== 0)
