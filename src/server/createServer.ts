import express, { Express } from 'express'
import { AppOptions, createApp } from './createApp'

export function createServer (opts: AppOptions): Express {
  const app = createApp(opts)
  const server = express()
  server.post('/send', app.send)
  server.post('/subscribe', app.subscribe)
  server.post('/unsubscribe', app.unsubscribe)
  return server
}
