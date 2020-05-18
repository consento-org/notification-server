import { cancelable, IReceiver, ICancelable } from '@consento/api'
import { bufferToString } from '@consento/crypto/util/buffer'

export interface IRequest {
  [key: string]: string
  idsBase64: string
  signaturesBase64: string
  pushToken: string
}

// eslint-disable-next-line @typescript-eslint/promise-function-async
export function receiversToRequest (token: Promise<string>, receivers: Iterable<IReceiver>): ICancelable<IRequest> {
  // eslint-disable-next-line @typescript-eslint/return-await
  return cancelable<IRequest>(function * () {
    const pushToken: string = yield token
    const idsBase64: string[] = []
    const signaturesBase64: string[] = []
    for (const receiver of receivers) {
      idsBase64.push(receiver.idBase64)
      const pushTokenBuffer = Buffer.from(pushToken)
      signaturesBase64.push(bufferToString(yield receiver.sender.sign(pushTokenBuffer), 'base64'))
    }
    return {
      idsBase64: idsBase64.join(';'),
      signaturesBase64: signaturesBase64.join(';'),
      pushToken
    }
  })
}
