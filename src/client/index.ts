import { EventEmitter } from 'events'
import { INotificationsTransport } from '@consento/api/notifications/types'
import { IEncryptedMessage, IAnnonymous, IReceiver, ICancelable, cancelable, CancelError } from '@consento/api'
import { bufferToString, Buffer } from '@consento/crypto/util/buffer'
import { IGetExpoToken, IExpoNotificationParts, IExpoTransportOptions } from './types'
import { AppState, AppStateStatus } from 'react-native'
import * as Notifications from 'expo-notifications'
import { getExpoToken } from '../util/getExpoToken'
import { exists } from '../util/exists'
import { IExpoTransportStrategy, EClientStatus } from './strategies/strategy'
import { receiversToRequest } from './receiversToRequest'
import { ErrorStrategy } from './strategies/ErrorStrategy'
import { timeoutPromise } from '../util/timeoutPromise'
import { StartupStrategy } from './strategies/StartupStrategy'
import { NoAddressStrategy } from './strategies/NoAddressStrategy'

export { EClientStatus } from './strategies/strategy'

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
  _pushToken: Promise<Notifications.ExpoPushToken>
  _getToken: IGetExpoToken
  _subscriptions: Set<IReceiver>
  _address: string
  _background: boolean = false
  _strategy: IExpoTransportStrategy
  _strategyProcess: ICancelable<IExpoTransportStrategy>
  _process: ICancelable<void>

  handleNotification: (notification: IExpoNotificationParts) => void

  _stateChange: (state: AppStateStatus) => void

  constructor ({ address, getToken }: IExpoTransportOptions) {
    super()
    this._address = address
    this._getToken = getToken ?? getExpoToken
    this._subscriptions = new Set()
    const processInput = (data: any): void => {
      if (isNotification(data)) {
        this.emit('message', data.idBase64, {
          body: Buffer.from(data.bodyBase64, 'base64'),
          signature: Buffer.from(data.signatureBase64, 'base64')
        })
      }
    }
    this.handleNotification = (notification: IExpoNotificationParts): void => {
      processInput(notification.data)
    }

    this._updateStrategy = this._updateStrategy.bind(this)
    this._updateStrategy()
    AppState.addEventListener('change', this._updateStrategy)
  }

  async destroy (): Promise<void> {
    AppState.removeEventListener('change', this._stateChange)
    this._nextStrategy(new ErrorStrategy(Object.assign(new Error('destroyed'), { code: 'EDESTROYED' })))
  }

  get address (): string {
    return this._address
  }

  set address (address: string) {
    if (this._address !== address) {
      this._address = address
      this._updateStrategy()
    }
  }

  _updateStrategy (): void {
    this._nextStrategy(
      (this._address === null || this._address === undefined || /^\s*$/.test(this._address))
        ? new NoAddressStrategy()
        : new StartupStrategy(this._address, AppState.currentState !== 'background')
    )
  }

  get state (): EClientStatus {
    return this._strategy.state
  }

  _nextStrategy (strategy: IExpoTransportStrategy): void {
    if (this._strategy !== undefined) {
      this._strategy.off('input', this.handleNotification)
    }
    strategy.on('input', this.handleNotification)
    this._strategy = strategy
    let process: ICancelable<IExpoTransportStrategy>
    if (exists(this._process)) {
      process = cancelable<IExpoTransportStrategy, this>(function * (child) {
        // eslint-disable-next-line handle-callback-err
        yield (this._process.cancel().catch(() => {}))
        return yield child(strategy.run(this.token, this._subscriptions))
      }, this)
    } else {
      process = strategy.run(this.token, this._subscriptions)
    }
    this._process = process.then(
      strategy => this._nextStrategy(strategy),
      error => {
        if (error instanceof CancelError) {
          return
        }
        this._nextStrategy(new ErrorStrategy(error))
      }
    )
    // Just in case a run command finishes a bit too quickly...
    if (this._strategy === strategy) {
      this._strategyProcess = process
      this.emit('state', this.state)
    }
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  awaitState (state: EClientStatus, timeout: number = 5000): Promise<void> {
    let check: () => void
    return timeoutPromise<undefined>(timeout, (resolve, reject) => {
      if (this._strategy instanceof ErrorStrategy) {
        return reject(this._strategy.error)
      }
      if (this.state === state) {
        return resolve(undefined)
      }
      check = (): void => {
        if (this._strategy instanceof ErrorStrategy) {
          return reject(this._strategy.error)
        }
        if (this.state === state) {
          resolve(undefined)
        }
      }
      this.on('state', check)
    }).finally(() => {
      this.removeListener('state', check)
    })
  }

  get token (): Promise<Notifications.ExpoPushToken> {
    if (this._pushToken === undefined) {
      this._pushToken = this._getToken()
    }
    // eslint-disable-next-line @typescript-eslint/return-await
    return this._pushToken
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  unsubscribe (receivers: IReceiver[]): ICancelable<boolean[]> {
    if (receivers.length === 0) {
      // eslint-disable-next-line @typescript-eslint/return-await
      return cancelable(function * () {
        return []
      })
    }
    const token = this.token
    // eslint-disable-next-line @typescript-eslint/return-await
    return cancelable<boolean[], ExpoTransport>(
      function * (child) {
        const opts = yield child(receiversToRequest(token, receivers))
        return yield this._strategy.request('unsubscribe', opts)
      },
      this
    ).then(
      (result: boolean[]) => {
        for (const receiver of receivers) {
          this._subscriptions.delete(receiver)
        }
        return result
      },
      (error: Error) => {
        this.emit('error', error)
        return receivers.map(() => false)
      }
    )
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  subscribe (receivers: IReceiver[]): ICancelable<boolean[]> {
    if (receivers.length === 0) {
      // eslint-disable-next-line @typescript-eslint/return-await
      return cancelable(function * () {
        return []
      })
    }
    const token = this.token
    // eslint-disable-next-line @typescript-eslint/return-await
    return cancelable<boolean[], this>(
      function * (child) {
        const opts = yield child(receiversToRequest(token, receivers))
        return yield this._strategy.request('subscribe', opts)
      },
      this
    ).then(
      (result: boolean[]) => {
        for (const receiver of receivers) {
          this._subscriptions.add(receiver)
        }
        return result
      },
      (error: Error) => {
        this.emit('error', error)
        return receivers.map(() => false)
      }
    )
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  reset (receivers: IReceiver[]): ICancelable<boolean[]> {
    const token = this.token
    // eslint-disable-next-line @typescript-eslint/return-await
    return cancelable<boolean[], this>(
      function * (child) {
        const opts = yield child(receiversToRequest(token, receivers))
        return yield this._strategy.request('reset', opts)
      },
      this
    ).then(
      (result: boolean[]) => {
        for (const receiver of receivers) {
          this._subscriptions.add(receiver)
        }
        return result
      },
      (error: Error) => {
        this.emit('error', error)
        return receivers.map(() => false)
      }
    )
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async send (channel: IAnnonymous, message: IEncryptedMessage): Promise<string[]> {
    return this._strategy.request('send', {
      idBase64: channel.idBase64,
      bodyBase64: bufferToString(message.body, 'base64'),
      signatureBase64: bufferToString(message.signature, 'base64')
    } as any) as any
  }
}
