import { Strategy } from './strategy'
import { WSClient, MessageEvent } from '../WSClient'
import { cancelable, ICancelable } from '@consento/api'
import { timeoutPromise } from '../../util/timeoutPromise'
import { exists } from '../../util/exists'

export function webSocketUrl (webUrl: string): string {
  return webUrl.replace(/^http:\/\//g, 'ws://').replace(/^https:\/\//g, 'wss://')
}

const noop = (): any => {}

export function closeError (): Error {
  return Object.assign(new Error('Socket closed.'), { code: 'ESOCKETCLOSED', address: this._address })
}

export abstract class AbstractWebsocketStrategy extends Strategy {
  static _REQUEST_ID: number = 0

  _ws: WSClient
  _requests: { [rid: number]: (result: { error?: any, data?: any }) => void } = {}
  _handleMessage: (ev: MessageEvent) => void
  _close: (err?: Error) => any

  constructor (ws: WSClient) {
    super()
    this._ws = ws
    ws.onmessage = (ev: MessageEvent): void => {
      if (typeof ev.data !== 'string') {
        return
      }
      let data
      try {
        data = JSON.parse(ev.data)
      } catch (err) {
        console.log(err)
        return
      }
      if (data.type === 'response') {
        const res = this._requests[data.rid]
        if (res !== undefined) {
          res(data)
        }
        return
      }
      if (data.type !== 'message') {
        return
      }
      this.emit('input', { data: data.body })
    }
    this._close = (err?: Error) => {
      this._ws.onopen = noop
      this._ws.onerror = noop
      this._ws.onmessage = noop
      this._ws.close()
      if (err !== undefined) {
        throw err
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  request (type: string, query: { [ key: string ]: string }, timeout: number = 5000): ICancelable<string> {
    const rid = AbstractWebsocketStrategy._REQUEST_ID++
    if (rid === Number.MAX_SAFE_INTEGER) {
      AbstractWebsocketStrategy._REQUEST_ID = 0
    }
    const clear = (): void => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._requests[rid]
    }
    return cancelable<string, this>(function * () {
      return timeoutPromise<string>(timeout, (resolve, reject) => {
        this._requests[rid] = (result: { error?: any, body?: any }): void => {
          if (result.error !== undefined) {
            return reject(Object.assign(new Error(typeof result.error === 'string' ? result.error : `Unexpected Error: ${String(result.error)}`), result.error))
          }
          resolve(result.body)
        }
        this._ws.send(JSON.stringify({ type, rid, query }), (error: Error) => {
          if (exists(error)) reject(error)
        })
      })
    }, this).then(
      data => { clear(); return data },
      error => { clear(); throw error }
    )
  }
}
