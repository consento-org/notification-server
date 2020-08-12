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

const PING_TIME = 750
const TIMEOUT_TIME = PING_TIME * 4

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
    let lastOpen: number
    const newWs = (old?: WebSocket): WebSocket => {
      const ws = new WebSocket(webSocketUrl(address))
      lastOpen = Date.now()
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
      let lastMessage = Date.now()
      ws.onmessage = (ev: MessageEvent): void => {
        lastMessage = Date.now()
        if (typeof ev.data !== 'string') {
          return
        }
        if (ev.data === '"pong"') {
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
          clearInterval(pingInterval)
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
        setTimeout(restart, PING_TIME)
      }

      let lastClosing = -1
      const pingInterval = setInterval(() => {
        if (ws.readyState === WS_STATE.connecting) {
          if (Date.now() - lastOpen > TIMEOUT_TIME) {
            ws.close(4001, 'connecting-timeout')
            return
          }
        }
        if (ws.readyState === WS_STATE.closing) {
          if (lastClosing < lastOpen) {
            lastClosing = Date.now()
          } else if (Date.now() - lastClosing > TIMEOUT_TIME) {
            ws.onclose({ target: ws, code: 4001, reason: 'closing timed out', wasClean: false })
          }
          return
        }
        if (ws.readyState !== WS_STATE.ready) {
          return
        }
        const timePassed = Date.now() - lastMessage
        if (timePassed > TIMEOUT_TIME) {
          ws.close(4000, 'connection-timeout')
        } else if (timePassed > PING_TIME) {
          // Don't send ping if other message has been sent!
          ws.send('"ping"')
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
            }
          },
          opts
        )
      }
    })
  }
}
