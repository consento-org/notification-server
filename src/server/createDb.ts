import { createLockCb, FlexLockCb } from 'flexlock-cb'
import hyperdb, { HyperDbNode, HyperDb } from 'hyperdb'
import hyperswarm from 'hyperswarm'
import rimraf from 'rimraf'
import { exists } from '@consento/api/util'

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
  toggleSubscription: (pushToken: string, idHex: string, toggle: boolean, mainCb: (error: Error, success?: boolean) => void) => void
  list: (idHex: string, cb: (error: Error, idHexTokens?: string[]) => void) => void
  channelsByToken: (pushToken: string, cb: (error: Error, idsHex?: string[]) => void) => void
  reset: (cb: (error: Error) => void) => void
}

interface IOperationCount {
  change: (db: HyperDb<string, number>, entryHex: string, change: 1 | -1, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => void
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
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete locks[token]
      })
      locks[token] = lock
    }
    return lock
  }

  function DBCount (countPath: string, max: number): IOperationCount {
    if (max === 0) {
      return {
        change: (_: HyperDb<string, number>, _name: string, _number: number, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => {
          op(mainCb)
        }
      }
    }
    const change = (db: HyperDb<string, number>, entryHex: string, numChange: 1 | -1, op: (count: number, cb: (error?: Error) => void) => void, cb: (error: Error) => void): void => {
      const entryUseCountPath = `/${countPath}/${entryHex}`
      const entryUseCountLock = getLock(entryUseCountPath)
      entryUseCountLock(countLockCb => db.get(entryUseCountPath, (error: Error, countRaw: HyperDbNode[]) => {
        if (exists(error)) return countLockCb(error)
        let count = (0 in countRaw) ? countRaw[0].value : 0
        op(count, (error: Error): void => {
          if (exists(error)) return countLockCb(error)
          count += numChange
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
      change: (db: HyperDb<string, number>, entryHex: string, numChange: 1 | -1, op: (cb: (error?: Error) => void) => void, mainCb: (error?: Error) => void) => {
        change(db, entryHex, numChange, (count, cb) => {
          if (numChange === 1 && count > max) {
            return cb(new Error(`Too many relations: ${countPath}[${entryHex}]`))
          }
          if (numChange === -1 && count === 0) {
            return cb(new Error(`Invalid count: ${countPath}[${entryHex}] [${numChange.toString()}][${count.toString()}]`))
          }
          op(cb)
        }, mainCb)
      }
    }
  }
  function DBSet (setPath: string, count: IOperationCount): {
    toggle: (targetHex: string, entryHex: string, toggle: boolean, cb: (error: Error, changed?: boolean) => void) => void
    list: (targetHex: string, cb: (error: Error, sourceEntries?: string[]) => void) => void
  } {
    return {
      toggle (targetHex: string, entryHex: string, toggle: boolean, mainCb: (error: Error, changed?: boolean) => void) {
        getDb((error: Error, db: HyperDb<string, number>) => {
          if (exists(error)) {
            return mainCb(error)
          }
          const targetPath = `/${setPath}/${targetHex}/${entryHex}`
          log({ [toggle ? 'add' : 'remove']: targetPath })
          const lock = getLock(targetPath)
          lock(cb => {
            db.get(targetPath, (error: Error, data: HyperDbNode[]) => {
              if (exists(error)) return cb(error) // Error is passed on
              const inData = (0 in data)
              if (inData && toggle) return cb(null, false) // Already added
              if (!inData && !toggle) return cb(null, false) // Already deleted
              count.change(db, entryHex, toggle ? 1 : -1, (cb) => {
                toggle ? db.put(targetPath, 1, cb) : db.del(targetPath, cb)
              }, (error: Error) => {
                if (exists(error)) return cb(error)
                return cb(null, true)
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

  const tokensByChannel = DBSet('channels', DBCount('tokens', maxSubscriptions))
  const channelsByToken = DBSet('channelsByToken', DBCount('channelCount', 0))

  function toggleSubscription (pushToken: string, idHex: string, toggle: boolean, mainCb: (error: Error, success?: boolean) => void): void {
    const pushTokenHex = Buffer.from(pushToken).toString('hex')
    tokensByChannel.toggle(idHex, pushTokenHex, toggle, (channelError: Error, tokenChanged?: boolean) => {
      if (exists(channelError)) return mainCb(channelError)
      channelsByToken.toggle(pushTokenHex, idHex, toggle, (pushTokenError: Error, channelChanged?: boolean) => {
        if (exists(pushTokenError)) {
          return tokensByChannel.toggle(idHex, pushTokenHex, !toggle, (resetError: Error) => {
            if (exists(resetError)) {
              log({
                unlikelyToggleError: {
                  toggle,
                  channelError,
                  pushTokenError,
                  resetError
                }
              })
              return mainCb(resetError)
            }
            return mainCb(pushTokenError)
          })
        }
        mainCb(null, tokenChanged || channelChanged)
      })
    })
  }

  return {
    toggleSubscription,
    reset,
    channelsByToken (pushToken: string, cb: (error: Error, idsHex?: string[]) => void) {
      const pushTokenHex = Buffer.from(pushToken).toString('hex')
      channelsByToken.list(pushTokenHex, cb)
    },
    list (idHex: string, cb: (error: Error, pushTokens?: string[]) => void) {
      tokensByChannel.list(idHex, (error: Error, pushTokensHex: string[]) => {
        if (exists(error)) return cb(error)
        cb(null, pushTokensHex.map(pushTokenHex => Buffer.from(pushTokenHex, 'hex').toString()))
      })
    }
  }
}
