import { EventEmitter } from 'events'
import { IReceiver, ICancelable } from '@consento/api'
import { cancelableReject } from '../../util/cancelableReject'

export enum EClientStatus {
  DESTROYED = 'destroyed',
  ERROR = 'error',
  FETCH = 'fetch',
  STARTUP = 'startup',
  WEBSOCKET_OPEN = 'websocket_open',
  WEBSOCKET_OPENING = 'websocket_opening'
}

export interface IExpoTransportStrategy extends EventEmitter {
  readonly state: EClientStatus
  run (token: Promise<string>, receivers: Set<IReceiver>): ICancelable<IExpoTransportStrategy>
  request (type: string, opts: any): ICancelable<any>
}

export abstract class Strategy extends EventEmitter implements IExpoTransportStrategy {
  _subscriptions: IReceiver[]

  abstract run (token?: Promise<string>, receivers?: Set<IReceiver>): ICancelable<IExpoTransportStrategy>

  abstract readonly state: EClientStatus

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  request (type: string, query: { [ key: string ]: string }): ICancelable<any> {
    return cancelableReject(Object.assign(new Error(`Can not send messages in ${this.state} state`), { code: 'ERR_STATE', state: this.state }))
  }
}
