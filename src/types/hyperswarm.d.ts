declare module 'hyperswarm' {
  import { Duplex } from 'stream'
  
  export interface JoinOptions {
    lookup?: boolean,
    announce?: boolean
  }
  
  type Handler = (socket: Duplex, details: any) => void
  
  class HyperSwarm {
    join (id: Buffer, joinOpts: JoinOptions): void
    on (type: 'connection', handler: Handler): void
    once (type: 'connection', handler: Handler): void
    addListener (type: 'connection', handler: Handler): void
    removeListener (type: 'connection', handler: Handler): void
  }
  
  export default function createHyperswarm (): HyperSwarm
}