import { IExpoTransportStrategy, EClientStatus, IExpoTransportState } from './strategy'
import { ITimeoutOptions, wrapTimeout, AbortSignal } from '@consento/api/util'
import { AbstractIdleStrategy } from '../../util/StrategyControl'
import { format } from 'url'
import fetch from 'cross-fetch'
import urlParse from 'url-parse'

interface IURLParts {
  protocol: string
  username: string
  password: string
  host: string
  port: string
  pathname: string
}

function getURLParts (address: string): IURLParts {
  const url = urlParse(address)
  return {
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    port: url.port,
    pathname: url.pathname
  }
}

export async function runFetch (parts: IURLParts, type: string, query: { [key: string]: any }, opts: ITimeoutOptions): Promise<any> {
  return await wrapTimeout(
    async signal => {
      const url = format({
        ...parts,
        pathname: `${parts.pathname}${type}`,
        query
      })
      const res = await fetch(url, {
        method: 'POST',
        signal
      })
      const text = await res.text()
      if (res.status !== 200) {
        throw new Error(`HTTP Request failed[${res.status.toString()}] → ${text}\n${url}`)
      }
      try {
        return JSON.parse(text)
      } catch (err) {
        throw new Error(`HTTP Response not valid JSON. (Error: ${String(err.message)})\n${text}`)
      }
    },
    opts
  )
}

export async function fetchFromAddress (address: string, type: string, query: { [key: string]: any }, opts: ITimeoutOptions): Promise<any> {
  return await runFetch(getURLParts(address), type, query, opts)
}

export class FetchStrategy extends AbstractIdleStrategy<EClientStatus, IExpoTransportStrategy> implements IExpoTransportStrategy {
  type = EClientStatus.FETCH
  request: (type: string, query: { [key: string]: any }, opts: ITimeoutOptions) => Promise<any>

  async run (state: IExpoTransportState, signal: AbortSignal): Promise<IExpoTransportStrategy> {
    const parts = getURLParts(state.address)
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    this.request = (type, query, opts) => runFetch(parts, type, query, opts)
    return await super.run(state, signal)
  }
}
