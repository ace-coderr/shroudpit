import { Buffer } from 'buffer'

// web3.js and the Anchor client expect a global Buffer. This module must be imported first so the
// global exists before any dependency evaluates.
;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
