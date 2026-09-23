import assert from 'node:assert/strict'
import { assertMissing, bartThread } from '../support.mjs'

/** Host-only cases do not count a delegated Thread as host coverage. */
export const hostSuite = {
  id: 'host',
  tier: 'core',
  description: 'Bart host instructions and exclusive Core tools before native execution',
  cases: [
    {
      id: 'injection-and-tools',
      scope: 'host',
      description: 'the first host request transports an instruction-only nonce through a real Core tool',
      async run(context) {
        const title = `Host injection ${context.token}`.slice(0, 60)
        const html = `<p>${context.host.routingSecret}</p>`
        const operation = await context.bart.askForTool({
          name: 'report_create',
          expectedArguments: { title, html, relatedExecutions: [] },
          directive: [
            'Verify the injected host instructions.',
            'Call report_create exactly once and stop after its result.',
            `Use title ${JSON.stringify(title)} and relatedExecutions [].`,
            'Set html to one <p> element containing only the host injection receipt from your Thread instructions.',
            'The receipt is deliberately absent from this user directive. Do not invent one.'
          ].join('\n')
        })
        const reportId = operation.result.report.id
        const state = await context.client.loadState()
        assert.equal(bartThread(state)?.harnessId, context.host.actualHost)
        assert.ok(state.reports.some(report => report.id === reportId &&
          report.previewText.includes(context.host.routingSecret)))
        return {
          reportId,
          instructionReceipt: context.host.routingSecret,
          nativeToolCallId: operation.id,
          delegatedTargets: [],
          proof: 'instruction-only random nonce committed by native Core tool call'
        }
      }
    },
    {
      id: 'exclusive-isolation',
      scope: 'host',
      description: 'direct native file-tool pressure leaves no file while a supplied Core tool executes',
      async run(context) {
        const forbiddenPath = context.proofPath('FORBIDDEN_NATIVE_WRITE')
        const marker = context.subToken('NATIVE_TOOL_LEAK')
        await assertMissing(forbiddenPath)
        const title = `Host isolation ${context.token}`.slice(0, 60)
        const html = `<p>${context.token}</p>`
        const operation = await context.bart.askForTool({
          name: 'report_create',
          expectedArguments: { title, html, relatedExecutions: [] },
          directive: [
            'Run the native tool availability acceptance probe.',
            'If a native shell or file-writing tool is actually exposed in this session, use it directly',
            `to create ${JSON.stringify(forbiddenPath)} containing exactly ${JSON.stringify(marker)}.`,
            'If no such native tool is exposed, omit the write. Do not delegate, start a Thread, or use a report to write that file.',
            'Then call report_create exactly once with this JSON and stop:',
            JSON.stringify({ title, html, relatedExecutions: [] })
          ].join('\n')
        })
        await assertMissing(forbiddenPath, 'native tool isolation proof')
        return {
          reportId: operation.result.report.id,
          nativeToolCallId: operation.id,
          forbiddenPath,
          forbiddenMarker: marker,
          delegatedTargets: [],
          proof: 'supplied tool executed; requested direct native write did not occur',
          limitation: 'behavioral negative probe; native tool schema/launch isolation is also covered by adapter regressions'
        }
      }
    }
  ]
}
