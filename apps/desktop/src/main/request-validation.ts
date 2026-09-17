import {
  commandObjectKeys, commandString, CommandRecordSchema, parseCommand
} from '@openagent/contracts'

// Compatibility helpers for Main's other boundaries use the same schema rules.
export function parseObject(
  value: unknown,
  keys: readonly string[],
  label: string,
  optionalKeys = false
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}无效`)
  return parseCommand(commandObjectKeys(keys, label, optionalKeys ? [] : keys), value)
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
  optionalKeys = false
): void {
  parseCommand(commandObjectKeys(allowedKeys, label, optionalKeys ? [] : allowedKeys), value)
}

export function requiredString(value: unknown, field: string, max: number): string {
  return parseCommand(commandString(field, max), value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return CommandRecordSchema.safeParse(value).success
}

export function boundedString(value: unknown, field: string, max: number): string {
  return parseCommand(commandString(field, max, true), value)
}
