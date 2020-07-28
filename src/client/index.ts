import { AppState, AppStateStatus } from 'react-native'
import * as Notifications from 'expo-notifications'
import {
  IEncryptedMessage,
  IAnnonymous,
  IReceiver,
  INotificationsTransport,
  INotificationControl
} from '@consento/api'
import {
  AbortError,
  AbortSignal,
  Buffer,
  bufferToString,
  wrapTimeout,
  ITimeoutOptions,
  bubbleAbort
} from '@consento/api/util'
import { IExpoNotificationParts, IExpoTransportOptions } from './types'
import { getExpoToken } from '../util/getExpoToken'
import { IExpoTransportStrategy, EClientStatus, IExpoTransportState } from './strategies/strategy'
import { receiversToRequest } from './receiversToRequest'
import { ErrorStrategy } from './strategies/ErrorStrategy'
import { startupStrategy } from './strategies/startupStrategy'
import { noAddressStrategy } from './strategies/noAddressStrategy'
import { StrategyControl } from '../util/StrategyControl'

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

export class ExpoTransport implements INotificationsTransport {
  #token: Promise<Notifications.ExpoPushToken>
  #strategy: StrategyControl<EClientStatus, IExpoTransportStrategy, IExpoTransportState>
  #control: INotificationControl

  handleNotification: (notification: IExpoNotificationParts) => void

  _stateChange: (state: AppStateStatus) => void

  constructor ({ address, getToken, control }: IExpoTransportOptions) {
    this.#control = control
    this.#token = (getToken ?? getExpoToken)()
    const handleInput = (notification: IExpoNotificationParts): void => {
      const { data } = notification
      if (isNotification(data)) {
        control.message(data.idBase64, {
          body: Buffer.from(data.bodyBase64, 'base64'),
          signature: Buffer.from(data.signatureBase64, 'base64')
        }).catch(error => console.error(error))
      }
    }
    this.handleNotification = handleInput
    this.#strategy = new StrategyControl<EClientStatus, IExpoTransportStrategy, IExpoTransportState>({
      state: {
        address,
        foreground: AppState.currentState !== 'background',
        handleInput
      },
      idle: () => startupStrategy,
      error: error => new ErrorStrategy(error)
    })

    this._stateChange = () => {
      const fg = AppState.currentState !== 'background'
      this.#strategy.state.foreground = fg
      const expected = (fg ? EClientStatus.WEBSOCKET : EClientStatus.FETCH)
      if (this.#strategy.type !== expected) {
        this._restart()
      }
    }

    this._restart = this._restart.bind(this)
    this.#strategy.on('change', () => {
      if (this.state === EClientStatus.FETCH || this.state === EClientStatus.WEBSOCKET) {
        control.reset().catch(error => { control.error(error) })
      }
    })
    AppState.addEventListener('change', this._stateChange)
  }

  async destroy (): Promise<void> {
    AppState.removeEventListener('change', this._stateChange)
    this.#strategy.change(new ErrorStrategy(Object.assign(new Error('destroyed'), { code: 'EDESTROYED' })))
  }

  get address (): string {
    return this.#strategy.state.address
  }

  set address (address: string) {
    if (this.#strategy.state.address !== address) {
      this.#strategy.state.address = address
      this._restart()
    }
  }

  _restart (): void {
    this.#strategy.change(
      (this.address === null || this.address === undefined || /^\s*$/.test(this.address))
        ? noAddressStrategy
        : startupStrategy
    )
  }

  get state (): EClientStatus {
    return this.#strategy.type
  }

  async token (): Promise<Notifications.ExpoPushToken> {
    return await this.#token
  }

  async unsubscribe (receivers: IReceiver[], opts: ITimeoutOptions = {}): Promise<boolean[]> {
    return await this._subscriptionRequest(receivers, 'unsubscribe', opts)
  }

  async subscribe (receivers: IReceiver[], opts: ITimeoutOptions = {}): Promise<boolean[]> {
    return await this._subscriptionRequest(receivers, 'subscribe', opts)
  }

  async reset (receivers: IReceiver[], opts: ITimeoutOptions = {}): Promise<boolean[]> {
    return await this._subscriptionRequest(receivers, 'reset', opts)
  }

  async send (channel: IAnnonymous, message: IEncryptedMessage, opts: ITimeoutOptions = {}): Promise<string[]> {
    return await this._request('send', {
      idBase64: channel.idBase64,
      bodyBase64: bufferToString(message.body, 'base64'),
      signatureBase64: bufferToString(message.signature, 'base64')
    } as any, opts)
  }

  async _subscriptionRequest (
    receivers: IReceiver[],
    command: string,
    opts: ITimeoutOptions
  ): Promise<boolean[]> {
    if (receivers.length === 0) {
      return []
    }
    const requestOptions = await receiversToRequest(await this.#token, receivers, opts)
    try {
      // Mark as changed anyways!
      return this._request(command, requestOptions, opts) as unknown as boolean[]
    } catch (cause) {
      return receivers.map(() => false)
    }
  }

  async awaitReady (signal?: AbortSignal): Promise<void> {
    while (true) {
      if (this.state === EClientStatus.WEBSOCKET || this.state === EClientStatus.FETCH) {
        return
      }
      await this.#strategy.awaitChange({ signal })
      bubbleAbort(signal)
    }
  }

  async awaitState (state: EClientStatus, opts?: ITimeoutOptions): Promise<void> {
    return await this.#strategy.awaitType(state, opts)
  }

  async _request (command: string, commandArguments: any, opts: ITimeoutOptions): Promise<any> {
    return await wrapTimeout(
      async (signal, resetTimeout) => {
        await this.awaitReady(signal)
        resetTimeout()
        try {
          return await this.#strategy.current.request(command, commandArguments, { signal })
        } catch (cause) {
          if (cause instanceof AbortError) {
            throw cause
          }
          const error = Object.assign(
            new Error(`Error while ${command} request [${JSON.stringify(commandArguments)}]:\n${String(cause.stack)}`),
            { command, commandArguments, state: this.state, cause }
          )
          this.#control.error(error)
          throw error
        }
      },
      opts
    )
  }
}
