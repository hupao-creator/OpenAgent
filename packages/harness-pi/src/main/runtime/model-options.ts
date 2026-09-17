import type { PiThreadSettings } from '../../shared/types.js'

/** CLI overrides are session-local; RPC set_model/set_thinking_level write Pi defaults. */
export function piModelArguments(settings: Readonly<PiThreadSettings>): string[] {
  return [
    ...(settings.provider ? ['--provider', settings.provider] : []),
    ...(settings.model ? ['--model', settings.model] : []),
    ...(settings.thinkingLevel ? ['--thinking', settings.thinkingLevel] : [])
  ]
}
