import { EventEmitter } from 'events'
import { IEncryptedMessage, IAnnonymous, IReceiver } from '@consento/api'
import { INotificationsTransport } from '@consento/api/notifications/types'
import { bufferToString, Buffer } from '@consento/crypto/util/buffer'
import { format, URL } from 'url'
import { IGetExpoToken, IExpoNotificationsParts, IExpoNotificationParts, IExpoTransportOptions } from './types'
import fetch from 'cross-fetch'

interface IURLParts {
  protocol: string
  username: string
  password: string
  host: string
  port: string
  pathname: string
}

function getURLParts (address: string): IURLParts {
  const url = new URL(address)
  return {
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    port: url.port,
    pathname: url.pathname
  }
}

export class ExpoTransport extends EventEmitter implements INotificationsTransport {
  _pushToken: PromiseLike<string>
  _url: IURLParts
  _getToken: IGetExpoToken
  _expo: IExpoNotificationsParts
  handleNotification: (notification: IExpoNotificationParts) => void

  constructor ({ address, expo, getToken }: IExpoTransportOptions) {
    super()
    this._url = getURLParts(address)
    this._getToken = getToken
    this._expo = expo
    this.handleNotification = (notification: IExpoNotificationParts): void => {
      this.emit('message', notification.data.idBase64, {
        body: Buffer.from(notification.data.bodyBase64, 'base64'),
        signature: Buffer.from(notification.data.signatureBase64, 'base64')
      })
    }
  }

  async _fetch (path: string, query: { [key: string]: string }): Promise<any> {
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
      this._pushToken = this._getToken({
        expo: this._expo
      })
    }
    return this._pushToken
  }

  async _toRequest (receivers: IReceiver[]): Promise<{
    idsBase64: string
    signaturesBase64: string
    pushToken: string
  }> {
    const pushToken = await this.token
    return {
      idsBase64: (await Promise.all(receivers.map(channel => channel.idBase64()))).join(';'),
      signaturesBase64: (await Promise.all(receivers.map(async channel => bufferToString(await channel.sign(Buffer.from(pushToken)), 'base64')))).join(';'),
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
    return true
  }

  async send (channel: IAnnonymous, message: IEncryptedMessage): Promise<string[]> {
    return this._fetch('send', {
      idBase64: await channel.idBase64(),
      bodyBase64: bufferToString(message.body, 'base64'),
      signatureBase64: bufferToString(message.signature, 'base64')
    })
  }
}
