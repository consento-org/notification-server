#!/usr/bin/env npx ts-node
import { createApp } from '../server/createApp'
import { createDb } from '../server/createDb'
import Expo from 'expo-server-sdk'

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

const app = createApp({
  db,
  log,
  logError,
  expo: new Expo({
  })
})

const port = ("PORT" in process.env) ? parseInt(process.env.PORT) : 3000
const listener = app.listen(port, (error: Error) => {
  log({
    start: listener.address(),
    error
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
