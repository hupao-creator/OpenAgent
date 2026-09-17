type RuntimeEnvironment = Record<string, string | undefined>

export function isFixedDevelopmentAppRuntime(
  environment: RuntimeEnvironment
): boolean {
  return (
    environment.OPENAGENT_DEV_APP === '1' &&
    environment.NODE_ENV_ELECTRON_VITE === 'development'
  )
}

export function isPackagedRuntime(
  electronReportsPackaged: boolean,
  environment: RuntimeEnvironment
): boolean {
  return electronReportsPackaged && !isFixedDevelopmentAppRuntime(environment)
}
