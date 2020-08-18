/* eslint-disable @typescript-eslint/no-throw-literal */
import { randomBytes } from 'crypto'
import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { sodium } from '@consento/crypto/core/sodium'
import { IEncryptedMessage } from '@consento/crypto/core/types'
import { DB } from './createDb'
import WebSocket from 'ws'
import { exists } from '@consento/api/util'
import compareVersions from 'compare-versions'
import { VERSION } from '../package'

async function verifyRequest (idBase64: string, message: IEncryptedMessage): Promise<boolean> {
  const id = Buffer.from(idBase64, 'base64')
  if (!await sodium.verify(id, message.signature, message.body)) {
    throw Object.assign(new Error('invalid-signature'), { httpStatus: 400 })
  }
  return true
}

async function asyncSeries<Entry, Result> (
  entries: Entry[],
  op: (entry: Entry, cb: (error: Error | null, result?: Result) => void) => void
): Promise<Result[]> {
  // eslint-disable-next-line @typescript-eslint/return-await
  return new Promise <Result[]>((resolve, reject) => _asyncSeries(entries, op, resolve, reject, []))
}

function toMap (list: string[]): { [entry: string]: boolean } {
  return list.reduce((result: { [entry: string]: boolean }, entry) => {
    result[entry] = true
    return result
  }, {})
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
  idsBase64: string[]
}

async function processTokens (log: (msg: any) => void, query: { [key: string]: any }): Promise<IProcessedToken> {
  const { pushToken, idsBase64: idsBase64Raw, signaturesBase64: signaturesBase64Raw } = query
  if (!Expo.isExpoPushToken(pushToken)) {
    log({ invalidRequest: { invalidPushToken: pushToken } })
    throw Object.assign(new Error('invalid-push-token'), { httpCode: 400 })
  }
  const idsBase64 = idsBase64Raw !== undefined ? idsBase64Raw.split(';').filter(Boolean) : []
  const signaturesBase64 = signaturesBase64Raw !== undefined ? signaturesBase64Raw.split(';').filter(Boolean) : []
  const pushTokenBuffer = Buffer.from(pushToken)
  let index = 0
  if (idsBase64.length !== signaturesBase64.length) {
    throw Object.assign(new Error(`unequal-amount-of-signatures[${String(idsBase64.length)} != ${String(signaturesBase64.length)}]`), { httpCode: 400 })
  }
  for (const idBase64 of idsBase64) {
    const signature = signaturesBase64[index]
    try {
      if (!await sodium.verify(Buffer.from(idBase64, 'base64'), Buffer.from(signature, 'base64'), pushTokenBuffer)) {
        log({ invalidRequest: { invalidSignature: index } })
        throw Object.assign(new Error(`invalid-signature[${index.toString()}]`), { httpCode: 400 })
      }
    } catch (error) {
      throw Object.assign(new Error(`invalid-signature-fatal[${index.toString()}]`), { httpCode: 400, reason: error.message })
    }
    index += 1
  }
  return { pushToken, idsBase64 }
}

export interface AppOptions {
  db: DB
  log: (msg?: any) => void
  logError: (msg?: any) => void
  expo?: IExpoParts
}

export interface IExpoParts {
  sendPushNotificationsAsync: (messages: ExpoPushMessage[]) => Promise<ExpoPushTicket[]>
  // getPushNotificationReceiptsAsync: (receiptIds: ExpoPushReceiptId[]) => Promise<{
  //     [id: string]: ExpoPushReceipt;
  // }>;
  chunkPushNotifications: (messages: ExpoPushMessage[]) => ExpoPushMessage[][]
}

export interface EncryptedMessageBase64 {
  idBase64: string
  bodyBase64: string
  signatureBase64: string
}

export interface IApp {
  subscribe: (query: any, session?: string, socket?: WebSocket) => Promise<boolean[]>
  unsubscribe: (query: any) => Promise<boolean[]>
  reset: (query: any, session?: string, socket?: WebSocket) => Promise<boolean[]>
  send: (query: any) => Promise<string[]>
  compatible: (query: any) => Promise<boolean>
  closeSocket: (session: string) => boolean
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

interface IExpoErrorCode {
  code: string
}

function isCodedError (ticket: any): ticket is IExpoErrorCode {
  return ticket.code !== null
}

export function createApp ({ db, log, logError, expo }: AppOptions): IApp {
  if (expo === undefined) {
    expo = new Expo({})
  }

  const webSocketsByPushToken: { [pushToken: string]: { socket: WebSocket, session: string } } = {}
  const webSocketsBySession: { [session: string]: IWebSocketSession } = {}

  async function sendExpo (messageId: string, messagesChunk: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    try {
      return await expo.sendPushNotificationsAsync(messagesChunk) // TODO: Deal with the responses from expo for each token
    } catch (error) {
      logError({
        type: 'send-error',
        target: messagesChunk.map(message => message.to),
        messageId,
        code: error.code,
        error: error.message,
        stack: error.stack
      })
      return messagesChunk.map<{ status: 'error', message: string }>(() => ({ status: 'error', message: String(error.message), code: error.code }))
    }
  }

  const closeSocket = (session: string): boolean => {
    const info = webSocketsBySession[session]
    if (info === undefined) {
      return false
    }
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete webSocketsBySession[session]
    for (const pushTokenHex of info.pushTokensHex) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete webSocketsByPushToken[pushTokenHex]
    }
    return true
  }

