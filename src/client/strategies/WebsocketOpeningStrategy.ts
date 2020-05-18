import { EClientStatus, IExpoTransportStrategy } from './strategy'
import { AbstractWebsocketStrategy, closeError, webSocketUrl } from './AbstractWebsocketStrategy'
import { WSClient, ErrorEvent } from '../WSClient'
import { ICancelable, cancelable } from '@consento/api'
import { WebsocketOpenStrategy } from './WebsocketOpenStrategy'
import { format } from 'url'

export class WebsocketOpeningStrategy extends AbstractWebsocketStrategy {
  state = EClientStatus.WEBSOCKET_OPENING
  _address: string

  constructor (address: string) {
    super(new WSClient())
    this._address = webSocketUrl(format(address))
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (): ICancelable<IExpoTransportStrategy> {
    return cancelable<IExpoTransportStrategy, this>(function * () {
      yield new Promise((resolve, reject) => {
        this._ws.open(this._address)
        this._ws.onopen = resolve
        this._ws.onerror = (event: ErrorEvent) => reject(event.error)
        this._ws.onclose = () => reject(closeError())
      })
      return new WebsocketOpenStrategy(this._ws)
    }, this)
      .catch(this._close)
  }
}
