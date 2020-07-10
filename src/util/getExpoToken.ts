import * as Permissions from 'expo-permissions'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import getRandomValues from 'get-random-values-polypony'
import { bufferToString } from '@consento/crypto/util/buffer'

function rndChar (num: number): string {
  return bufferToString(getRandomValues(new Uint8Array(num * 2)), 'hex')
}

function randomDummyExpoToken (): Notifications.ExpoPushToken {
  const prefix = Math.random() > 0.5 ? 'ExponentPushToken' : 'ExpoPushToken'
  return {
    type: 'expo',
    data: `${prefix}[eeee-${rndChar(2)}-${rndChar(4)}-${rndChar(4)}-${rndChar(12)}]`
  }
}

async function requestPermission (permission: Permissions.PermissionType): Promise<Permissions.PermissionInfo> {
  const result: Permissions.PermissionResponse = await Permissions.getAsync(permission)
  return result.permissions[permission]
}

async function _getExpoToken (): Promise<Notifications.ExpoPushToken> {
  const { status: existingStatus } = await requestPermission(Permissions.NOTIFICATIONS)

  // only ask if permissions have not already been determined, because
  // iOS won't necessarily prompt the user a second time.
  if (existingStatus !== 'granted') {
    // Android remote notification permissions are granted during the app
    // install, so this will only ask on iOS
    const { status: finalStatus } = await requestPermission(Permissions.NOTIFICATIONS)

    // Stop here if the user did not grant permissions
    if (finalStatus !== 'granted') {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw Object.assign(new Error('Permission to receive Notifications not granted!'), {
        status: finalStatus
      })
    }
  }

  // Get the token that uniquely identifies this device
  try {
    return await Notifications.getExpoPushTokenAsync()
  } catch (error) {
    if (Constants.debugMode) {
      console.warn(`[DEV MODE ONLY!] Error while collecting expo token, using dummy token: ${String(error)}`)
      return randomDummyExpoToken()
    }
    throw error
  }
}

const expoToken = _getExpoToken()

export async function getExpoToken (): Promise<Notifications.ExpoPushToken> {
  return await expoToken
}
