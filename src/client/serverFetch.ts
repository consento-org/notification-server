import { ICancelable, cancelable } from '@consento/api'
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

async function runFetch (parts: IURLParts, type: string, query: { [key: string]: any }): Promise<any> {
  const opts = {
    ...parts,
    pathname: `${parts.pathname}${type}`,
    query
  }
  // eslint-disable-next-line no-return-await
  return await fetch(format(opts), {
    method: 'POST'
  }).then(async res => {
    const text = await res.text()
    if (res.status !== 200) {
      throw new Error(`HTTP Request failed[${res.status.toString()}] → ${text}
${JSON.stringify(opts, null, 2)}`)
    }
    try {
      const data = JSON.parse(text)
      return data
    } catch (err) {
      throw new Error(`HTTP Response not valid JSON.
${text}`)
    }
  })
}

export function serverFetch (address: string): (type: string, query: { [key: string]: any }) => ICancelable<any> {
  const parts = getURLParts(address)
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return (type, query) => cancelable<any>(function * () {
    return yield runFetch(parts, type, query)
  })
}
