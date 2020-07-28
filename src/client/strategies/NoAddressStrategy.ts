import { EClientStatus, IExpoTransportStrategy } from './strategy'
import { idle } from '../../util/StrategyControl'

export const noAddressStrategy: IExpoTransportStrategy = {
  type: EClientStatus.NOADDRESS,
  run: idle,
  async request (): Promise<any> {
    throw new Error('Can not send request in error state')
  }
}
