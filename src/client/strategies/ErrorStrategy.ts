import { IExpoTransportStrategy, EClientStatus } from './strategy'
import { AbstractErrorStrategy } from '../../util/StrategyControl'

export class ErrorStrategy extends AbstractErrorStrategy<EClientStatus, IExpoTransportStrategy> implements IExpoTransportStrategy {
  type = EClientStatus.ERROR

  async request (): Promise<any> {
    throw new Error('Can not send request in error state')
  }
}
