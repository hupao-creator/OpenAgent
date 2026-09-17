export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('revision 已变化')
}
