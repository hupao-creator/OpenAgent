import { isAbsolute } from 'node:path'
import {
  BartSubmitRequestSchema, BartAttachmentImportsSchema, FollowUpThreadRequestSchema,
  ThreadInteractionResponseSchema, ReadThreadRequestSchema, ForkThreadRequestSchema,
  HarnessExtensionRequestSchema, OpenAgentUiStateUpdateSchema, CommandThreadIdSchema,
  CommandReportIdSchema, CommandArchivedSchema, ExternalUrlSchema, commandJsonSize, parseCommand,
  type AgentInput
} from '@openagent/contracts'
import {
  parseOpenAgentSettings, UpdateThreadSettingsRequestSchema,
  HarnessSettingsPresentationRequestSchema
} from '../shared/openagent-settings'
import { isHarnessId } from '../shared/harnesses'
import type { OpenAgentService } from './openagent-service'
import type { AttachmentRepository } from './services/attachment-repository'

/** Only application commands are visible to transports. */
export type CommandService = Pick<OpenAgentService,
  | 'submitBartMessage'
  | 'clearBartSession'
  | 'cancelBartTask'
  | 'clearAllHistory'
  | 'followUpThread'
  | 'interruptThread'
  | 'respondToThreadInteraction'
  | 'readThread'
  | 'forkThread'
  | 'updateThreadSettings'
  | 'updateAppSettings'
  | 'detectHarnessInstallations'
  | 'listKnownDirectories'
  | 'installHarness'
  | 'loadHarnessSettingsPresentation'
  | 'invokeHarnessExtension'
  | 'setThreadArchived'
  | 'setReportArchived'
  | 'loadRendererState'
  | 'updateUiState'
>

export interface CommandRuntimeServices {
  readonly attachmentStore: Pick<AttachmentRepository, 'stage' | 'isManagedPath'>
  readonly openExternal: (url: string) => Promise<void>
}

/** Public command surface shared by GUI IPC and the loopback headless transport. */
export const COMMAND_CHANNELS = [
  'bart:submit',
  'bart:clear',
  'bart:stage-attachments',
  'bart:cancel',
  'history:clear',
  'thread:follow-up',
  'thread:interrupt',
  'thread:interaction-respond',
  'thread:read',
  'thread:fork',
  'thread:update-settings',
  'app:update-settings',
  'harness:detect-installations',
  'workspace:list-known-directories',
  'harness:install',
  'harness:settings-presentation',
  'harness:extension',
  'thread:set-archived',
  'report:set-archived',
  'state:load',
  'state:update-ui',
  'shell:open-external'
] as const

export type CommandChannel = (typeof COMMAND_CHANNELS)[number]

export function isCommandChannel(value: string): value is CommandChannel {
  return (COMMAND_CHANNELS as readonly string[]).includes(value)
}

export type ChannelHandler = (...args: unknown[]) => Promise<unknown> | unknown

/**
 * The GUI and headless modes share these exact command handlers. The transports
 * add only their own trust boundary and event delivery.
 */
