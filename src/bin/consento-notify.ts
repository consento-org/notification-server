#!/usr/bin/env npx ts-node
import { createServer } from '../server/createServer'
import { createDb } from '../server/createDb'
import Expo from 'expo-server-sdk'

// Using this directly from package.json breaks the release task
const VERSION = '0.0.8'

function log (obj: any): void {
  console.log(JSON.stringify({
    date: new Date().toISOString(),
    ...obj
  }))
}

function logError (obj: any): void {
  console.error(JSON.stringify({
    date: new Date().toISOString(),
    ...obj
  }))
}

const db = createDb({
  path: './db',
  log,
  maxSubscriptions: 1000,
  replicate: false
})

const app = createServer({
  db,
  log,
  logError,
  expo: new Expo({
  })
})

const port = ('PORT' in process.env) ? parseInt(process.env.PORT) : 3000
const listener = app.listen(port, (error: Error) => {
  log({
    start: listener.address(),
    error,
    version: VERSION
  })
}).on('error', (error: Error) => {
  logError({
    error
  })
  process.exit(1)
})

process.on('beforeExit', () => {
  listener.close(() => {
    console.log({
      closed: true
    })
  })
})
