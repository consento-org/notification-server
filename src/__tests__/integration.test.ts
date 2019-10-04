import { setup } from '@consento/crypto'
import { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { sodium } from '@consento/crypto/core/sodium'
import { IReceiver } from '@consento/api'
import { Notifications } from '@consento/api/notifications'
import { ExpoTransport } from '../client'
import { createDummyExpoToken } from '../server/__tests__/token-dummy'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync } from 'fs'
import { createApp, IExpoParts } from '../server/createApp'
import { createDb } from '../server/createDb'
import { IExpoTransportOptions } from '../client/types'
import { exists } from '../util/exists'

const { Sender } = setup(sodium)

describe('working api integration', () => {
  it('subscribe → submit → unsubscribe → submit', cb => {
    try {
      mkdirSync('.tmp')
    } catch (err) {}
    const dbPath = `.tmp/db-test-${Math.random().toString(32)}`
    mkdtempSync(dbPath)
    const db = createDb({
      path: dbPath,
      maxSubscriptions: 10,
      replicate: false,
      log: () => {}
    })
    db.reset((error: Error) => {
      if (exists(error)) return cb(error)
      const notificationsMock = new EventEmitter()
      const expoMock: IExpoParts = {
        chunkPushNotifications (messages: ExpoPushMessage[]) {
          return [messages]
        },
        async sendPushNotificationsAsync (messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
          const result: ExpoPushTicket[] = []
          for (const message of messages) {
            await (new Promise(resolve => {
              notificationsMock.emit('message', message)
              setImmediate(resolve)
            }))
          }
          return result
        }
      }
      const app = createApp({
        db,
        expo: expoMock,
        log: (info) => {
          // console.log(info)
        },
        logError: fail
      })
      const listener = app.listen(0, () => {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        (async (): Promise<void> => {
          let address = listener.address()
          if (typeof address !== 'string') {
            address = `http://localhost:${String(address.port)}`
          }
          const opts: IExpoTransportOptions = {
            address,
            // eslint-disable-next-line @typescript-eslint/require-await
            async getToken (): Promise<string> {
              return createDummyExpoToken()
            }
          }
          const sender = Sender.create()
          const receiver = sender.newReceiver()
          const message = 'Hello World'
          const transport = new ExpoTransport(opts)
          notificationsMock.addListener('message', transport.handleNotification)
          transport.on('error', fail)
          const client = new Notifications({ transport })
          client.on('error', fail)
          client.on('message', (receivedChannel: IReceiver, receivedMessage: any): void => {
            expect(receivedChannel).toBe(receiver)
            expect(receivedMessage).toBe(message)
            cb()
          })
          expect(await client.subscribe([receiver])).toBe(true)
          await client.send(sender, message)
        })()
      })
    })
  })
})
