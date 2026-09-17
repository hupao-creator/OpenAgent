import { isAbsolute, join } from 'node:path'

export const HEADLESS_USER_DATA_SUFFIX = ' Headless'
export const DEV_USER_DATA_SUFFIX = ' Electron Dev'
/** Marks a directory as a disposable profile this app owns and may clear. */
export const DEV_PROFILE_MARKER = '.openagent-dev-profile'

export interface RuntimePathInput {
  readonly headless: boolean
  readonly homePath: string
  readonly userDataPath: string
  readonly headlessOpenAgentHome?: string
  /**
   * Moves attachment storage out of the shared OpenAgent home. A dev instance
   * that clears its Electron profile on every start would otherwise publish
   * its empty thread catalog into the shared attachment owner index, making
   * the other instance's attachments look like orphans.
   */
  readonly devAttachmentRoot?: string
}

export interface RuntimePaths {
  readonly attachmentRoot: string
  readonly bartCwd: string
  readonly openAgentHome: string
  readonly temporaryWorkspaceRoot: string
  readonly userDataPath: string
}

/**
 * Pick the Electron userData directory before app readiness. A caller may
 * provide a process-private absolute directory (the acceptance runner does),
 * otherwise interactive and headless processes receive stable sibling roots.
 */
export function resolveHeadlessUserDataPath(
  defaultUserDataPath: string,
  configuredPath?: string
): string {
  const configured = configuredPath?.trim()
  if (!configured) return `${defaultUserDataPath}${HEADLESS_USER_DATA_SUFFIX}`
  return requireAbsolutePath(configured, 'OPENAGENT_HEADLESS_USER_DATA')
}

/**
 * Pick the disposable dev userData directory. A caller may point it at a
 * process-private absolute directory so several dev instances can run at once
 * without resetting each other's profile.
 */
export function resolveDevUserDataPath(
  defaultUserDataPath: string,
  configuredPath?: string
): string {
  const configured = configuredPath?.trim()
  if (!configured) return `${defaultUserDataPath}${DEV_USER_DATA_SUFFIX}`
  return requireAbsolutePath(configured, 'OPENAGENT_DEV_USER_DATA')
}

/**
 * Resolve every mutable application-owned path from the same isolated root.
 * Native Harness configuration still resolves against the real OS home; only
 * OpenAgent-owned state, workspaces, and staged attachments are redirected.
 */
export function resolveRuntimePaths(input: RuntimePathInput): RuntimePaths {
  const configuredHeadlessHome = input.headlessOpenAgentHome?.trim()
  const openAgentHome = input.headless
    ? configuredHeadlessHome
      ? requireAbsolutePath(
          configuredHeadlessHome,
          'OPENAGENT_HEADLESS_HOME'
        )
      : join(input.homePath, '.OpenAgent-headless')
    : join(input.homePath, '.OpenAgent')
  const bartCwd = join(openAgentHome, 'bart-workspace')
  const configuredDevAttachmentRoot = input.devAttachmentRoot?.trim()
  const attachmentRoot = !input.headless && configuredDevAttachmentRoot
    ? requireAbsolutePath(configuredDevAttachmentRoot, 'OPENAGENT_DEV_ATTACHMENT_ROOT')
    : join(bartCwd, '.openagent', 'attachments')

  return {
    userDataPath: input.userDataPath,
    openAgentHome,
    bartCwd,
    temporaryWorkspaceRoot: join(openAgentHome, 'tmp-workspaces'),
    attachmentRoot
  }
}

function requireAbsolutePath(path: string, variableName: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${variableName} must be an absolute path`)
  }
  return path
}
