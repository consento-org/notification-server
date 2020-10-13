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
  bubbleAbort,
  exists
} from '@consento/api/util'
import { EventEmitter } from 'events'
import { IExpoNotificationParts, IExpoTransportOptions } from './types'
import { getExpoToken } from '../util/getExpoToken'
import { IExpoTransportStrategy, EClientStatus, IExpoTransportState } from './strategies/strategy'
import { receiversToRequest } from './receiversToRequest'
import { ErrorStrategy } from './strategies/ErrorStrategy'
import { startupStrategy } from './strategies/startupStrategy'
import { StrategyControl } from '../util/StrategyControl'
import { Subscription } from '@unimodules/core'

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
  _token: Promise<Notifications.ExpoPushToken>
  _strategy: StrategyControl<EClientStatus, IExpoTransportStrategy, IExpoTransportState>
  _control: INotificationControl

  handleNotification: (notification: IExpoNotificationParts) => Promise<boolean>

  _stateChange: (state: AppStateStatus) => void
  _emitChange: () => boolean
  _receivedListener: Subscription[]

  constructor ({ address, getToken, control }: IExpoTransportOptions) {
    super()
    this._control = control
    this._token = (getToken ?? getExpoToken)()
    const handleNotification = async (data: any): Promise<boolean> => {
      if (isNotification(data)) {
        const content = await control.message(data.idBase64, {
          body: Buffer.from(data.bodyBase64, 'base64'),
          signature: Buffer.from(data.signatureBase64, 'base64')
        })
        if (typeof content === 'boolean') {
          return content
        }
        if (exists(content)) {
          await Notifications.scheduleNotificationAsync({
            content,
            trigger: {
              seconds: 0
            }
          })
        }
        return true
      }
      return false
    }
    this.handleNotification = handleNotification
    this._strategy = new StrategyControl<EClientStatus, IExpoTransportStrategy, IExpoTransportState>({
      state: {
        address,
        foreground: AppState.currentState !== 'background',
        handleInput: (notification: IExpoNotificationParts): void => {
          handleNotification(notification.data)
            .then()
            .catch(error => control.error(error))
        }
      },
      idle: () => startupStrategy,
      error: error => new ErrorStrategy(error)
    })
    this._emitChange = () => this.emit('change')
    this._strategy.on('change', this._emitChange)

    this._stateChange = () => {
      const fg = AppState.currentState !== 'background'
      this._strategy.state.foreground = fg
      const expected = (fg ? EClientStatus.WEBSOCKET : EClientStatus.FETCH)
      if (this._strategy.type !== expected) {
        this._restart()
      }
    }

    this._restart = this._restart.bind(this)
    this._strategy.on('change', () => {
      if (this.state === EClientStatus.FETCH || this.state === EClientStatus.WEBSOCKET) {
        control.reset().catch(error => { control.error(error) })
      }
    })
    AppState.addEventListener('change', this._stateChange)
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        await handleNotification(notification.request.content.data)
        return {
          shouldShowAlert: false,
          shouldPlaySound: false,
          shouldSetBadge: false
        }
      },
      handleError: (notificationId, error) => control.error(Object.assign(error, { notificationId }))
    })
    this._receivedListener = [
      Notifications.addNotificationResponseReceivedListener(notification => {
        handleNotification(notification.notification.request.content.data)
          .catch(error => control.error(error))
      }),
      Notifications.addNotificationReceivedListener(notification => {
        handleNotification(notification.request.content.data)
          .catch(error => control.error(error))
      })
    ]
  }

  async destroy (): Promise<void> {
    for (const listener of this._receivedListener) listener.remove()
    Notifications.setNotificationHandler(null)
    AppState.removeEventListener('change', this._stateChange)
    this._strategy.change(new ErrorStrategy(Object.assign(new Error('destroyed'), { code: 'EDESTROYED' })))
    this._strategy.off('change', this._emitChange)
  }

  // For debugging
  get strategy (): IExpoTransportStrategy {
    return this._strategy.current
  }

  get error (): Error | undefined {
    const current = this._strategy.current
    if (current.type === EClientStatus.ERROR) {
      return (current as ErrorStrategy).error
    }
  }

  get address (): string | undefined {
    return this._strategy.state.address
  }

  set address (address: string | undefined) {
    if (this._strategy.state.address !== address) {
      this._strategy.state.address = address
      this._restart()
    }
  }

  _restart (): void {
    this._strategy.change(startupStrategy)
  }

  get state (): EClientStatus {
    return this._strategy.type
  }

  async token (): Promise<Notifications.ExpoPushToken> {
    return await this._token
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
    const requestOptions = await receiversToRequest(await this._token, receivers, opts)
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
      await this._strategy.awaitChange({ signal })
      bubbleAbort(signal)
    }
  }

  async awaitState (state: EClientStatus, opts?: ITimeoutOptions): Promise<void> {
    return await this._strategy.awaitType(state, opts)
  }

  async awaitChange (opts?: ITimeoutOptions): Promise<EClientStatus> {
    await this._strategy.awaitChange(opts)
    return this.state
  }

  async _request (command: string, commandArguments: any, opts: ITimeoutOptions): Promise<any> {
    return await wrapTimeout(
      async (signal, resetTimeout) => {
        await this.awaitReady(signal)
        resetTimeout()
        try {
          return await this._strategy.current.request(command, commandArguments, { signal })
        } catch (cause) {
          if (cause instanceof AbortError) {
            throw cause
          }
          const error = Object.assign(
            new Error(`Error while ${command} request [state=${this.state}][${JSON.stringify(commandArguments)}]:\n${String(cause)}\n${String(cause.stack)}`),
            { command, commandArguments, state: this.state, cause }
          )
          this._control.error(error)
          throw error
        }
      },
      opts
    )
  }
}
