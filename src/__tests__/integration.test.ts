import { AppState } from 'react-native'
import { setup, IEncodable } from '@consento/crypto'
import { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { sodium } from '@consento/crypto/core/sodium'
import * as ExpoNotifications from 'expo-notifications'
import { Notifications, isSuccess } from '@consento/api/notifications'
import { ExpoTransport, EClientStatus } from '../client'
import { createDummyExpoToken } from '../server/__tests__/token-dummy'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync } from 'fs'
import { IExpoParts } from '../server/createApp'
import { createServer } from '../server/createServer'
import { createDb } from '../server/createDb'
import { IExpoTransportOptions } from '../client/types'
import { exists } from '../util/exists'

const { createReceiver } = setup(sodium)

const appStateCallbacks = new Set<() => {}>()
const mockAddListener = jest.fn((event, callback) => {
  expect(event).toBe('change')
  appStateCallbacks.add(callback)
})
jest.resetModules()
jest.doMock('react-native/Libraries/AppState/AppState', () => ({
  addEventListener: mockAddListener
}))

function changeState (appState: 'background' | 'active'): void {
  AppState.currentState = appState
  appStateCallbacks.forEach(entry => entry())
}

// eslint-disable-next-line @typescript-eslint/return-await
const wait = async (time: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, time))

describe('working api integration', () => {
  it('subscribe → submit → unsubscribe → submit → reset → submit', cb => {
    try {
      mkdirSync('.tmp')
    } catch (err) {}
    const dbPath = `.tmp/db-test-${Math.random().toString(32)}`
    mkdtempSync(dbPath)
    const db = createDb({
      path: dbPath,
      maxSubscriptions: 10,
      replicate: false,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
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
            result.push({ status: 'ok', id: 'ticket' })
          }
          return result
        }
      }
      const app = createServer({
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
            async getToken (): Promise<ExpoNotifications.ExpoPushToken> {
              return createDummyExpoToken()
            }
          }
          const { sender: senderA, receiver: receiverA } = await createReceiver()
          const { sender: senderB, receiver: receiverB } = await createReceiver()
          const message = 'Hello World'
          const transport = new ExpoTransport(opts)
          transport.on('error', fail)
          changeState('background')
          await transport.awaitState(EClientStatus.FETCH, 100)
          notificationsMock.addListener('message', transport.handleNotification)
          const client = new Notifications({ transport })
          const { afterSubscribe: receive } = await client.receive(receiverA)
          await Promise.all<any>([
            client.send(senderA, message),
            receive.then((receivedMessage: IEncodable) => {
              expect(receivedMessage).toBe(message)
            })
          ])
          expect(await receive)
          expect(await client.subscribe([receiverA, receiverB])).toEqual([true, true])
          const directMessage = 'Ping Pong'
          changeState('active')
          await transport.awaitState(EClientStatus.WEBSOCKET_OPEN)
          const { afterSubscribe: receiveThroughSocket } = await client.receive(receiverA)
          await client.send(senderA, directMessage)
          expect(await receiveThroughSocket).toBe(directMessage)
          expect(await client.unsubscribe([receiverA])).toEqual([false]) // the receiving of the message should have already unsubscribed receiverA
          expect(await client.reset([receiverA])).toEqual([true])
          let messageReceived = false
          client.processors.add((message) => {
            messageReceived = true
            if (isSuccess(message)) {
              expect(message.body).toBe('Post A')
            } else {
              fail(message)
            }
          })
          expect(await client.send(senderA, 'Post A')).toEqual(['ws::pass-through'])
          try {
            await client.send(senderB, 'Post B')
            fail('no error')
          } catch (err) {
            expect(err.code).toEqual('no-receivers')
          }
          await wait(10)
          expect(messageReceived).toBe(true)
          await client.reset([])
        })().then(() => cb(), cb)
      })
    })
  })
})
