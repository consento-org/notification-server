import Expo from 'expo-server-sdk'
import getRandomValues from 'get-random-values-polypony'
import { bufferToString } from '@consento/crypto/util/buffer'
import * as Notifications from 'expo-notifications'

function rndChar (num: number): string {
  return bufferToString(getRandomValues(new Uint8Array(num * 2)), 'hex')
}

export function createDummyExpoToken (): Notifications.ExpoPushToken {
  const prefix = Math.random() > 0.5 ? 'ExponentPushToken' : 'ExpoPushToken'
  return {
    type: 'expo',
    data: `${prefix}[eeee-${rndChar(2)}-${rndChar(4)}-${rndChar(4)}-${rndChar(12)}]`
  }
}

describe('expo token dummy util', () => {
  it('creates a random token', () => {
    const token = createDummyExpoToken()
    expect(Expo.isExpoPushToken(token.data)).toBeTruthy()
  })
})
