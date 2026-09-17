/** Native assistant identity is preserved verbatim across transport and storage. */
export function isCodexAgentMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 &&
    value === value.trim() && !value.includes('\0')
}
