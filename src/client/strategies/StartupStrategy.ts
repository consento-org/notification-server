import { EClientStatus, IExpoTransportStrategy, IExpoTransportState } from './strategy'
import { VERSION } from '../../package'
import { FetchStrategy, fetchFromAddress } from './FetchStrategy'
import { AbortSignal } from '@consento/api/util'
import { WebsocketStrategy } from './WebsocketStrategy'
import { noAddressStrategy } from './noAddressStrategy'
import * as Permissions from 'expo-permissions'
import Constants from 'expo-constants'

export const startupStrategy: IExpoTransportStrategy = {
  type: EClientStatus.STARTUP,

  async run (state: IExpoTransportState, signal: AbortSignal): Promise<IExpoTransportStrategy> {
    if (state.address === null || state.address === undefined || /^\s*$/.test(state.address)) {
      return noAddressStrategy
    }
    const data = await fetchFromAddress(state.address, 'compatible', { version: VERSION }, { signal })
    if (data !== true) {
      const { server, version: serverVersion } = (await fetchFromAddress(state.address, '', {}, { signal })) as { version: string, server: string }
      throw Object.assign(new Error(`Server [address=${state.address}, server=${server}, version=${serverVersion}] is not compatible with this client [version=${VERSION}].`), { address: state.address, code: 'ESERVER_INCOMPATIBLE', server, version: VERSION })
    }
    if (Constants.isDevice) {
      const { status: existingStatus } = await Permissions.getAsync(Permissions.NOTIFICATIONS)
      let finalStatus = existingStatus
      if (existingStatus !== 'granted') {
        const { status } = await Permissions.askAsync(Permissions.NOTIFICATIONS)
        finalStatus = status
      }
      if (finalStatus !== 'granted') {
        throw new Error('Permission for notifications is required for the networking to work')
      }
    } else {
      console.warn('Not running on a device, push notifications will not work.')
    }
    if (state.foreground) {
      return new WebsocketStrategy()
    }
    return new FetchStrategy()
  },

  async request (): Promise<any> {
    throw new Error('Can not send request in error state')
  }
}
