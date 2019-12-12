import { Request } from 'express'
import { randomBytes } from 'crypto'
import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { sodium } from '@consento/crypto/core/sodium'
import { IEncryptedMessage } from '@consento/crypto/core/types'
import { DB } from './createDb'
import { exists } from '../util/exists'

async function verifyRequest (req: Request, idBase64: string, message: IEncryptedMessage): Promise<boolean> {
  const id = Buffer.from(idBase64, 'base64')
  if (!await sodium.verify(id, message.signature, message.body)) {
    req.res.status(400).end('invalid-signature')
    return false
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
  subscribe (query: any): Promise<boolean[]>
  unsubscribe (query: any): Promise<boolean[]>
  send (req: Request): Promise<void>
}

export function createApp ({ db, log, logError, expo }: AppOptions): IApp {
  if (expo === undefined) {
    expo = new Expo({})
  }

  function err (req: Request, error: Error): void {
    logError({
      type: 'http-error',
      error
    })
    req.res.status(500).send('Error.')
  }

  function toCb (req: Request): (error: Error, data?: any) => void {
    let done = false
    return (error: Error, data: any) => {
      if (done) return
      done = true
      if (exists(error)) {
        err(req, error)
        return
      }
      req.res.status(200).send(JSON.stringify(data))
    }
  }

  function sendMessage (idBase64: string, message: EncryptedMessageBase64, cb: (error: Error, tickets?: string[]) => void): void {
    const rid = randomBytes(8)
    const idHex = Buffer.from(idBase64, 'base64').toString('hex')
    log({
      send: {
        idHex,
        message,
        rid: rid.toString('hex')
      }
    })

    db.list(idHex, (error: Error, pushTokensHex?: string[]) => {
      if (exists(error)) return cb(error)
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

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      ;(async (): Promise<string[]> => {
        const results = await Promise.all(
          expo
            .chunkPushNotifications(messages)
            .map(async (messagesChunk): Promise<ExpoPushTicket[]> => {
              try {
                const ticket = await expo.sendPushNotificationsAsync(messagesChunk)
                return ticket
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
        )
        const successful = results.filter(Boolean).reduce((all: string[], partial) => {
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
        return successful
      })()
        .catch(cb)
        .then((tickets: string[]) => cb(null, tickets))
    })
  }

  return {
    async subscribe (query: any): Promise<boolean[]> {
      const entries = await processTokens(log, query)
      return asyncSeries <IProcessedToken, boolean>(entries, ({ pushToken, idBase64 }, cb) => db.subscribe(pushToken, Buffer.from(idBase64, 'base64').toString('hex'), cb))
    },
    async unsubscribe (query: any): Promise<boolean[]> {
      const entries = await processTokens(log, query)
      return asyncSeries <IProcessedToken, boolean>(entries, ({ pushToken, idBase64 }, cb) => db.subscribe(pushToken, Buffer.from(idBase64, 'base64').toString('hex'), cb))
    },
    send: async (req: Request): Promise<void> => {
      const { idBase64, bodyBase64, signatureBase64 } = req.query
      const messageBase64 = {
        idBase64,
        bodyBase64,
        signatureBase64
      }
      const message = {
        body: Buffer.from(bodyBase64, 'base64'),
        signature: Buffer.from(signatureBase64, 'base64')
      }
      if (await verifyRequest(req, idBase64, message)) {
        await sendMessage(idBase64, messageBase64, toCb(req))
      }
    }
  }
}
