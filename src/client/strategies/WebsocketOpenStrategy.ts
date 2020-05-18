import { AbstractWebsocketStrategy, closeError } from './AbstractWebsocketStrategy'
import { EClientStatus, IExpoTransportStrategy } from './strategy'
import { cancelable, IReceiver, ICancelable } from '@consento/api'
import { receiversToRequest } from '../receiversToRequest'

export class WebsocketOpenStrategy extends AbstractWebsocketStrategy {
  state = EClientStatus.WEBSOCKET_OPEN

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (token: Promise<string>, receivers: Set<IReceiver>): ICancelable<IExpoTransportStrategy> {
    return cancelable<IExpoTransportStrategy, this>(function * () {
      const request = yield receiversToRequest(token, receivers)
      yield Promise.all([
        new Promise((resolve, reject) => {
          this._ws.onerror = reject
          this._ws.onclose = () => reject(closeError())
        }),
        this.request('subscribe', request)
      ])
    }, this)
      .finally(this._close)
  }
}
