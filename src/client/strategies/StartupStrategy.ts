import { EClientStatus, IExpoTransportStrategy, IExpoTransportState } from './strategy'
import { VERSION } from '../../package'
import { FetchStrategy, fetchFromAddress } from './FetchStrategy'
import { AbortSignal } from '@consento/api/util'
import { WebsocketStrategy } from './WebsocketStrategy'
import { noAddressStrategy } from './noAddressStrategy'

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
    if (state.foreground) {
      return new WebsocketStrategy()
    }
    return new FetchStrategy()
  },

  async request (): Promise<any> {
    throw new Error('Can not send request in error state')
  }
}
