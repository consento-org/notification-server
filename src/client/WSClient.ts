import WSWebSocket from 'ws'

export { MessageEvent, OpenEvent, CloseEvent, ErrorEvent } from 'ws'

// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
type WebSocketFactory = new (address: string) => WSWebSocket
const BuiltInWebSocket: WebSocketFactory = (global as any).WebSocket
const WebSocket = BuiltInWebSocket !== undefined ? BuiltInWebSocket : WSWebSocket

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {}

function isErrorEvent (event: any): event is WSWebSocket.ErrorEvent {
  return event.code === undefined && event.error !== undefined
}

export class WSClient {
  _autoReconnectInterval: number
  _url: string
  _instance: WSWebSocket
  onmessage: (event: WSWebSocket.MessageEvent) => any
  onopen: (event: WSWebSocket.OpenEvent) => any
  onclose: (event: WSWebSocket.CloseEvent) => any
  onerror: (event: WSWebSocket.ErrorEvent) => any
  onreconnect: () => any
  _onclose: (event: WSWebSocket.CloseEvent) => void
  _onerror: (event: WSWebSocket.ErrorEvent) => void
  _reconnecting: number | NodeJS.Timeout
  _reconnectEvent: WSWebSocket.ErrorEvent | WSWebSocket.CloseEvent
  _onopen: (event: WSWebSocket.OpenEvent) => void
  _onmessage: (event: WSWebSocket.MessageEvent) => void

  constructor ({ autoReconnectInterval = 500 }: { autoReconnectInterval?: number } = {}) {
    this._autoReconnectInterval = autoReconnectInterval
    this.onmessage = noop
    this.onopen = noop
    this.onclose = noop
    this.onerror = noop
    this.onreconnect = noop
    this._onopen = (event: WSWebSocket.OpenEvent) => {
      this.onopen(event)
    }
    this._onmessage = (event: WSWebSocket.MessageEvent) => {
      this.onmessage(event)
    }
    this._onclose = (event: WSWebSocket.CloseEvent) => {
      if (event.code !== 1000) {
        this.reconnect(event)
        return
      }
      this.onclose(event)
    }
    this._onerror = (event: WSWebSocket.ErrorEvent) => {
      if (event.error === undefined || event.error === null || event.error.type === 'ECONNREFUSED') {
        this.reconnect(event)
        return
      }
      this.onerror(event)
    }
  }

  open (url: string): void {
    if (this._url !== undefined) {
      throw new Error('Already open')
    }
    if (url === undefined) {
      throw new Error('Can not open an undefined URL')
    }
    this._url = url
    this._open()
  }

  _open (): void {
    this._instance = new WebSocket(this._url)
    this._instance.onopen = this._onopen
    this._instance.onmessage = this._onmessage
    this._instance.onclose = this._onclose
    this._instance.onerror = this._onerror
  }

  _send (attempt: number, data: any, cb?: (err?: Error) => void): void {
    if (this._instance === undefined) {
      if (cb !== undefined) {
        setImmediate(cb, new Error('Not open'))
      }
      return
    }
    if (this._instance.readyState !== 1) {
      if (attempt === 5) {
        if (cb !== undefined) {
          setImmediate(cb, new Error('No connection after 500ms.'))
        }
      } else {
        setTimeout(() => this._send(attempt + 1, data, cb), 100)
      }
      return
    }
    this._instance.send(data, cb)
  }

  send (data: any, cb?: (err?: Error) => void): void {
    this._send(0, data, cb)
  }

  close (code?: number, data?: string): void {
    if (this._instance !== undefined) {
      this._instance.close(code, data)
    }
    if (this._reconnecting !== undefined) {
      if (typeof this._reconnecting === 'number') {
        clearTimeout(this._reconnecting)
      } else {
        // Typescript :-/
        clearTimeout(this._reconnecting)
      }
      const reconnectEvent = this._reconnectEvent
      this._reconnectEvent = undefined
      if (isErrorEvent(reconnectEvent)) {
        this.onerror(reconnectEvent)
        return
      }
      this.onclose(reconnectEvent)
    }
  }

  _close (): void {
    if (this._instance !== undefined) {
      this._instance.onopen = undefined
      this._instance.onmessage = undefined
      this._instance.onclose = undefined
      this._instance.onerror = undefined
      this._instance = undefined
    }
  }

  reconnect (event: WSWebSocket.ErrorEvent | WSWebSocket.CloseEvent): void {
    this._close()
    if (this._url !== undefined && this._reconnecting === undefined) {
      this.onreconnect()
      this._reconnectEvent = event
      this._reconnecting = setTimeout(() => {
        this._reconnecting = undefined
        this._reconnectEvent = undefined
        this._open()
      }, this._autoReconnectInterval)
    }
  }
}
