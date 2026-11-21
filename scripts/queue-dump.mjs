// Read-only: look for pending VRF requests from a given program in an ER's copy of the VRF queue.
//   node scripts/queue-dump.mjs <er-url> <program-id>
import { Connection, PublicKey } from '@solana/web3.js'

const [url, program] = process.argv.slice(2)
const QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc')
const c = new Connection(url, 'confirmed')
const ai = await c.getAccountInfo(QUEUE)
const data = ai.data
const prog = new PublicKey(program).toBuffer()
console.log(`queue len=${data.length}, header=${data.subarray(0, 16).toString('hex')}`)
let at = -1
let found = 0
while ((at = data.indexOf(prog, at + 1)) !== -1) {
  found++
  console.log(`  program id found at offset ${at}`)
  if (found === 1) {
    console.log('  surrounding 192 bytes (hex) from offset-64:')
    console.log('  ' + data.subarray(Math.max(0, at - 64), at + 128).toString('hex'))
  }
}
console.log(`occurrences of ${program}: ${found}`)
