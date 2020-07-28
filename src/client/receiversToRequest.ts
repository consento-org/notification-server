import * as Notifications from 'expo-notifications'
import { IReceiver } from '@consento/api'
import { bufferToString, Buffer, IAbortOptions } from '@consento/api/util'
import map from '@extra-iterable/map'
import join from '@extra-iterable/join'
import pMap from 'p-map'
import { checkpoint } from '@consento/crypto/util/abort'

export interface IRequest {
  [key: string]: string
  idsBase64: string
  signaturesBase64: string
  pushToken: string
}

const concurrency = 5

export async function receiversToRequest (token: Notifications.ExpoPushToken, receivers: Iterable<IReceiver>, { signal }: IAbortOptions = {}): Promise<IRequest> {
  const pushToken: string = token.data
  const pushTokenBuffer = Buffer.from(pushToken)
  const cp = checkpoint(signal)
  return {
    idsBase64: join(map(receivers, receiver => receiver.idBase64), ';'),
    signaturesBase64: (await cp(pMap(
      receivers,
      async receiver => bufferToString(await cp(receiver.sender.sign(pushTokenBuffer)), 'base64'),
      {
        concurrency
      }
    ))).join(';'),
    pushToken
  }
}
