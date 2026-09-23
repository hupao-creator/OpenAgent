import type { HarnessRendererPlugin } from '@openagent/contracts/renderer'
import {
  type ClaudeHarnessSettings,
  type ClaudeSettingsPresentationData,
  type ClaudeThreadSettingsUpdate
} from '../shared/settings.js'
import claudeCodeLogo from './claude-code.svg?inline'
import './claude-renderer.css'
import { claudeRendererTranslations } from './translations.js'
import { ClaudeThreadView } from './ThreadView.js'
import { projectClaudeOverview, claudeExecutionTokenUsage, ClaudeOverviewCard, type ClaudeOverviewView } from './OverviewCard.js'
import { decodeClaudeRendererState } from './state.js'
import { projectClaudeBartPresentation } from '../shared/bart-presentation.js'
import { ClaudeThreadSettingsPanel, ClaudeHarnessSettingsPanel } from './Settings.js'
export { type ClaudeOverviewView, projectClaudeOverview, ClaudeOverviewCard } from './OverviewCard.js'
export { ClaudeThreadView } from './ThreadView.js'
export { ClaudeThreadSettingsPanel, ClaudeHarnessSettingsPanel } from './Settings.js'

export const claudeRendererPlugin = {
  logoSource: claudeCodeLogo,
  translations: claudeRendererTranslations,
  ThreadView: ClaudeThreadView,
  OverviewCard: {
    project: projectClaudeOverview,
    executionTokenUsage: claudeExecutionTokenUsage,
    Card: ClaudeOverviewCard
  },
  projectBartDock({ thread }) {
    return projectClaudeBartPresentation(decodeClaudeRendererState(thread.sessionState))
  },
  ThreadSettings: ClaudeThreadSettingsPanel,
  HarnessSettings: ClaudeHarnessSettingsPanel
} satisfies HarnessRendererPlugin<
  ClaudeOverviewView,
  ClaudeThreadSettingsUpdate,
  ClaudeHarnessSettings,
  ClaudeSettingsPresentationData
>
