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

interface IOperationCount {
  increment(db: HyperDb<string, number>, entryHex: string, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void): void
  decrement(db: HyperDb<string, number>, entryHex: string, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void): void
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

  function DBCount (countPath: string, max: number): IOperationCount {
    if (max === 0) {
      return {
        increment: (_: HyperDb<string, number>, __: string, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => {
          op(mainCb)
        },
        decrement: (_: HyperDb<string, number>, __: string, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => {
          op(mainCb)
        }
      }
    }
    const change = (db: HyperDb<string, number>, entryHex: string, change: number, op: (count: number, cb: (error?: Error) => void) => void, cb: (error: Error) => void): void => {
      const entryUseCountPath = `/${countPath}/${entryHex}`
      const entryUseCountLock = getLock(entryUseCountPath)
      entryUseCountLock(countLockCb => db.get(entryUseCountPath, (error: Error, countRaw: HyperDbNode[]) => {
        if (exists(error)) return countLockCb(error)
        let count = (0 in countRaw) ? countRaw[0].value : 0
        op(count, (error: Error): void => {
          if (exists(error)) return countLockCb(error)
          count += change
          db.put(entryUseCountPath, count, (error: Error) => {
            if (exists(error)) return countLockCb(error)
            log({
              count: {
                countPath,
                entryHex,
                count
              }
            })
            countLockCb(error, true)
          }) // TODO: on error: reduce relations.
        })
      }), cb)
    }
    return {
      increment: (db: HyperDb<string, number>, entryHex: string, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => {
        change(db, entryHex, 1, (count, cb) => {
          if (count > max) {
            return cb(new Error(`Too many relations: ${countPath}[${entryHex}]`))
          }
          op(cb)
        }, mainCb)
      },
      decrement: (db: HyperDb<string, number>, entryHex: string, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => {
        change(db, entryHex, -1, (count, cb) => {
          if (count === 0) {
            return cb(new Error(`Invalid count: ${countPath}[${entryHex}]`))
          }
          op(cb)
        }, mainCb)
      }
    }
  }
  function DBSet (setPath: string, count: IOperationCount): {
    add (targetHex: string, entryHex: string, cb: (error: Error, added?: boolean) => void): void
    remove (targetHex: string, entryHex: string, cb: (error: Error, removed?: boolean) => void): void
    list (targetHex: string, cb: (error: Error, sourceEntries?: string[]) => void): void
  } {
    return {
      add (targetHex: string, entryHex: string, mainCb: (error: Error, added?: boolean) => void) {
        getDb((error: Error, db: HyperDb<string, number>) => {
          if (exists(error)) {
            return mainCb(error)
          }
          log({
            add: {
              setPath,
              targetHex,
              entryHex
            }
          })
          const targetPath = `/${setPath}/${targetHex}/${entryHex}`
          const lock = getLock(targetPath)
          lock(cb => {
            db.get(targetPath, (error: Error, data: HyperDbNode[]) => {
              if (exists(error)) return cb(error) // Error is passed on
              if (0 in data) return cb(null, false) // Already adde
              count.increment(db, entryHex, (cb) => db.put(targetPath, 1, cb), (error: Error) => {
                if (exists(error)) return cb(error)
                return cb(null, true)
              })
            })
          }, mainCb)
        })
      },
      remove (targetHex: string, entryHex: string, mainCb: (error: Error, removed?: boolean) => void) {
        getDb((error: Error, db: HyperDb<string, number>) => {
          if (exists(error)) {
            return mainCb(error)
          }
          log({
            remove: {
              setPath,
              targetHex,
              entryHex
            }
          })
          const targetPath = `/${setPath}/${targetHex}/${entryHex}`
          const lock = getLock(targetPath)
          lock(cb => {
            db.get(targetPath, (error: Error, data: HyperDbNode[]) => {
              if (exists(error)) return cb(error) // Error is passed on
              if (!(0 in data)) return cb(null, false) // Already deleted
              count.decrement(db, entryHex, (cb) => db.del(targetPath, cb), (error: Error) => {
                if (exists(error)) return cb(error)
                cb(null, true)
              })
            })
          }, mainCb)
        })
      },
      list (idHex: string, cb: (error: Error, pushTokensHex: string[]) => void) {
        getDb((error: Error, db: HyperDb<string, number>) => {
          if (exists(error)) return cb(error, null)
          const prefix = `${setPath}/${idHex}/`
          db.list(prefix, (error: Error, data: HyperDbNode[][]) => {
            if (exists(error)) return cb(error, null)
            cb(null, flatten(data).map(node => node.key.substr(prefix.length)))
          })
        })
      }
    }
  }

  const tokenCount = DBCount('tokens', maxSubscriptions)
  const subscriptions = DBSet('channels', tokenCount)

  function subscribe (pushToken: string, idHex: string, mainCb: (error: Error, success?: boolean) => void): void {
    const pushTokenHex = Buffer.from(pushToken).toString('hex')
    subscriptions.add(idHex, pushTokenHex, mainCb)
  }

  function unsubscribe (pushToken: string, idHex: string, mainCb: (err: Error, success?: boolean) => void): void {
    const pushTokenHex = Buffer.from(pushToken).toString('hex')
    subscriptions.remove(idHex, pushTokenHex, mainCb)
  }

  return {
    subscribe,
    unsubscribe,
    reset,
    list (idHex: string, cb: (error: Error, pushTokens?: string[]) => void) {
      subscriptions.list(idHex, (error: Error, pushTokensHex: string[]) => {
        if (exists(error)) return cb(error)
        cb(null, pushTokensHex.map(pushTokenHex => Buffer.from(pushTokenHex, 'hex').toString()))
      })
    }
  }
}
