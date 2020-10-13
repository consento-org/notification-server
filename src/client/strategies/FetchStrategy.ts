import { IExpoTransportStrategy, EClientStatus, IExpoTransportState } from './strategy'
import { ITimeoutOptions, wrapTimeout, AbortSignal, exists } from '@consento/api/util'
import { AbstractIdleStrategy } from '../../util/StrategyControl'
import { format } from 'url'
import fetch from 'cross-fetch'
import urlParse from 'url-parse'
import { ErrorStrategy } from './ErrorStrategy'

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
  const url = format({
    ...parts,
    pathname: `${parts.pathname}${type}`,
    query
  })
  const promise = wrapTimeout(
    async signal => {
      const res = await fetch(url, {
        method: 'POST',
        signal
      })
      const text = await res.text()
      if (res.status !== 200) {
        const status = res.status
        throw Object.assign(new Error(`Status Error [status=${status.toString()}] → ${text}`), { text, status })
      }
      try {
        return JSON.parse(text)
      } catch (cause) {
        throw Object.assign(new Error(`HTTP Response from ${url} not valid JSON. (Error: ${(cause as Error).message})\n${text}`), { cause, text })
      }
    },
    opts
  )
  try {
    return await promise
  } catch (cause) {
    throw Object.assign(new Error(`Error while fetching ${url}:\n${(cause as Error).message}`), { cause, url })
  }
}

export async function fetchFromAddress (address: string, type: string, query: { [key: string]: any }, opts: ITimeoutOptions): Promise<any> {
  return await runFetch(getURLParts(address), type, query, opts)
}

async function noopAsync (): Promise<void> {}

export class FetchStrategy extends AbstractIdleStrategy<EClientStatus, IExpoTransportStrategy> implements IExpoTransportStrategy {
  type = EClientStatus.FETCH
  request: (type: string, query: { [key: string]: any }, opts: ITimeoutOptions) => Promise<any> = noopAsync

  async run (state: IExpoTransportState, signal: AbortSignal): Promise<IExpoTransportStrategy> {
    const { address } = state
    if (!exists(address)) {
      return new ErrorStrategy(new Error('Address required to run in the background'))
    }
    const parts = getURLParts(address)
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    this.request = (type, query, opts) => runFetch(parts, type, query, opts)
    return await super.run(state, signal)
  }
}
