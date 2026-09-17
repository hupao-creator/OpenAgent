// Exercise the real health orchestrator and OS signals without launching a
// native acceptance matrix. These stage fixtures are not native health evidence.
import { registerHooks } from 'node:module'

const mode = process.argv[2]
const ordinary = new URL('../harness-injection-native.mjs', import.meta.url).href
const bart = new URL('../bart-headless/runner.mjs', import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url !== ordinary && url !== bart) return nextLoad(url, context)
    const name = url === ordinary ? 'ordinary' : 'bart'
    const wait = mode === name
    return { format: 'module', shortCircuit: true, source: `
      export async function main() {
        ${wait ? `return await new Promise(resolve => {
          const alive = setInterval(() => {}, 1000);
          ${name === 'ordinary' ? `
            const cancelled = () => {
              clearInterval(alive);
              process.off('SIGINT', cancelled);
              process.off('SIGTERM', cancelled);
              resolve(1);
            };
            process.once('SIGINT', cancelled);
            process.once('SIGTERM', cancelled);` : ''}
          console.log('${name}-ready');
        });` : `console.log('${name}-started'); return ${name === 'ordinary' ? 1 : 0};`}
      }
    ` }
  }
})
const { main } = await import('../harness-health.mjs')
process.exitCode = await main(['--artifacts-dir', process.argv[3]])
