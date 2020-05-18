import { Strategy, EClientStatus, IExpoTransportStrategy } from './strategy'
import { runForever } from '../../util/runForever'
import { ICancelable } from '@consento/api'

export class NoAddressStrategy extends Strategy {
  state = EClientStatus.NOADDRESS

  async _close (): Promise <void> {}

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (): ICancelable<IExpoTransportStrategy> {
    return runForever()
  }
}
