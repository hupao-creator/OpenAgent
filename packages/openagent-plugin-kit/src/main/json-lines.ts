import { StringDecoder } from 'node:string_decoder'

/** Incremental UTF-8 framing: LF/CRLF records, empty lines omitted, final tail trimmed. */
export class JsonLines {
  private readonly decoder = new StringDecoder('utf8')
  private value = ''

  push(chunk: Buffer): string[] {
    this.value += this.decoder.write(chunk)
    const lines = this.value.split(/\r?\n/)
    this.value = lines.pop() || ''
    return lines.filter(Boolean)
  }

  end(): string[] {
    const tail = (this.value + this.decoder.end()).trim()
    this.value = ''
    return tail ? [tail] : []
  }
}
