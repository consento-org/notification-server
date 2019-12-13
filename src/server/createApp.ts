import { randomBytes } from 'crypto'
import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { sodium } from '@consento/crypto/core/sodium'
import { IEncryptedMessage } from '@consento/crypto/core/types'
import { DB } from './createDb'
import WebSocket from 'ws'

async function verifyRequest (idBase64: string, message: IEncryptedMessage): Promise<boolean> {
  const id = Buffer.from(idBase64, 'base64')
  if (!await sodium.verify(id, message.signature, message.body)) {
    throw Object.assign(new Error('invalid-signature'), { httpStatus: 400 })
  }
  return true
}

async function asyncSeries<Entry, Result> (
  entries: Entry[],
  op: (entry: Entry, cb: (error: Error | null, result: Result) => void) => void
): Promise<Result[]> {
  return new Promise <Result[]>((resolve, reject) => _asyncSeries(entries, op, resolve, reject, []))
}

function _asyncSeries<Entry, Result> (
  entries: Entry[],
  op: (entry: Entry, cb: (error: Error | null, result: Result) => void) => void,
  resolve: (result: Result[]) => void,
  reject: (error: Error) => void,
  result: Result[]
): void {
  if (entries === undefined) {
    return resolve(result)
  }
  if (entries.length === 0) {
    return resolve(result)
  }
  const entry = entries.shift()
  op(entry, (error, partResult) => {
    if (error !== null && error !== undefined) {
      return reject(error)
    }
    result.push(partResult)
    _asyncSeries(entries, op, resolve, reject, result)
  })
}

export interface IProcessedToken {
  pushToken: string
  idBase64: string
}

async function processTokens (log: (msg: any) => void, query: { [key: string]: any }): Promise<IProcessedToken[]> {
  const { pushToken, idsBase64: idsBase64Raw, signaturesBase64: signaturesBase64Raw } = query
  if (!Expo.isExpoPushToken(pushToken)) {
    log({ invalidRequest: { invalidPushToken: pushToken } })
    throw Object.assign(new Error('invalid-push-token'), { httpCode: 400 })
  }

  const idsBase64 = idsBase64Raw !== undefined ? idsBase64Raw.split(';') : []
  const signaturesBase64 = signaturesBase64Raw !== undefined ? signaturesBase64Raw.split(';') : []
  const pushTokenBuffer = Buffer.from(pushToken)
  let index = 0
  const processedTokens = []
  for (const idBase64 of idsBase64) {
    if (index >= signaturesBase64.length) {
      return []
    }
    const signature = signaturesBase64[index]
    if (!await sodium.verify(Buffer.from(idBase64, 'base64'), Buffer.from(signature, 'base64'), pushTokenBuffer)) {
      log({ invalidRequest: { invalidSignature: index } })
      throw Object.assign(new Error(`invalid-signature[${index}]`), { httpCode: 400 })
    }
    processedTokens.push({
      pushToken,
      idBase64
    })
    index += 1
  }
  return processedTokens
}

export interface AppOptions {
  db: DB
  log: (msg?: any) => void
  logError: (msg?: any) => void
  expo?: IExpoParts
}

export interface IExpoParts {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>
  // getPushNotificationReceiptsAsync(receiptIds: ExpoPushReceiptId[]): Promise<{
  //     [id: string]: ExpoPushReceipt;
  // }>;
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][]
}

export interface EncryptedMessageBase64 {
  idBase64: string
  bodyBase64: string
  signatureBase64: string
}

export interface IApp {
  subscribe (query: any, session?: string, socket?: WebSocket): Promise<boolean[]>
  unsubscribe (query: any): Promise<boolean[]>
  send (query: any): Promise<string[]>
  closeSocket (session: string): boolean
}

function split <T> (input: T[], condition: (entry: T) => boolean): [T[], T[]] {
  const a = []
  const b = []
  for (const entry of input) {
    if (condition(entry)) {
      a.push(entry)
    } else {
      b.push(entry)
    }
  }
  return [a, b]
}

interface IWebSocketSession {
  pushTokensHex: Set<string>
  socket: WebSocket
}

