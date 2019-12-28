import { EventEmitter } from 'events'
import { IEncryptedMessage, IAnnonymous, IReceiver } from '@consento/api'
import { INotificationsTransport } from '@consento/api/notifications/types'
import { bufferToString, Buffer } from '@consento/crypto/util/buffer'
import { format } from 'url'
import urlParse from 'url-parse'
import { IGetExpoToken, IExpoNotificationParts, IExpoTransportOptions } from './types'
import fetch from 'cross-fetch'
import { WSClient, MessageEvent, ErrorEvent, OpenEvent } from './WSClient'
import { ICancelable, cancelable, abortCancelable } from '@consento/crypto'

function webSocketUrl (webUrl: string): string {
  return webUrl.replace(/^http:\/\//g, 'ws://').replace(/^https:\/\//g, 'wss://')
}

export interface IURLParts {
  protocol: string
  username: string
  password: string
  host: string
  port: string
  pathname: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop (_: any): void {}

function getURLParts (address: string): IURLParts {
  const url = urlParse(address)
  return {
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    port: url.port,
    pathname: url.pathname
  }
}

interface INotification {
  idBase64: string
  bodyBase64: string
  signatureBase64: string
}

function isNotification (data: any): data is INotification {
  if (typeof data !== 'object') {
    return false
  }
  if (typeof data.idBase64 !== 'string') {
    return false
  }
  if (typeof data.bodyBase64 !== 'string') {
    return false
  }
  if (typeof data.signatureBase64 !== 'string') {
    return false
  }
  return true
}

let globalRid = 0
const globalRequests: { [rid: number]: (result: { error?: any, data?: any }) => void } = {}

interface IRequest {
  [key: string]: string
  idsBase64: string
  signaturesBase64: string
  pushToken: string
}

// eslint-disable-next-line @typescript-eslint/promise-function-async
function toRequest (token: Promise<string>, receivers: IReceiver[]): ICancelable<IRequest> {
  return cancelable<IRequest>(function * () {
    const pushToken: string = yield token
    const idsBase64: string[] = []
    const signaturesBase64: string[] = []
    for (const receiver of receivers) {
      const receiverIdBase64 = yield receiver.idBase64()
      idsBase64.push(receiverIdBase64)
      const pushTokenBuffer = Buffer.from(pushToken)
      signaturesBase64.push(bufferToString(yield receiver.sign(pushTokenBuffer), 'base64'))
    }
    return {
      idsBase64: idsBase64.join(';'),
      signaturesBase64: signaturesBase64.join(';'),
      pushToken
    }
  })
}

// eslint-disable-next-line @typescript-eslint/promise-function-async
function fetchHttp (url: IURLParts, path: string, query: { [key: string]: string }): ICancelable<string> {
  return abortCancelable<string>(async (signal: AbortSignal) => {
    const opts = {
      ...url,
      pathname: `${url.pathname}${path}`,
      query
    }
    return fetch(format(opts), {
      method: 'POST',
      signal
    }).then(async res => {
      const text = await res.text()
      if (res.status !== 200) {
        throw new Error(`HTTP Request failed[${res.status}] → ${text}
  ${JSON.stringify(opts, null, 2)}`)
      }
      return text
    })
  })
}

async function wsRequest (ws: WSClient, path: string, query: { [ key: string ]: string }): Promise<string> {
  const rid = ++globalRid
  const res = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish({ error: { type: 'timeout', message: `timeout #${rid}` } })
    }, 5000)
    const finish = (result: { error?: any, body?: any }): void => {
      clearTimeout(timeout)
      delete globalRequests[rid]
      if (result.error !== undefined) {
        return reject(Object.assign(new Error(), result.error))
      }
      resolve(String(result.body))
    }
    globalRequests[rid] = finish
  })
  await ws.send(JSON.stringify({
    type: path,
    rid,
    query
  }))
  return res
}

// eslint-disable-next-line @typescript-eslint/promise-function-async
async function _fetch (url: IURLParts, ws: WSClient | undefined, path: string, query: { [key: string]: string }): Promise<string> {
  return cancelable <string>(function * (child) {
    if (ws !== undefined) {
      const result = yield ((wsRequest(ws, path, query) as ICancelable<string>).catch(error => {
        console.log(`Error using connection, sending using post. Error: ${error}`)
      }))
      if (result !== undefined) {
        return result
      }
    }
    return child(fetchHttp(url, path, query))
  })
}

