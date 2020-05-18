import { EClientStatus, Strategy, IExpoTransportStrategy } from './strategy'
import { ICancelable, cancelable } from '@consento/api'
import { VERSION } from '../../package'
import { FetchStrategy } from './FetchStrategy'
import { WebsocketOpeningStrategy } from './WebsocketOpeningStrategy'
import { serverFetch } from '../serverFetch'

export class StartupStrategy extends Strategy {
  state = EClientStatus.STARTUP
  _test: ICancelable<void>
  _address: string
  _foreground: boolean
  _fetch: (type: string, query: { [key: string]: any }) => ICancelable<any>

  constructor (address: string, foreground: boolean) {
    super()
    this._address = address
    this._fetch = serverFetch(address)
    this._foreground = foreground
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (): ICancelable<IExpoTransportStrategy> {
    return cancelable<IExpoTransportStrategy, this>(function * (child) {
      const data = yield child(this._fetch('compatible', { version: VERSION }))
      if (data as any !== true) {
        const { server, version: serverVersion } = (yield child(this._fetch('', {}))) as { version: string, server: string }
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw Object.assign(new Error(`Server [address=${this._address}, server=${server}, version=${serverVersion}] is not compatible with this client [version=${VERSION}].`), { address: this._address, code: 'ESERVER_INCOMPATIBLE', server, version: VERSION })
      }
      if (this._foreground) {
        return new WebsocketOpeningStrategy(this._address)
      }
      return new FetchStrategy(this._address)
    }, this)
  }
}
