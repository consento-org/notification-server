import { EventEmitter } from 'events'
import { IEncryptedMessage, IAnnonymous, IReceiver } from '@consento/api'
import { INotificationsTransport } from '@consento/api/notifications/types'
import { bufferToString, Buffer } from '@consento/crypto/util/buffer'
import { format } from 'url'
import urlParse from 'url-parse'
import WSWebSocket from 'ws'
import { IGetExpoToken, IExpoNotificationParts, IExpoTransportOptions } from './types'
import fetch from 'cross-fetch'

// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
type WebSocketFactory = new (address: string) => WSWebSocket
const BuiltInWebSocket: WebSocketFactory = (global as any).WebSocket
const WebSocket = BuiltInWebSocket !== undefined ? BuiltInWebSocket : WSWebSocket

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

export class ExpoTransport extends EventEmitter implements INotificationsTransport {
  _pushToken: PromiseLike<string>
  _url: IURLParts
  _getToken: IGetExpoToken
  _subscriptions: IReceiver[]
  _ws: WSWebSocket
  handleNotification: (notification: IExpoNotificationParts) => void
  connect: () => () => void

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
    const handleWSMessage = (ev: WSWebSocket.MessageEvent): void => {
      if (typeof ev.data !== 'string') {
        return
      }
      let data
      try {
        data = JSON.parse(ev.data)
      } catch (err) {
        return
      }
      if (data.type !== 'message') {
        return
      }
      processInput(data.body)
    }
    const debugError = (ev: WSWebSocket.ErrorEvent): void => {
      this.emit('error', ev.error)
    }
    const handleWSError = (ev: WSWebSocket.ErrorEvent): void => {
      this.emit('error', ev.error)
      this._ws = undefined
    }
    const handleWSOpen = async (_: WSWebSocket.OpenEvent): Promise<void> => {
      this.emit('socket-open')
      this._ws.send(JSON.stringify({
        type: 'subscribe',
        query: await this._toRequest(this._subscriptions)
      }))
    }
    const handleWSClose = (): void => {
      this.emit('socket-close')
    }
    this.connect = () => {
      if (this._ws === undefined) {
        this._ws = new WebSocket(webSocketUrl(format(this._url)))
        this._ws.onmessage = handleWSMessage
        this._ws.onerror = handleWSError
        this._ws.onopen = handleWSOpen
        this._ws.onclose = handleWSClose
      }
      return () => {
        if (this._ws !== undefined) {
          this._ws.onerror = debugError
          this._ws.onmessage = noop
          this._ws.onopen = noop
          this._ws.close()
          this._ws = undefined
        }
      }
    }
  }

  async _fetch (path: string, query: { [key: string]: string }): Promise<any> {
    if (this._ws !== undefined) {
      try {
        await this._ws.send(JSON.stringify({
          type: path,
          query
        }))
        return
      } catch (err) {}
    }
    const opts = {
      ...this._url,
      pathname: `${this._url.pathname}${path}`,
      query
    }
    const res = await fetch(format(opts as any), {
      method: 'POST'
    })

    if (res.status !== 200) {
      throw new Error(`HTTP Request failed[${res.status}] → ${await res.text()}
${JSON.stringify(opts, null, 2)}`)
    }
    return res
  }

  get token (): PromiseLike<string> {
    if (this._pushToken === undefined) {
      this._pushToken = this._getToken()
    }
    return this._pushToken
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async _toRequest (receivers: IReceiver[]): Promise<{
    idsBase64: string
    signaturesBase64: string
    pushToken: string
  }> {
    const pushTokenPromise = this.token
    const [idsBase64, signaturesBase64, pushToken] = await Promise.all([
      Promise.all(receivers.map(channel => channel.idBase64())),
      pushTokenPromise.then(async pushToken => {
        const pushTokenBuffer = Buffer.from(pushToken)
        return Promise.all(receivers.map(async channel => bufferToString(await channel.sign(pushTokenBuffer), 'base64')))
      }) as any as Promise<string[]>,
      pushTokenPromise
    ])

    return {
      idsBase64: idsBase64.join(';'),
      signaturesBase64: signaturesBase64.join(';'),
      pushToken
    }
  }

  async unsubscribe (receivers: IReceiver[]): Promise<boolean> {
    try {
      const opts = await this._toRequest(receivers)
      await this._fetch('unsubscribe', opts)
    } catch (err) {
      this.emit('error', err)
      return false
    }
    for (const receiver of receivers) {
      const pos = this._subscriptions.indexOf(receiver)
      if (pos !== -1) {
        this._subscriptions.splice(pos, 1)
      }
    }
    return true
  }

  async subscribe (receivers: IReceiver[]): Promise<boolean> {
    try {
      const opts = await this._toRequest(receivers)
      await this._fetch('subscribe', opts)
    } catch (err) {
      this.emit('error', err)
      return false
    }
    for (const receiver of receivers) {
      if (this._subscriptions.indexOf(receiver) === -1) {
        this._subscriptions.push(receiver)
      }
    }
    return true
  }

  async send (channel: IAnnonymous, message: IEncryptedMessage): Promise<string[]> {
    const data = {
      idBase64: await channel.idBase64(),
      bodyBase64: bufferToString(message.body, 'base64'),
      signatureBase64: bufferToString(message.signature, 'base64')
    }
    await this._fetch('send', data)
    return []
  }
}
