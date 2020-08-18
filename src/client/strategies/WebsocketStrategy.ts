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

const TICK_TIME = 50
const PING_TIME = 750
const TIMEOUT_TIME = PING_TIME * 4
const PING_TICKS = PING_TIME / TICK_TIME
const TIMEOUT_TICKS = TIMEOUT_TIME / TICK_TIME

let REQUEST_ID: number = 0

// On React-native: WebSocket.OPEN/../ isn't defined?
enum WS_STATE {
  ready = 1,
  connecting = 2,
  closing = 3,
  closed = 4
}

interface IExtendedWebsocket extends WebSocket {
  openPromise?: Promise<void>
  _resolveOpen?: (next?: Promise<void>) => void
}

export class WebsocketStrategy implements IExpoTransportStrategy {
  type = EClientStatus.WEBSOCKET

  request: (type: string, query: { [ key: string ]: string }, opts: ITimeoutOptions) => Promise<any>

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run ({ address, handleInput }: IExpoTransportState, signal: AbortSignal): Promise<IExpoTransportStrategy> {
    let lastOpen: number
    let lastMessage: number
    let tick = 0
    const newWs = (old?: IExtendedWebsocket): IExtendedWebsocket => {
      const ws = new WebSocket(webSocketUrl(address)) as IExtendedWebsocket
      lastOpen = tick
      ws.openPromise = new Promise(resolve => {
        lastMessage = tick
        ws._resolveOpen = resolve
        ws.onopen = () => resolve()
      })
      if (old !== undefined) {
        ws.onmessage = old.onmessage
        ws.onerror = old.onerror
        ws.onclose = old.onclose
        old.onerror = noop
        old.onmessage = noop
        old.onclose = noop
        old._resolveOpen(ws.openPromise)
      }
      return ws
    }
    return new Promise((resolve, reject) => {
      let ws = newWs()
      const tickInterval = setInterval(() => {
        tick += 1
        if (ws.readyState === WS_STATE.connecting) {
          if (tick > lastOpen + TIMEOUT_TICKS) {
            ws.close(4001, 'connecting-timeout')
            return
          }
        }
        if (ws.readyState === WS_STATE.closing) {
          if (lastClosing < lastOpen) {
            lastClosing = tick
          } else if (tick > lastClosing + TIMEOUT_TICKS) {
            ws.onclose({ target: ws, code: 4001, reason: 'closing timed out', wasClean: false })
          }
          return
        }
        if (ws.readyState !== WS_STATE.ready) {
          return
        }
        const ticksSinceLastMessage = tick - lastMessage
        if (ticksSinceLastMessage > TIMEOUT_TICKS) {
          ws.close(4000, 'client-timeout')
        } else if (ticksSinceLastMessage > PING_TICKS) {
          // Don't send ping if other message has been sent!
          ws.send('"ping"')
        }
      }, TICK_TIME)
      const requests: { [key: number]: (result: { error?: any, body?: any }) => void } = {}
      ws.onmessage = (ev: MessageEvent): void => {
        lastMessage = tick
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
        signal.removeEventListener('abort', onabort)
        const finish = (): void => {
          clearInterval(tickInterval)
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

      ws.onerror = (error: any) => {
        console.warn('[Warning] Websocket connection terminated with error.\n%o', error)
      }
      function restart (): void {
        if (closed) return
        ws = newWs(ws)
      }

      ws.onclose = () => {
        ws.onclose = noop
        ws.openPromise = new Promise((resolve) => {
          setTimeout(() => {
            restart()
            resolve(ws.openPromise)
          }, PING_TIME / 2)
        })
        setTimeout(restart, PING_TIME)
      }

      let lastClosing = -1

      this.request = async (type, query, opts) => {
        return await cleanupPromise(
          async (resolve, reject, signal): Promise<() => void> => {
            await ws.openPromise
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
