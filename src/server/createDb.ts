import { createLockCb, FlexLockCb } from 'flexlock-cb'
import hyperdb, { HyperDbNode, HyperDb } from 'hyperdb'
import hyperswarm from 'hyperswarm'
import rimraf from 'rimraf'
import { exists } from '../util/exists'

function flatten<Type> (data: Type[][]): Type[] {
  return data.reduce((result, nodes) => result.concat(nodes), [])
}

export interface DBOptions {
  path: string
  log: (msg?: any) => void
  maxSubscriptions: number
  replicate: boolean
}

export interface DB {
  subscribe (pushToken: string, idHex: string, cb: (error: Error, success?: boolean) => void): void
  unsubscribe (pushToken: string, idHex: string, cb: (error: Error, success?: boolean) => void): void
  list (idHex: string, cb: (error: Error, idHexTokens?: string[]) => void): void
  reset (cb: (error: Error) => void): void
}

export function createDb ({ log, path, maxSubscriptions = 1000, replicate = false }: DBOptions): DB {
  const swarm = hyperswarm()

  const mainLock = createLockCb()
  let _db: HyperDb<string, number> = null

  function reset (cb: (error: Error) => void): void {
    mainLock(unlock => {
      if (_db !== null) {
        _db = null
        if (replicate) {
          return new Error('Can not sever connections yet')
        }
        // TODO: close the db!
      }
      rimraf(path, unlock)
    }, cb)
  }

  function getDb (cb: (error: Error, db: HyperDb<string, number>) => void): void {
    mainLock(unlock => {
      if (_db !== null) {
        return unlock(null, _db)
      }
      _db = hyperdb<string, number>(path, {
        keyEncoding: 'utf8',
        valueEncoding: 'json'
      })
      if (replicate) {
        _db.on('ready', () => {
          log({ replicating: _db.discoveryKey.toString('hex') })
          swarm.join(_db.discoveryKey, {
            lookup: true,
            announce: true
          })
          swarm.on('connection', (socket, details) => {
            log({ newPeer: details })
            const replication = _db.replicate()
            replication.pipe(socket).pipe(replication)
          })
        })
      }
      unlock(null, _db)
    }, cb)
  }

  const locks: { [key: string]: FlexLockCb } = {}

  function getLock (token: string): FlexLockCb {
    let lock = locks[token]
    if (lock === undefined) {
      lock = createLockCb(() => {
        delete locks[token]
      })
      locks[token] = lock
    }
    return lock
  }

  function subscribe (pushToken: string, idHex: string, mainCb: (error: Error, success?: boolean) => void): void {
    getDb((error: Error, db: HyperDb<string, number>) => {
      if (exists(error)) {
        return mainCb(error)
      }
      log({
        subscribe: {
          pushToken,
          idHex
        }
      })
      const pushTokenHex = Buffer.from(pushToken).toString('hex')
      const channelPath = `/channel/${idHex}/${pushTokenHex}`
      const lock = getLock(channelPath)
      lock(cb => {
        db.get(channelPath, (error: Error, data: HyperDbNode[]) => {
          if (exists(error)) return cb(error) // Error is passed on
          if (0 in data) return cb(null, false) // Already added
          const tokenPath = `/tokens/${pushTokenHex}`
          const tokenLock = getLock(tokenPath)
          tokenLock(tokenCb => db.get(tokenPath, (error: Error, countRaw: HyperDbNode[]) => {
            if (exists(error)) return tokenCb(error)
            let count = (0 in countRaw) ? countRaw[0].value : 0
            if (count > maxSubscriptions) {
              return tokenCb(new Error('Too many subscriptions'))
            }
            db.put(channelPath, 1, (error: Error) => {
              if (exists(error)) return tokenCb(error)
              count += 1
              db.put(tokenPath, count, (error: Error) => {
                log({
                  count: {
                    pushToken,
                    count
                  }
                })
                tokenCb(error, true)
              }) // TODO: on error: reduce subscriptions.
            })
          }), cb)
        })
      }, mainCb)
    })
  }

  function unsubscribe (pushToken: string, idHex: string, mainCb: (err: Error, success?: boolean) => void): void {
    getDb((error: Error, db: HyperDb<string, number>) => {
      if (exists(error)) {
        return mainCb(error)
      }
      log({
        unsubscribe: {
          pushToken,
          idHex
        }
      })
      const pushTokenHex = Buffer.from(pushToken).toString('hex')
      const channelPath = `/channel/${idHex}/${pushTokenHex}`
      const lock = getLock(channelPath)
      lock(cb => {
        db.get(channelPath, (error: Error, data: HyperDbNode[]) => {
          if (exists(error)) return cb(error) // Error is passed on
          if (!(0 in data)) return cb(null, false) // Already deleted
          const tokenPath = `/tokens/${pushTokenHex}`
          const tokenLock = getLock(tokenPath)
          tokenLock(tokenCb => db.get(tokenPath, (error: Error, countRaw: HyperDbNode[]) => {
            if (exists(error)) return tokenCb(error)
            let count = (0 in countRaw) ? countRaw[0].value : 0
            db.del(channelPath, (error: Error) => {
              if (exists(error)) return tokenCb(error)
              count -= 1
              db.put(tokenPath, count, (error: Error) => {
                log({
                  count: {
                    pushToken,
                    count
                  }
                })
                tokenCb(error, true)
              }) // TODO: on error: reduce subscriptions.
            })
          }), cb)
        })
      }, mainCb)
    })
  }

  return {
    subscribe,
    unsubscribe,
    reset,
    list (idHex: string, cb: (error: Error, idHexTokens: string[]) => void) {
      getDb((error: Error, db: HyperDb<string, number>) => {
        if (exists(error)) return cb(error, null)
        const prefix = `channel/${idHex}/`
        _db.list(prefix, (error: Error, data: HyperDbNode[][]) => {
          if (exists(error)) return cb(error, null)
          cb(null, flatten(data).map(node => Buffer.from(node.key.substr(prefix.length), 'hex').toString()))
        })
      })
    }
  }
}
