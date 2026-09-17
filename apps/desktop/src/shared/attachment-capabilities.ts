import type { AgentAttachment } from './attachments'

const MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript-jsx',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript-jsx',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.swift': 'text/x-swift',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml'
}

export function mimeTypeForPath(path: string): string {
  const filename = path.split(/[\\/]/).at(-1) || path
  const extensionIndex = filename.lastIndexOf('.')
  const extension = extensionIndex >= 0 ? filename.slice(extensionIndex).toLowerCase() : ''
  return MIME_TYPES_BY_EXTENSION[extension] || 'application/octet-stream'
}

export function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/x-ndjson',
    'application/xml',
    'application/yaml',
    'application/toml'
  ].includes(mimeType)
}

export function attachmentKindForMimeType(mimeType: string): AgentAttachment['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf' || isTextMimeType(mimeType)) return 'document'
  return 'file'
}
