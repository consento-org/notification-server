import { cleanupPromise, ITimeoutOptions, wrapTimeout, exists, AbortError, AbortSignal, AbortController } from '@consento/api/util'
import { EventEmitter } from 'events'

// eslint-disable-next-line @typescript-eslint/promise-function-async
export function idle <TStrategy> (_: any, signal: AbortSignal): Promise<TStrategy> {
  return cleanupPromise(() => {
    return () => {}
  }, { signal })
}

export interface IStrategy<TType, TStrategy extends IStrategy<TType, TStrategy, TState>, TState = any> {
  type: TType

  // eslint-disable-next-line @typescript-eslint/method-signature-style
  run (state: TState, signal: AbortSignal): Promise<TStrategy>
}

export abstract class AbstractIdleStrategy <TType, TStrategy extends IStrategy<TType, TStrategy>, TState = any> implements IStrategy<TType, TStrategy, TState> {
  abstract type: TType

  // eslint-disable-next-line @typescript-eslint/promise-function-async
  run (_: any, signal: AbortSignal): Promise<TStrategy> {
    return cleanupPromise(() => {
      return () => {}
    }, { signal })
  }
}

export interface IErrorStrategy <TType, TStrategy extends IStrategy<TType, TStrategy>> extends IStrategy<TType, TStrategy, any> {
  error: Error
}

export abstract class AbstractErrorStrategy <TType, TStrategy extends IStrategy<TType, TStrategy>> extends AbstractIdleStrategy<TType, TStrategy> implements IErrorStrategy<TType, TStrategy> {
  error: Error

  constructor (error: Error) {
    super()
    this.error = error
  }
}

export interface IStrategyControlOptions <TState, TStrategy> {
  state: TState
  init?: TStrategy
  error: (error: Error) => TStrategy
  idle: () => TStrategy
}

export class StrategyControl <TType, TStrategy extends IStrategy<TType, TStrategy, TState>, TState = any> extends EventEmitter {
  #abort: () => void
  #error: (err: Error) => TStrategy
  #idle: () => TStrategy
  #current: TStrategy
  #next: TStrategy
  #state: TState

  constructor ({ state, init, error, idle }: IStrategyControlOptions<TState, TStrategy>) {
    super()
    this.#state = state
    this.#error = error
    this.#idle = idle
    this.#run(init ?? idle())
  }

  #run = (strategy: TStrategy): void => {
    const currentControl = new AbortController()
    this.#current = strategy
    this.#abort = currentControl.abort.bind(currentControl)
    this.emit('change')
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    strategy.run(this.#state, currentControl.signal)
      .catch(error => {
        if (error instanceof AbortError && exists(this.#next)) {
          return
        }
        return this.#error(error)
      })
      .then((next: TStrategy) => {
        const actualNext = this.#next ?? next ?? this.#idle()
        this.#next = undefined
        this.#run(actualNext)
      })
  }

  async awaitChange (opts: ITimeoutOptions = {}): Promise<void> {
    if (exists(opts.signal) && opts.signal.aborted) {
      throw new AbortError()
    }
    return await cleanupPromise(
      resolve => {
        this.on('change', resolve)
        return () => {
          this.off('change', resolve)
        }
      }
    )
  }

  async awaitType (type: TType, opts: ITimeoutOptions = {}): Promise<void> {
    return await wrapTimeout(
      async (signal) => {
        while (true) {
          if (this.type === type) {
            return
          }
          if (!exists(this.#next) && this.#current instanceof AbstractErrorStrategy) {
            throw this.#current.error
          }
          await this.awaitChange({ signal })
        }
      },
      opts
    )
  }

  get type (): TType {
    return this.#current.type
  }

  get current (): TStrategy {
    return this.#current
  }

  change (strategy: TStrategy): void {
    this.#next = strategy
    const abort = this.#abort
    this.#abort = () => {} // Prevent repeat aborts
    abort()
  }

  get state (): TState {
    return this.#state
  }
}
