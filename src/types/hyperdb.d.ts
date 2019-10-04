declare module 'hyperdb' {

  import { Duplex } from 'stream'
  
  type ReadyHandler = () => void
  
  export interface ReplicationOptions {
    // Not important
  }

  type Callback<Type> = (error: Error, data?: Type) => void


  export interface HyperDbNode {
    key: string
    value: number
  }
  
  export interface HyperDb<Key = Buffer, Value = Buffer> {

    path: string

    get (key: Key, cb: Callback<HyperDbNode[]>): void
    put (key: Key, value: Value, cb: Callback<HyperDbNode[]>): void
    list (prefix: string, cb: Callback<HyperDbNode[][]>): void
    del (key: Key, cb: Callback<void>): void

    readonly discoveryKey: Buffer

    on (type: 'ready', handler: ReadyHandler): void
    once (type: 'ready', handler: ReadyHandler): void
    addListener (type: 'ready', handler: ReadyHandler): void
    removeListener (type: 'ready', handler: ReadyHandler): void
    replicate(opts?: ReplicationOptions): Duplex
  }

  export type Encoding = 'binary' | 'utf8' | 'json'

  export interface HyperDbOptions {
    keyEncoding: Encoding,
    valueEncoding: Encoding
  }
  
  export default function createHyperdb<Key = Buffer, Value = Buffer>(path: string, options?: HyperDbOptions): HyperDb<Key, Value>
}