export function createChannelHandlers(
  service: CommandService,
  runtimeServices: CommandRuntimeServices
): Record<CommandChannel, ChannelHandler> {
  const { attachmentStore } = runtimeServices

  return {
    'bart:submit': async (rawRequest: unknown) => {
      const request = parseCommand(BartSubmitRequestSchema, rawRequest)
      validateInputPaths(request.input, attachmentStore)
      await service.submitBartMessage(request)
    },

    'bart:clear': async () => {
      await service.clearBartSession()
    },

    'bart:stage-attachments': async (rawImports: unknown) => {
      const imports = parseCommand(BartAttachmentImportsSchema, rawImports)
      imports.forEach(item => {
        if (item.source === 'path' && !isAbsolute(item.path)) throw new Error('附件路径无效')
      })
      return attachmentStore.stage(imports)
    },

    'bart:cancel': async () => {
      await service.cancelBartTask()
    },

    'history:clear': async () => {
      await service.clearAllHistory()
    },

    'thread:follow-up': async (rawRequest: unknown) => {
      const request = parseCommand(FollowUpThreadRequestSchema, rawRequest)
      validateInputPaths(request.input, attachmentStore)
      await service.followUpThread(request)
    },

    'thread:interrupt': async (rawThreadId: unknown) => {
      await service.interruptThread(parseCommand(CommandThreadIdSchema, rawThreadId))
    },

    'thread:interaction-respond': async (rawRequest: unknown) => {
      await service.respondToThreadInteraction(parseCommand(ThreadInteractionResponseSchema, rawRequest))
    },

    'thread:read': async (rawRequest: unknown) => {
      return service.readThread(parseCommand(ReadThreadRequestSchema, rawRequest))
    },

    'thread:fork': async (rawRequest: unknown) => {
      return service.forkThread(parseCommand(ForkThreadRequestSchema, rawRequest))
    },

    'thread:update-settings': async (rawRequest: unknown) => {
      const request = parseCommand(UpdateThreadSettingsRequestSchema, rawRequest)
      await service.updateThreadSettings(request)
    },

    'app:update-settings': async (rawSettings: unknown) => {
      const settings = parseOpenAgentSettings(rawSettings)
      parseCommand(commandJsonSize(2_000_000, 'settings'), rawSettings)
      await service.updateAppSettings(structuredClone(settings))
    },

    'harness:install': async (harnessId: unknown) => {
      if (!isHarnessId(harnessId)) throw new Error('未知 Harness ID')
      await service.installHarness(harnessId)
    },

    'harness:detect-installations': async () => {
      return service.detectHarnessInstallations()
    },
    'workspace:list-known-directories': async () => service.listKnownDirectories(),

    'harness:settings-presentation': async (rawRequest: unknown) => {
      const request = parseCommand(HarnessSettingsPresentationRequestSchema, rawRequest)
      return service.loadHarnessSettingsPresentation(request)
    },

    'harness:extension': async (rawRequest: unknown) => {
      const request = parseCommand(HarnessExtensionRequestSchema, rawRequest)
      assertRegisteredHarness(request.harnessId)
      return service.invokeHarnessExtension(request)
    },

    'thread:set-archived': async (rawThreadId: unknown, rawArchived: unknown) => {
      await service.setThreadArchived(parseCommand(CommandThreadIdSchema, rawThreadId),
        parseCommand(CommandArchivedSchema, rawArchived))
    },
    'report:set-archived': async (
      rawReportId: unknown,
      rawArchived: unknown
    ) => {
      const archived = parseCommand(CommandArchivedSchema, rawArchived)
      await service.setReportArchived(parseCommand(CommandReportIdSchema, rawReportId), archived)
    },

    'state:load': async () => service.loadRendererState(),

    'state:update-ui': async (rawUpdate: unknown) => {
      await service.updateUiState(parseCommand(OpenAgentUiStateUpdateSchema, rawUpdate))
    },

    'shell:open-external': async (rawUrl: unknown) => {
      await runtimeServices.openExternal(parseCommand(ExternalUrlSchema, rawUrl))
    }
  }
}

/** Registry membership and filesystem capabilities remain owned by Main. */
function assertRegisteredHarness(harnessId: string): void {
  if (!isHarnessId(harnessId)) throw new Error('未知 Harness ID')
}

function validateInputPaths(
  input: AgentInput,
  attachmentStore: CommandRuntimeServices['attachmentStore']
): void {
  input.parts.forEach((part, index) => {
    if ('file' in part && (!isAbsolute(part.file.path) || !attachmentStore.isManagedPath(part.file.path))) {
      throw new Error(`parts[${index}].file.path 不属于附件暂存区`)
    }
    if ((part.kind === 'mention' || part.kind === 'skill') && !isAbsolute(part.path)) {
      throw new Error(`parts[${index}].path 必须是绝对路径`)
    }
  })
}
