import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Fresh native profiles use loopback directly, without ambient credentials or proxies. */
export async function isolatedNativeEnvironment(root, environment) {
  const inherited = [
    'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'
  ]
  const next = Object.fromEntries(inherited.filter(key => environment[key] !== undefined)
    .map(key => [key, environment[key]]))
  const paths = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
    TMPDIR: join(root, 'tmp')
  }
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  return { ...next, ...paths }
}
