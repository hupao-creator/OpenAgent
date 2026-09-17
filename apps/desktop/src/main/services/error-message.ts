export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : typeof error === 'string' ? error : 'Unknown failure'
}
