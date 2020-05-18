import { ICancelable, cancelable } from '@consento/api'

// eslint-disable-next-line @typescript-eslint/promise-function-async
export function cancelableReject<T = any> (error: any): ICancelable<T> {
  return cancelable(function * () {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw error
  }, this)
}