  async function sendMessage (idBase64: string, message: EncryptedMessageBase64): Promise<string[]> {
    const messageId = randomBytes(8).toString('hex')
    const idHex = Buffer.from(idBase64, 'base64').toString('hex')

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

    const closeSocket = (session: string): boolean => {
      const info = webSocketsBySession[session]
      if (info === undefined) {
        return false
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete webSocketsBySession[session]
      for (const pushTokenHex of info.pushTokensHex) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete webSocketsByPushToken[pushTokenHex]
      }
      return true
    }

    const [expoMessages, webSocketMessages] = split(messages, (message: ExpoPushMessage): boolean => {
      const socket = webSocketsByPushToken[String(message.to)]
      if (socket === undefined) {
        return true
      }
      if (socket.socket.readyState > 1) {
        closeSocket(socket.session)
        return true
      }
      return false
    })

    const expoPromises = expo
      .chunkPushNotifications(expoMessages)
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      .map(messagesChunk => sendExpo(messageId, messagesChunk))

    const webSocketPromises = webSocketMessages
      // eslint-disable-next-line @typescript-eslint/return-await
      .map(async (message) => new Promise <ExpoPushTicket[]>((resolve, reject) => {
        const { socket, session } = webSocketsByPushToken[String(message.to)]
        log({
          send: {
            idHex,
            message,
            messageId,
            session,
            via: 'websocket'
          }
        })
        socket.send(JSON.stringify({
          type: 'message',
          body: message.data
        }), (error: Error) => {
          if (error !== null && error !== undefined) {
            socket.close()
            closeSocket(session)
            return reject(error)
          }
          resolve([{ status: 'ok', id: 'ws::pass-through' }])
        })
      }).catch(async (error: Error) => {
        logError({
          type: 'socket-error',
          error
        })
        // eslint-disable-next-line @typescript-eslint/return-await
        return sendExpo(messageId, [message])
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
        if (isCodedError(result)) {
          all.push(`error:${result.code}`)
        } else {
          all.push('error')
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
    log({ registerWebSocket: { session, pushTokenHex } })
    webSocketsByPushToken[pushTokenHex] = {
      socket, session
    }
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
      const { pushToken, idsBase64 } = await processTokens(log, query)
      if (socket !== undefined) {
        registerSocket(pushToken, session, socket)
      }
      // eslint-disable-next-line @typescript-eslint/return-await
      return asyncSeries <string, boolean>(idsBase64, (idBase64, cb) => db.toggleSubscription(pushToken, Buffer.from(idBase64, 'base64').toString('hex'), true, cb))
    },
    async reset (query: any, session?: string, socket?: WebSocket): Promise<boolean[]> {
      const { pushToken, idsBase64: channelsToSubscribeBase64 } = await processTokens(log, query)
      if (socket !== undefined) {
        registerSocket(pushToken, session, socket)
      }

      const subscribedChannelsHex = await (new Promise<string[]>((resolve, reject) => {
        db.channelsByToken(pushToken, (error, idsHex) => (error !== null) ? reject(error) : resolve(idsHex))
      }))

      const requestedChannelsHex = channelsToSubscribeBase64.map(channelToSubscribe => Buffer.from(channelToSubscribe, 'base64').toString('hex'))
      const requestedChannelsHexLookup = toMap(requestedChannelsHex)
      const channelsToUnsubscribeHex = []
      const channelsToSubscribeHexLookup = toMap(requestedChannelsHex)
      const resultMap: { [idHex: string]: boolean } = {}

      for (const subscribedChannelHex of subscribedChannelsHex) {
        if (requestedChannelsHexLookup[subscribedChannelHex]) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete channelsToSubscribeHexLookup[subscribedChannelHex]
          resultMap[subscribedChannelHex] = true
        } else {
          channelsToUnsubscribeHex.push(subscribedChannelHex)
        }
      }

      const channelsToSubscribeHex = Object.keys(channelsToSubscribeHexLookup)
      await asyncSeries <string, boolean>(channelsToUnsubscribeHex, (idHex, cb) => db.toggleSubscription(pushToken, idHex, false, cb))
      await asyncSeries <string, boolean>(channelsToSubscribeHex, (idHex, cb) => db.toggleSubscription(pushToken, idHex, true, (error: Error, success?: boolean) => {
        if (exists(error)) return cb(error, success)
        resultMap[idHex] = success
        cb(null, success)
      }))
      const result: boolean[] = requestedChannelsHex.map(channelIdHex => resultMap[channelIdHex] || false)
      log({ reset: { channelsToSubscribeHex, channelsToUnsubscribeHex, pushToken, requestedChannelsHex, result } })

      return result
    },
    async unsubscribe (query: any): Promise<boolean[]> {
      const { pushToken, idsBase64 } = await processTokens(log, query)
      // eslint-disable-next-line @typescript-eslint/return-await
      return asyncSeries <string, boolean>(idsBase64, (idBase64, cb) => db.toggleSubscription(pushToken, Buffer.from(idBase64, 'base64').toString('hex'), false, cb))
    },
    closeSocket,
    async compatible (query: { version: string }): Promise<boolean> {
      return compareVersions.compare(query.version, VERSION, '>=')
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
      // eslint-disable-next-line @typescript-eslint/return-await
      return sendMessage(idBase64, messageBase64)
    }
  }
}
