import { createDb } from '../createDb'
import { mkdtempSync, mkdirSync } from 'fs'
try {
  mkdirSync('.tmp')
} catch (err) {}
const dbPath = '.tmp/db-test-' + Math.random().toString(32)
mkdtempSync(dbPath)

describe('database operations', () => {
  it('store,list,remove subscriptions', async () => new Promise((resolve) => {
    const counts = {
      subscribe: 0,
      unsubscribe: 0,
      count: 0
    }
    const log = (any: any): void => {
      if ('add' in any) counts.subscribe += 1
      if ('remove' in any) counts.unsubscribe += 1
      if ('count' in any) counts.count += 1
    }
    const db = createDb({
      log,
      path: dbPath,
      replicate: false,
      maxSubscriptions: 10
    })
    let order = 0
    db.subscribe('abcd', 'xyz', (error: Error, success: boolean) => {
      expect(error).toBe(null)
      expect(success).toBe(true)
      expect(order).toBe(0)
      order += 1
    })
    db.subscribe('abcd', 'xyz', (error: Error, success: boolean) => {
      expect(error).toBe(null) // no error
      expect(success).toBe(false) // second subscription doesnt
      expect(order).toBe(1)
      order += 1
      db.list('xyz', (error, data) => {
        expect(error).toBe(null) // no error
        expect(data).toEqual(['abcd']) // list has one entry after subscription
        db.unsubscribe('abcd', 'xyz', (error: Error, success: boolean) => {
          expect(error).toBe(null) // no error
          expect(success).toBe(true) // unsub worked
          expect(order).toBe(2)
          order += 1
        })
        db.unsubscribe('abcd', 'xyz', (error: Error, success: boolean) => {
          expect(error).toBe(null) // no error
          expect(success).toBe(false) // unsub failed
          expect(order).toBe(3)
          db.list('xyz', (error, data) => {
            expect(error).toBe(null) // no error
            expect(data).toEqual([]) // empty list now
            expect(counts).toEqual({
              subscribe: 2,
              unsubscribe: 2,
              count: 2
            }) // subscribe and counts are logged
            resolve()
          })
        })
      })
    })
  }))
  it('allows resetting the db', cb => {
    const db = createDb({
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      log: () => {},
      path: dbPath,
      replicate: false,
      maxSubscriptions: 10
    })
    db.subscribe('abc', 'xyz', (error: Error, success: boolean) => {
      expect(error).toBe(null)
      expect(success).toBe(true)
      db.reset((error: Error) => {
        expect(error).toBe(null)
        db.subscribe('abc', 'xyz', (error: Error, success: boolean) => {
          expect(error).toBe(null)
          expect(success).toBe(true)
          cb()
        })
      })
    })
  })
})
