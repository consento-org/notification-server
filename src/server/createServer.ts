import { AddressInfo } from 'net'
import { randomBytes } from 'crypto'
import express, { Request } from 'express'
import WebSocket from 'ws'
import { AppOptions, createApp } from './createApp'

export type CB = (error?: Error) => void

export interface INotificationServerListener {
  address (): string | AddressInfo
  close (cb: CB): void
  on (error: 'error', handler: (error: Error) => void): this
}

export interface INotificationServer {
  listen (port: number, cb: CB): INotificationServerListener
}

function isOkMessage (data: any): data is {
  type: string
  query: any
} {
  if (typeof data !== 'object') {
    return false
  }
  if (typeof data.type !== 'string') {
    return false
  }
  if (typeof data.query !== 'object') {
    return false
  }
  return data
}

export function createServer (opts: AppOptions): INotificationServer {
  const app = createApp(opts)
  const http = express()
  const { logError } = opts

  const wrapAsync = (op: (query: { [key: string]: any }) => Promise<any>) => (req: Request) => {
    op(req.query)
      .then(data => {
        req.res.status(200).end(JSON.stringify(data))
      })
      .catch(error => {
        if (error.httpCode !== undefined) {
          req.res.status(error.httpCode).end(error.message)
        } else {
          logError({
            type: 'http-error',
            error
          })
          req.res.status(500).send('Error.')
        }
      })
  }
  http.post('/send', wrapAsync(app.send))
  http.post('/subscribe', wrapAsync(app.subscribe))
  http.post('/unsubscribe', wrapAsync(app.unsubscribe))

  function handleConnection (socket: WebSocket): void {
    const session = randomBytes(32).toString('hex')
    socket.onmessage = (event: WebSocket.MessageEvent) => {
      if (typeof event.data !== 'string') {
        return
      }
      let data: any
      try {
        data = JSON.parse(event.data)
      } catch (error) {
        logError(error)
        return
      }
      if (!isOkMessage(data)) {
        logError(Object.assign(new Error('unexpected-message-received'), { data }))
        return
      }
      ;(async () => {
        if (data.type === 'send') {
          return app.send(data.query)
        }
        if (data.type === 'subscribe') {
          return app.subscribe(data.query, session, event.target)
        }
        if (data.type === 'unsubscribe') {
          return app.unsubscribe(data.query)
        }
      })()
        .catch(logError)
    }
    socket.onclose = () => {
      app.closeSocket(session)
    }
  }

  return {
    listen (port, cb: CB) {
      const server = http.listen(port, cb)
      const wss = new WebSocket.Server({ server })
      wss.on('connection', handleConnection)
      return server
    }
  }
}
