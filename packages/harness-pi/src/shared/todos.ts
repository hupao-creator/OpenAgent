import type { PiTodo } from './types.js'

/** The optional native todo extension returns a complete snapshot in result.details.todos. */
export function parsePiTodos(value: unknown): PiTodo[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = new Set<number>()
  const todos: PiTodo[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const { id, text, done } = entry as Record<string, unknown>
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || ids.has(id) ||
      typeof text !== 'string' || !text.trim() || text.includes('\0') || typeof done !== 'boolean') return undefined
    ids.add(id)
    todos.push({ id, text, done })
  }
  return todos
}
