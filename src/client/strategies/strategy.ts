/* eslint-disable @typescript-eslint/method-signature-style */
import { IStrategy } from '../../util/StrategyControl'
import { ITimeoutOptions } from '@consento/api/util/types'
import { IExpoNotificationParts } from '../types'

export enum EClientStatus {
  NOADDRESS = 'no_address',
  DESTROYED = 'destroyed',
  ERROR = 'error',
  STARTUP = 'startup',
  FETCH = 'fetch',
  WEBSOCKET = 'websocket'
}

export interface IExpoTransportState {
  address: string
  foreground: boolean
  handleInput: (notification: IExpoNotificationParts) => void
}

export interface IExpoTransportStrategy extends IStrategy<EClientStatus, IExpoTransportStrategy, IExpoTransportState> {
  request (type: string, args: any, options: ITimeoutOptions): Promise<any>
}