export function createApp ({ db, log, logError, expo }: AppOptions): IApp {
  if (expo === undefined) {
    expo = new Expo({})
  }

  const webSocketsByPushToken: { [pushToken: string]: WebSocket } = {}
  const webSocketsBySession: { [session: string]: IWebSocketSession } = {}

  async function sendMessage (idBase64: string, message: EncryptedMessageBase64): Promise<string[]> {
    const rid = randomBytes(8)
    const idHex = Buffer.from(idBase64, 'base64').toString('hex')
    log({
      send: {
        idHex,
        message,
        rid: rid.toString('hex')
      }
    })

    const pushTokensHex = await new Promise <string[]>((resolve, reject) => db.list(idHex, (error: Error, pushTokensHex: string[]) => {
      if (error !== null && error !== undefined) {
        return reject(error)
      }
      resolve(pushTokensHex)
    }))

    const messages = pushTokensHex.map((pushToken): ExpoPushMessage => {
      return {
        to: pushToken,
        sound: 'default',
        body: 'Secure message.',
        ttl: 10000,
        priority: 'high',
        data: message
      }
    })

    const [expoMessages, webSocketMessages] = split(messages, (message: ExpoPushMessage): boolean => {
      return webSocketsByPushToken[String(message.to)] === undefined
    })

    const expoPromises = expo
      .chunkPushNotifications(expoMessages)
      .map(async (messagesChunk): Promise<ExpoPushTicket[]> => {
        try {
          return await expo.sendPushNotificationsAsync(messagesChunk)
        } catch (error) {
          logError({
            type: 'send-error',
            target: messages.map(message => message.to),
            rid,
            error
          })
          return null
        }
      })

    const webSocketPromises = webSocketMessages
      // eslint-disable-next-line @typescript-eslint/require-await
      .map(async (message) => new Promise <ExpoPushTicket[]>((resolve, reject) => {
        const socket = webSocketsByPushToken[String(message.to)]
        socket.send(JSON.stringify({
          type: 'message',
          body: message.data
        }), (error: Error) => {
          if (error !== null && error !== undefined) {
            return reject(error)
          }
          resolve(null)
        })
      }).catch(async (error: Error) => {
        logError(error)
        return expo.sendPushNotificationsAsync([message])
      }))

    const chunkedResult = await Promise.all(
      expoPromises.concat(webSocketPromises)
    )
    return chunkedResult.filter(Boolean).reduce((all: string[], partial) => {
      for (const result of partial) {
        if (result.status === 'ok') {
          all.push(result.id)
          continue
        }
        logError({
          type: 'submission-error',
          error: result
        })
      }
      return all
    }, [])
  }

  const registerSocket = (pushTokenHex: string, session: string, socket: WebSocket): boolean => {
    webSocketsByPushToken[pushTokenHex] = socket
    let info = webSocketsBySession[session]
    if (info === undefined) {
      info = {
        pushTokensHex: new Set(),
        socket
      }
      webSocketsBySession[session] = info
    }
    if (info.pushTokensHex.has(pushTokenHex)) {
      info.pushTokensHex.add(pushTokenHex)
      return true
    }
    return false
  }

  return {
    async subscribe (query: any, session?: string, socket?: WebSocket): Promise<boolean[]> {
      const entries = await processTokens(log, query)
      if (socket !== undefined) {
        const foundTokens = new Set<string>()
        for (const entry of entries) {
          if (!foundTokens.has(entry.pushToken)) {
            foundTokens.add(entry.pushToken)
            registerSocket(entry.pushToken, session, socket)
          }
        }
      }
      return asyncSeries <IProcessedToken, boolean>(entries, ({ pushToken, idBase64 }, cb) => db.subscribe(pushToken, Buffer.from(idBase64, 'base64').toString('hex'), cb))
    },
    async unsubscribe (query: any): Promise<boolean[]> {
      const entries = await processTokens(log, query)
      return asyncSeries <IProcessedToken, boolean>(entries, ({ pushToken, idBase64 }, cb) => db.subscribe(pushToken, Buffer.from(idBase64, 'base64').toString('hex'), cb))
    },
    closeSocket (session: string): boolean {
      const info = webSocketsBySession[session]
      if (info !== undefined) {
        return false
      }
      delete webSocketsBySession[session]
      for (const pushTokenHex of info.pushTokensHex) {
        delete webSocketsByPushToken[pushTokenHex]
      }
      return true
    },
    async send (query: any): Promise<string[]> {
      const { idBase64, bodyBase64, signatureBase64 } = query
      const messageBase64 = {
        idBase64,
        bodyBase64,
        signatureBase64
      }
      const message = {
        body: Buffer.from(bodyBase64, 'base64'),
        signature: Buffer.from(signatureBase64, 'base64')
      }
      await verifyRequest(idBase64, message)
      return sendMessage(idBase64, messageBase64)
    }
  }
}
