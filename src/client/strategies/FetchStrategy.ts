import { ICancelable } from '@consento/api'
import { Strategy, EClientStatus, IExpoTransportStrategy } from './strategy'
import { runForever } from '../../util/runForever'
import { serverFetch } from '../serverFetch'

export class FetchStrategy extends Strategy {
  state = EClientStatus.FETCH

  constructor (address: string) {
    super()
    this.request = serverFetch(address)
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (): ICancelable<IExpoTransportStrategy> {
    return runForever()
  }
}
