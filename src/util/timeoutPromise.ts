// eslint-disable-next-line @typescript-eslint/promise-function-async
export function timeoutPromise <Result> (timeout: number, op: (resolve: (data: Result) => void, reject: (reason: Error) => void) => void): Promise<Result> {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(Object.assign(new Error(`Timeout. [t=${timeout}]`), { code: 'ETIMEOUT', timeout }))
    }, timeout)
    op(
      data => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(data)
      },
      reason => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(reason)
      }
    )
  })
}
