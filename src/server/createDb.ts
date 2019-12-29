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
  function DBSet (setPath: string, countPath: string, max: number): {
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
              countPath,
              targetHex,
              entryHex
            }
          })
          const targetPath = `/${setPath}/${targetHex}/${entryHex}`
          const lock = getLock(targetPath)
          lock(cb => {
            db.get(targetPath, (error: Error, data: HyperDbNode[]) => {
              if (exists(error)) return cb(error) // Error is passed on
              if (0 in data) return cb(null, false) // Already added
              if (max === 0) {
                return db.put(targetPath, 1, (error: Error) => {
                  if (exists(error)) return cb(error)
                  cb(null, true)
                })
              }
              const entryUseCountPath = `/${countPath}/${entryHex}`
              const entryUseCountLock = getLock(entryUseCountPath)
              entryUseCountLock(countLockCb => db.get(entryUseCountPath, (error: Error, countRaw: HyperDbNode[]) => {
                if (exists(error)) return countLockCb(error)
                let count = (0 in countRaw) ? countRaw[0].value : 0
                if (count > max) {
                  return countLockCb(new Error(`Too many relations: ${setPath} ← ${countPath}[${entryHex}]`))
                }
                db.put(targetPath, 1, (error: Error) => {
                  if (exists(error)) return countLockCb(error)
                  count += 1
                  db.put(entryUseCountPath, count, (error: Error) => {
                    if (exists(error)) return countLockCb(error)
                    log({
                      count: {
                        countPath,
                        targetHex,
                        count
                      }
                    })
                    countLockCb(error, true)
                  }) // TODO: on error: reduce relations.
                })
              }), cb)
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
              countPath,
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
              if (max === 0) {
                return db.del(targetPath, (error: Error) => {
                  if (exists(error)) return cb(error)
                  cb(null, true)
                })
              }
              const entryUseCountPath = `/${countPath}/${entryHex}`
              const entryUseCountLock = getLock(entryUseCountPath)
              entryUseCountLock(tokenCb => db.get(entryUseCountPath, (error: Error, countRaw: HyperDbNode[]) => {
                if (exists(error)) return tokenCb(error)
                let count = (0 in countRaw) ? countRaw[0].value : 0
                db.del(targetPath, (error: Error) => {
                  if (exists(error)) return tokenCb(error)
                  count -= 1
                  db.put(entryUseCountPath, count, (error: Error) => {
                    log({
                      count: {
                        countPath,
                        targetHex,
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

  const subscriptions = DBSet('channels', 'tokens', maxSubscriptions)

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
