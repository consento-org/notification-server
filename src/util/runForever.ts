import { ICancelable, cancelable } from '@consento/api'

// eslint-disable-next-line @typescript-eslint/promise-function-async
export function runForever<T = any> (): ICancelable<T> {
  return cancelable<T>(function * () {
    yield new Promise((resolve, reject) => {})
  })
}
