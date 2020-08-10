import { AddressInfo } from 'net'
import { randomBytes } from 'crypto'
import express, { Request } from 'express'
import WebSocket from 'ws'
import { AppOptions, createApp } from './createApp'
import { VERSION, NAME } from '../package'

export type CB = (error?: Error) => void

export interface INotificationServerListener {
  address: () => string | AddressInfo
  close: (cb: CB) => void
  on: (error: 'error', handler: (error: Error) => void) => this
}

export interface INotificationServer {
  listen: (port: number, cb: CB) => INotificationServerListener
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
  const { logError, log } = opts

  const wrapAsync = (op: (query: { [key: string]: any }) => Promise<any>) => (req: Request) => {
    log({ via: 'http' })
    op(req.query)
      .then(data => {
        req.res.status(200).send(JSON.stringify(data)).end()
      })
      .catch(error => {
        if (error.httpCode !== undefined) {
          req.res.status(error.httpCode).end(error.message)
        } else {
          logError({
            type: 'http-error',
            query: req.query,
            error
          })
          req.res.status(500).send('Error.')
        }
      })
  }
  http.all('/', (req: Request) => { req.res.send({ server: NAME, version: VERSION }).end() })
  http.post('/send', wrapAsync(app.send))
  http.post('/subscribe', wrapAsync(app.subscribe))
  http.post('/unsubscribe', wrapAsync(app.unsubscribe))
  http.post('/reset', wrapAsync(app.reset))
  http.post('/compatible', wrapAsync(app.compatible))
  http.get('/version', (req: Request) => { req.res.send(VERSION).end() })

  function handleConnection (socket: WebSocket): void {
    const session = randomBytes(8).toString('hex')
    socket.onmessage = (event: WebSocket.MessageEvent) => {
      if (typeof event.data !== 'string') {
        return
      }
      if (event.data === '"ping"') {
        return '"pong"'
      }
      let data: any
      try {
        data = JSON.parse(event.data)
      } catch (error) {
        logError({
          type: 'json-parse-error',
          error
        })
        return
      }
      if (!isOkMessage(data)) {
        logError({
          type: 'unexpected-message-received',
          error: Object.assign(new Error(), { data })
        })
        return
      }
      ;(async () => {
        if (data.type === 'send') {
          log({ via: 'websocket', rid: data.rid, type: data.type, session })
          // eslint-disable-next-line @typescript-eslint/return-await
          return app.send(data.query)
        }
        if (data.type === 'subscribe') {
          log({ via: 'websocket', rid: data.rid, type: data.type, session })
          // eslint-disable-next-line @typescript-eslint/return-await
          return app.subscribe(data.query, session, event.target)
        }
        if (data.type === 'unsubscribe') {
          log({ via: 'websocket', rid: data.rid, type: data.type, session })
          // eslint-disable-next-line @typescript-eslint/return-await
          return app.unsubscribe(data.query)
        }
        if (data.type === 'reset') {
          log({ via: 'websocket', rid: data.rid, type: data.type, session })
          // eslint-disable-next-line @typescript-eslint/return-await
          return app.reset(data.query, session, event.target)
        }
        if (data.type === 'compatible') {
          // eslint-disable-next-line @typescript-eslint/return-await
          return app.compatible(data.query)
        }
        if (data.type === 'version') {
          return VERSION
        }
      })()
        .then(
          // eslint-disable-next-line @typescript-eslint/return-await
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
          // eslint-disable-next-line @typescript-eslint/return-await
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
      const server = http.listen(port)
      const wss = new WebSocket.Server({ server })
      wss.on('listening', cb)
      wss.on('connection', handleConnection)
      return server
    }
  }
}
