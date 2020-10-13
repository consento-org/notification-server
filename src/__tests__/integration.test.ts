import { AppState } from 'react-native'
import { setup } from '@consento/crypto'
import { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { sodium } from '@consento/crypto/core/sodium'
import * as ExpoNotifications from 'expo-notifications'
import { Notifications, isSuccess } from '@consento/api/notifications'
import { ExpoTransport, EClientStatus } from '../client'
import { createDummyExpoToken } from '../server/__tests__/token-dummy'
import { mkdirSync, mkdtempSync } from 'fs'
import { IExpoParts } from '../server/createApp'
import { createServer, INotificationServerListener } from '../server/createServer'
import { createDb } from '../server/createDb'
import { INotificationControl, INotificationsTransport, INotificationProcessor } from '@consento/api'
import { exists } from '@consento/api/util'

const { createReceiver } = setup(sodium)

const appStateCallbacks = new Set<() => {}>()
const mockAddListener = jest.fn((event, callback) => {
  expect(event).toBe('change')
  appStateCallbacks.add(callback)
})
jest.resetModules()
jest.doMock('react-native/Libraries/AppState/AppState', () => ({
  addEventListener: mockAddListener,
  removeEventListener: jest.fn(() => {})
}))

function changeState (appState: 'background' | 'active'): void {
  AppState.currentState = appState
  appStateCallbacks.forEach(entry => entry())
}

// eslint-disable-next-line @typescript-eslint/return-await
const wait = async (time: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, time))

describe('working api integration', () => {
  it('subscribe → submit → unsubscribe → submit → reset → submit', async () => {
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
    await new Promise((resolve, reject) => db.reset((error) => exists(error) ? reject(error) : resolve()))
    const handlerList: Array<(notification: any) => Promise<boolean>> = []
    const expoMock: IExpoParts = {
      chunkPushNotifications (messages: ExpoPushMessage[]) {
        return [messages]
      },
      async sendPushNotificationsAsync (messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
        const result: ExpoPushTicket[] = []
        for (const message of messages) {
          await (async () => {
            for (const handler of handlerList) {
              await handler(message.data)
            }
          })()
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
    const listener = await (new Promise<INotificationServerListener>(
      resolve => { const listener = app.listen(0, () => resolve(listener)) }
    ))
    let address = listener.address()
    if (typeof address !== 'string') {
      address = `http://localhost:${String(address?.port)}`
    }
    const opts = {
      address,
      // eslint-disable-next-line @typescript-eslint/require-await
      async getToken (): Promise<ExpoNotifications.ExpoPushToken> {
        return createDummyExpoToken()
      }
    }
    const { sender: senderA, receiver: receiverA } = await createReceiver()
    const { sender: senderB, receiver: receiverB } = await createReceiver()
    const message = 'Hello World'
    let transport: ExpoTransport | undefined
    changeState('background')
    const client = new Notifications({
      transport: (control: INotificationControl): INotificationsTransport => {
        transport = new ExpoTransport({
          ...opts,
          control: {
            ...control,
            error: fail
          }
        })
        handlerList.push(transport.handleNotification)
        return transport
      }
    })
    await transport?.awaitState(EClientStatus.FETCH, { timeout: 100 })
    const { afterSubscribe: receive } = await client.receive(receiverA)
    await Promise.all<any>([
      client.send(senderA, message),
      receive.then(receivedMessage => {
        expect(receivedMessage).toBe(message)
      })
    ])
    await expect(receive).resolves.toBe(message)
    await expect(client.subscribe([receiverA, receiverB])).resolves.toEqual([true, true])
    const directMessage = 'Ping Pong'
    changeState('active')
    await transport?.awaitState(EClientStatus.WEBSOCKET)
    const { afterSubscribe: receiveThroughSocket } = await client.receive(receiverA)
    await client.send(senderA, directMessage)
    await expect(receiveThroughSocket).resolves.toBe(directMessage)
    await expect(client.unsubscribe([receiverA])).resolves.toEqual([false]) // the receiving of the message should have already unsubscribed receiverA
    await expect(client.reset([receiverA])).resolves.toEqual([true])
    let messageReceived = false
    const processor: INotificationProcessor = async (message): Promise<boolean> => {
      messageReceived = true
      if (isSuccess(message)) {
        expect(message.body).toBe('Post A')
      } else {
        fail(message)
      }
      return true
    }
    client.processors.add(processor)
    await expect(client.send(senderA, 'Post A')).resolves.toEqual(['ws::pass-through'])
    try {
      await client.send(senderB, 'Post B')
      fail('no error')
    } catch (err) {
      expect(err.code).toEqual('no-receivers')
    }
    await wait(10)
    expect(messageReceived).toBe(true)
    await client.reset([])
    await transport?.destroy()
    await new Promise((resolve, reject) => listener.close(error => exists(error) ? reject(error) : resolve()))
  })
})
