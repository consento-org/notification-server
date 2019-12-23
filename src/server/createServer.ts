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
  rid: number
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
  if (typeof data.rid !== 'number') {
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
        .then(
          async body => new Promise(resolve => {
            log({ response: { rid: data.rid, body } })
            socket.send(JSON.stringify({
              type: 'response',
              rid: data.rid,
              body
            }), (error: Error) => {
              if (error !== null && error !== undefined) {
                logError({
                  type: 'websocket-success-error',
                  error
                })
              }
              resolve()
            })
          }),
          async error => new Promise(resolve => {
            logError({
              type: 'websocket-error',
              data,
              rid: data.rid,
              error
            })
            socket.send(JSON.stringify({
              type: 'response',
              rid: data.rid,
              error: {
                message: 'Error.',
                code: '505'
              }
            }), (error: Error) => {
              if (error !== null && error !== undefined) {
                logError({
                  type: 'websocket-error-error',
                  error
                })
              }
              resolve()
            })
          })
        ).catch(error => {
          logError({
            type: 'websocket-send-error',
            error
          })
        })
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
