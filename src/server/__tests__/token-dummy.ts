import { randomBytes } from 'crypto'
import Expo from 'expo-server-sdk'

function rndChar (num: number): string {
  return randomBytes(num * 2).toString('hex')
}

export function createDummyExpoToken (): string {
  const prefix = Math.random() > 0.5 ? 'ExponentPushToken' : 'ExpoPushToken'
  return `${prefix}[${rndChar(8)}-${rndChar(4)}-${rndChar(4)}-${rndChar(4)}-${rndChar(12)}]`
}

describe('expo token dummy util', () => {
  it('creates a random token', () => {
    const token = createDummyExpoToken()
    expect(Expo.isExpoPushToken(token)).toBeTruthy()
  })
})
