import { StrategyControl, AbstractIdleStrategy, AbstractErrorStrategy, IStrategy } from '../StrategyControl'

describe('StrategyControl', () => {
  enum Simple {
    init = 'init',
    idle = 'idle',
    test = 'test',
    error = 'error',
    a = 'a',
    b = 'b',
    c = 'c',
    testAborted = 'test-aborted',
    testNext = 'test-next'
  }
  type SimpleStrategy = IStrategy<Simple, SimpleStrategy>

  class IdleStrategy extends AbstractIdleStrategy<Simple, SimpleStrategy> {
    type: Simple
    constructor (type: Simple = Simple.idle) {
      super()
      this.type = type
    }
  }

  class ErrorStrategy extends AbstractErrorStrategy<Simple, SimpleStrategy> {
    type: Simple
    constructor (error: Error, type: Simple = Simple.error) {
      super(error)
      this.type = type
    }
  }

  const simpleOpts = {
    state: {},
    idle: (): SimpleStrategy => new IdleStrategy(),
    error: (error: Error): SimpleStrategy => new ErrorStrategy(error)
  }

  it('simple idle to idle', async () => {
    const control = new StrategyControl<Simple, SimpleStrategy>(simpleOpts)
    expect(control.current.type).toBe(Simple.idle)
    control.change(new IdleStrategy(Simple.test))
    await control.awaitChange()
    expect(control.type).toBe(Simple.test)
  })
  it('null is turned into idle', async () => {
    const control = new StrategyControl<Simple, SimpleStrategy>({
      ...simpleOpts,
      init: {
        type: Simple.init,
        // eslint-disable-next-line @typescript-eslint/promise-function-async
        run: (_, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve())
        })
      }
    })
    expect(control.current.type).toBe('init')
    control.change(null)
    await control.awaitChange()
    expect(control.type).toBe('idle')
  })
  it('multiple changes without waiting will use the last only', async () => {
    const control = new StrategyControl<Simple, SimpleStrategy>(simpleOpts)
    const history: string[] = []
    control.on('change', () => {
      history.push(control.type)
    })
    control.change(new IdleStrategy(Simple.a))
    control.change(new IdleStrategy(Simple.b))
    control.change(new IdleStrategy(Simple.c))
    await control.awaitChange()
    expect(history).toMatchObject([Simple.c])
  })
  it('error in strategy results in error strategy', async () => {
    const control = new StrategyControl<Simple, SimpleStrategy>(simpleOpts)
    control.change({
      type: Simple.test,
      run: async () => {
        throw new Error('test-error')
      }
    })
    await control.awaitType(Simple.error)
    if (control.current instanceof ErrorStrategy) {
      expect(control.current.error.message).toBe('test-error')
    } else {
      fail(`Unexpected type: ${control.type}`)
    }
  })
  it('state is passed', async () => {
    interface state { x: number }
    const originalState = { x: 1 }
    const control = new StrategyControl<Simple, SimpleStrategy>({
      ...simpleOpts,
      state: originalState
    })
    expect(control.state).toBe(originalState)
    control.change({
      type: Simple.test,
      run: async (state) => {
        expect(state).toBe(originalState)
        return null
      }
    })
    await control.awaitChange()
  })
  it('signal aborted', async () => {
    const control = new StrategyControl<Simple, SimpleStrategy>(simpleOpts)
    let abortCalled = false
    control.change({
      type: Simple.test,
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      run: (_, signal) => new Promise(resolve => {
        signal.addEventListener('abort', () => {
          abortCalled = true
          resolve(new IdleStrategy(Simple.testAborted))
        })
      })
    })
    await control.awaitType(Simple.test)
    control.change({
      type: Simple.testNext,
      run: () => {
        expect(abortCalled).toBe(true)
        return null
      }
    })
    await control.awaitChange()
    expect(control.type).toBe(Simple.testNext)
  })
})
