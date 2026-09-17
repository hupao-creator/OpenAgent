import { describe, expect, it } from 'vitest'
import {
  isFixedDevelopmentAppRuntime,
  isPackagedRuntime
} from '../src/shared/development-runtime'

describe('fixed development app runtime', () => {
  it('treats the installed development app as a development runtime', () => {
    const environment = {
      OPENAGENT_DEV_APP: '1',
      NODE_ENV_ELECTRON_VITE: 'development'
    }

    expect(isFixedDevelopmentAppRuntime(environment)).toBe(true)
    expect(isPackagedRuntime(true, environment)).toBe(false)
  })

  it.each([
    {},
    { OPENAGENT_DEV_APP: '1' },
    { NODE_ENV_ELECTRON_VITE: 'development' },
    { OPENAGENT_DEV_APP: '1', NODE_ENV_ELECTRON_VITE: 'production' }
  ])('does not weaken packaged behavior without both development markers', (environment) => {
    expect(isFixedDevelopmentAppRuntime(environment)).toBe(false)
    expect(isPackagedRuntime(true, environment)).toBe(true)
  })
})
