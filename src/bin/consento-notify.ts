#!/usr/bin/env npx ts-node
import { createServer } from '../server/createServer'
import { createDb } from '../server/createDb'
import Expo from 'expo-server-sdk'
import { resolve } from 'path'
import { VERSION } from '../version'

const DB_PATH = resolve(__dirname, ('NOTIFICATION_DB_PATH' in process.env) ? process.env.NOTIFICATION_DB_PATH : 'db')

function log (obj: any): void {
  console.log(JSON.stringify({
    date: new Date().toISOString(),
    ...obj
  }))
}

function logError (err: any): void {
  if (typeof err === 'object' && err.error instanceof Error) {
    err.error = {
      message: err.error.message,
      stack: err.error.stack,
      ...err.error
    }
  }
  console.error(JSON.stringify({
    date: new Date().toISOString(),
    ...err
  }))
}

const db = createDb({
  path: DB_PATH,
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
    dbPath: DB_PATH,
    version: VERSION
  })
}).on('error', (error: Error) => {
  logError({
    type: 'listener-error',
    error
  })
  process.exit(1)
})

process.on('beforeExit', () => {
  log({ type: 'closing' })
  listener.close((error) => {
    if (error !== null && error !== undefined) {
      return logError({
        type: 'closing-failed',
        error
      })
    }
    log({ type: 'closed' })
  })
})
