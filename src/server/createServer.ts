import express, { Express, Request } from 'express'
import { AppOptions, createApp } from './createApp'

export function createServer (opts: AppOptions): Express {
  const app = createApp(opts)
  const server = express()
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

  server.post('/send', wrapAsync(app.send))
  server.post('/subscribe', wrapAsync(app.subscribe))
  server.post('/unsubscribe', wrapAsync(app.unsubscribe))
  return server
}
