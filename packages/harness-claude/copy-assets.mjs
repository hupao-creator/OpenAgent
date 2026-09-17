import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(css|svg)$/.test(entry)) yield path
  }
}

for (const file of walk('src')) {
  const target = join('dist', relative('src', file))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(file, target)
}
