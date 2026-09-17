export const DEFAULT_THREAD_EMOJI = '📝'

// Unicode's RGI emoji set includes skin tones, ZWJ sequences, flags and keycaps.
const THREAD_EMOJI_PATTERN = new RegExp('^\\p{RGI_Emoji}$', 'v')

export function isThreadEmoji(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() &&
    THREAD_EMOJI_PATTERN.test(value)
}
