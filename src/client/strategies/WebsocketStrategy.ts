import { EClientStatus, IExpoTransportStrategy, IExpoTransportState } from './strategy'
import { bubbleAbort, AbortError, ITimeoutOptions, cleanupPromise, exists } from '@consento/api/util'
import WebSocket, { MessageEvent } from 'isomorphic-ws'

export function webSocketUrl (address: string): string {
  return address.replace(/^http:\/\//g, 'ws://').replace(/^https:\/\//g, 'wss://')
}

const noop = (): any => {}

export function closeError (): Error {
  return Object.assign(new Error('Socket closed.'), { code: 'ESOCKETCLOSED', address: this._address })
}

const PING_TIME = 2500
let REQUEST_ID: number = 0

// On React-native: WebSocket.OPEN/../ isn't defined?
enum WS_STATE {
  ready = 1,
  connecting = 2,
  closing = 3,
  closed = 4
}

export class WebsocketStrategy implements IExpoTransportStrategy {
  type = EClientStatus.WEBSOCKET

  request: (type: string, query: { [ key: string ]: string }, opts: ITimeoutOptions) => Promise<any>

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run ({ address, handleInput }: IExpoTransportState, signal: AbortSignal): Promise<IExpoTransportStrategy> {
    const newWs = (old?: WebSocket): WebSocket => {
      const ws = new WebSocket(webSocketUrl(address))
      if (old !== undefined) {
        ws.onmessage = old.onmessage
        ws.onerror = old.onerror
        ws.onclose = old.onclose
        ws.onopen = old.onopen
        old.onopen = noop
        old.onerror = noop
        old.onmessage = noop
        old.onclose = noop
      }
      return ws
    }
    return new Promise((resolve, reject) => {
      let ws = newWs()
      const requests: { [key: number]: (result: { error?: any, body?: any }) => void } = {}
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
          const res = requests[data.rid]
          if (res !== undefined) {
            res(data)
          }
          return
        }
        if (data.type !== 'message') {
          return
        }
        handleInput({ data: data.body })
      }
      let closed = false
      const close = (err?: Error): void => {
        closed = true
        ws.onopen = noop
        ws.onerror = noop
        ws.onmessage = noop
        const finish = (): void => {
          ws.onclose = noop
          if (exists(err)) {
            reject(err)
          } else {
            resolve()
          }
        }
        if (ws.readyState === WS_STATE.ready || ws.readyState === WS_STATE.connecting) {
          ws.onclose = finish
          ws.close()
        } else {
          finish()
        }
      }
      const onabort = (): void => close(new AbortError())

      signal.addEventListener('abort', onabort)

      let wsOpen = newOpenPromise()
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      function newOpenPromise (): Promise<void> {
        return new Promise<void>(resolve => {
          ws.onopen = () => resolve()
        })
      }
      ws.onerror = (error: any) => {
        console.warn('[Warning] Websocket connection terminated with error.\n%o', error)
      }
      function restart (): void {
        if (closed) return
        ws = newWs(ws)
      }

      ws.onclose = () => {
        ws.onclose = noop
        wsOpen = newOpenPromise()
        setTimeout(restart, 1000)
      }

      const pingInterval = setInterval(() => {
        if (ws.readyState === WS_STATE.ready) {
          ws.send('ping')
        }
      }, PING_TIME)

      this.request = async (type, query, opts) => {
        return await cleanupPromise(
          async (resolve, reject, signal): Promise<() => void> => {
            await wsOpen
            bubbleAbort(signal)
            const rid = REQUEST_ID++
            requests[rid] = (result: { error?: any, body?: any }): void => {
              if (result.error !== undefined) {
                return reject(Object.assign(new Error(typeof result.error === 'string' ? result.error : `Unexpected Error: ${String(result.error)}`), result.error))
              }
              resolve(result.body)
            }
            ws.send(JSON.stringify({ type, rid, query }))
            return () => {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
              delete requests[rid]
              clearInterval(pingInterval)
            }
          },
          opts
        )
      }
    })
  }
}