export class ExpoTransport extends EventEmitter implements INotificationsTransport {
  _pushToken: Promise<string>
  _url: IURLParts
  _getToken: IGetExpoToken
  _subscriptions: IReceiver[]
  _ws: WSClient
  handleNotification: (notification: IExpoNotificationParts) => void
  connect: () => () => void
  disconnect: () => void

  constructor ({ address, getToken }: IExpoTransportOptions) {
    super()
    this._url = getURLParts(address)
    this._getToken = getToken
    this._subscriptions = []
    const processInput = (data: any): void => {
      if (isNotification(data)) {
        this.emit('message', data.idBase64, {
          body: Buffer.from(data.bodyBase64, 'base64'),
          signature: Buffer.from(data.signatureBase64, 'base64')
        })
      }
    }
    this.handleNotification = (notification: IExpoNotificationParts): void => processInput(notification.data)
    const handleWSMessage = (ev: MessageEvent): void => {
      if (typeof ev.data !== 'string') {
        return
      }
      let data
      try {
        data = JSON.parse(ev.data)
      } catch (err) {
        return
      }
      if (data.type === 'response') {
        const res = globalRequests[data.rid]
        if (res !== undefined) {
          res(data)
        }
        return
      }
      if (data.type !== 'message') {
        return
      }
      processInput(data.body)
    }
    const debugError = (ev: ErrorEvent): void => {
      this.emit('error', ev.error)
    }
    const handleWSError = (ev: ErrorEvent): void => {
      this.emit('error', ev.error)
      this._ws = undefined
    }
    const handleWSOpen = async (_: OpenEvent): Promise<void> => {
      this.emit('socket-open')
      if (this._subscriptions.length === 0) {
        return
      }
      try {
        await wsRequest(this._ws, 'subscribe', await toRequest(this.token, this._subscriptions))
      } catch (err) {
        this.emit('error', err)
      }
    }
    const handleWSClose = (): void => {
      this.emit('socket-close')
    }
    this.disconnect = () => {
      if (this._ws !== undefined) {
        this._ws.onerror = debugError
        this._ws.onmessage = noop
        this._ws.onopen = noop
        this._ws.close()
        this._ws = undefined
      }
    }
    this.connect = () => {
      if (this._ws === undefined) {
        this._ws = new WSClient()
        this._ws.open(webSocketUrl(format(this._url)))
        this._ws.onmessage = handleWSMessage
        this._ws.onerror = handleWSError
        this._ws.onopen = handleWSOpen
        this._ws.onclose = handleWSClose
      }
      return this.disconnect
    }
  }

  get token (): Promise<string> {
    if (this._pushToken === undefined) {
      this._pushToken = this._getToken()
    }
    return this._pushToken
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  unsubscribe (receivers: IReceiver[]): ICancelable<boolean> {
    const url = this._url
    const ws = this._ws
    const token = this.token
    return cancelable(
      function * (child) {
        const opts = yield child(toRequest(token, receivers))
        return yield _fetch(url, ws, 'unsubscribe', opts)
      }
    ).then(
      () => {
        for (const receiver of receivers) {
          const pos = this._subscriptions.indexOf(receiver)
          if (pos !== -1) {
            this._subscriptions.splice(pos, 1)
          }
        }
        return true
      },
      (error: Error) => {
        this.emit('error', error)
        return false
      }
    )
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  subscribe (receivers: IReceiver[]): ICancelable<boolean> {
    const url = this._url
    const ws = this._ws
    const token = this.token
    return cancelable<boolean, this>(
      function * (child) {
        const opts = yield child(toRequest(token, receivers))
        yield _fetch(url, ws, 'subscribe', opts)
      }
    ).then(
      () => {
        for (const receiver of receivers) {
          if (this._subscriptions.indexOf(receiver) === -1) {
            this._subscriptions.push(receiver)
          }
        }
        return true
      },
      (error: Error) => {
        this.emit('error', error)
        return false
      }
    )
  }

  async send (channel: IAnnonymous, message: IEncryptedMessage): Promise<string[]> {
    await _fetch(this._url, this._ws, 'send', {
      idBase64: await channel.idBase64(),
      bodyBase64: bufferToString(message.body, 'base64'),
      signatureBase64: bufferToString(message.signature, 'base64')
    } as any)
    return []
  }
}
