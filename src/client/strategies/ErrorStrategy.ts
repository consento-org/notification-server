import { Strategy, EClientStatus, IExpoTransportStrategy } from './strategy'
import { runForever } from '../../util/runForever'
import { ICancelable } from '@consento/api'

export class ErrorStrategy extends Strategy {
  error: Error
  state = EClientStatus.ERROR

  constructor (error: Error) {
    super()
    this.error = error
  }

  async _close (): Promise <void> {}

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (): ICancelable<IExpoTransportStrategy> {
    return runForever()
  }
}
