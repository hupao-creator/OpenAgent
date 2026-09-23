import assert from 'node:assert/strict'
import { exactCallDirective } from '../bart.mjs'
import { bounded, containsToken } from '../support.mjs'

/**
 * Report Threads are Bart-authored durable artefacts. This case walks the
 * whole native lifecycle and crosses the GUI command surface once, because the
 * archive command is the only public multi-argument channel.
 */
export const reportsSuite = {
  id: 'reports',
  tier: 'extended',
  description: 'Report Thread creation, update, and archive',
  cases: [
    {
      id: 'list-projection',
      scope: 'once',
      requires: ['plain'],
      description: 'list exposes the same committed summary as renderer state',
      async run(context) {
        const title = `List ${context.token}`.slice(0, 60)
        const html = `<p>${context.token}</p>`
        const createArguments = { title, html, relatedExecutions: [] }
        const createOperation = await context.bart.askForTool({
          name: 'report_create',
          expectedArguments: createArguments,
          directive: exactCallDirective(
            'Create one Report used to verify list projection.',
            'report_create',
            createArguments
          )
        })
        const reportId = createOperation.result.report.id
        const committed = await context.client.waitForState(state =>
          state.reports.find(report => report.id === reportId),
          `report ${reportId} committed`)

        const listOperation = await context.bart.askForTool({
          name: 'report_list',
          expectedArguments: {},
          directive: exactCallDirective(
            'List Report Threads for the projection acceptance case.',
            'report_list',
            {}
          )
        })
        const listed = listOperation.result.reports
          .find(report => report.id === reportId)
        assert.ok(listed, `Report list omitted ${reportId}: ${bounded(listOperation.result)}`)
        assert.equal(listed.title, committed.title)
        assert.equal(listed.createdAt, committed.createdAt)
        assert.equal(listed.updatedAt, committed.updatedAt)
        assert.equal(listed.archived, committed.archived)
        assert.equal(listed.relatedThreadCount, committed.relatedExecutions.length)
        assert.equal(listed.tagCount, committed.tags.length)

        return { reportId }
      }
    },
    {
      id: 'lifecycle',
      scope: 'once',
      requires: ['plain'],
      description: 'a Report is created from a real Thread and then retired',
      async run(context) {
        const marker = `REPORT_SOURCE:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: [
            `This is a native ${context.harness} report-source acceptance case.`,
            'Do not use any tool.',
            `Reply with exactly ${marker} and nothing else.`
          ].join('\n')
        })
        const reportSource = await context.waitForCompleted(threadId)
        const relatedExecutions = [{ threadId, executionId: reportSource.executionId }]

        const title = `Acceptance ${context.token}`.slice(0, 60)
        const createOperation = await context.bart.askForTool({
          name: 'report_create',
          matchArguments(callArguments) {
            assert.equal(callArguments.title, title)
            assert.ok(
              containsToken(callArguments.html, context.token),
              `the Report body lost its acceptance token: ${bounded(callArguments.html)}`
            )
            assert.deepEqual(callArguments.relatedExecutions, relatedExecutions)
          },
          directive: [
            'Write one Report Thread for this acceptance run.',
            'Call report_create exactly once and then stop.',
            `Use exactly this title: ${title}`,
            `The html must be a single <p> element whose text is exactly ${context.token}.`,
            `Set relatedExecutions to exactly ${JSON.stringify(relatedExecutions)}.`
          ].join('\n')
        })
        const reportId = createOperation.result.report.id
        assert.equal(createOperation.result.report.relatedThreadCount, 1)
        assert.equal(createOperation.result.report.archived, false)

        const created = await context.client.waitForState(state =>
          state.reports.find(report => report.id === reportId),
          `report ${reportId} committed`)
        assert.equal(created.title, title)
        assert.deepEqual(created.relatedExecutions, relatedExecutions)
        assert.ok(
          containsToken(created.previewText, context.token),
          `the committed Report preview lost its token: ${bounded(created)}`
        )

        const readOperation = await context.bart.askForTool({
          name: 'report_read',
          expectedArguments: { reportId },
          directive: exactCallDirective(
            'Read back the acceptance Report Thread.',
            'report_read',
            { reportId }
          )
        })
        assert.ok(
          containsToken(readOperation.result.report.html, context.token),
          `the stored Report body lost its token: ${bounded(readOperation.result.report)}`
        )

        const updatedTitle = `Acceptance ${context.token} v2`.slice(0, 60)
        await context.bart.askForTool({
          name: 'report_update',
          expectedArguments: { reportId, title: updatedTitle },
          directive: exactCallDirective(
            'Rename the acceptance Report Thread.',
            'report_update',
            { reportId, title: updatedTitle }
          )
        })
        await context.client.waitForState(state =>
          state.reports.find(report => report.id === reportId)?.title === updatedTitle
            ? true
            : undefined,
          `report ${reportId} renamed`)

        await context.bart.askForTool({
          name: 'report_set_archived',
          expectedArguments: { reportId, archived: true },
          directive: exactCallDirective(
            'Archive the acceptance Report Thread.',
            'report_set_archived',
            { reportId, archived: true }
          )
        })
        await context.client.waitForState(state =>
          state.reports.find(report => report.id === reportId)?.archived === true
            ? true
            : undefined,
          `report ${reportId} archived`)

        // The GUI restore path is the one public command that takes an argument
        // tuple; exercising it here keeps the headless transport honest.
        await context.client.invoke('report:set-archived', [reportId, false])
        await context.client.waitForState(state =>
          state.reports.find(report => report.id === reportId)?.archived === false
            ? true
            : undefined,
          `report ${reportId} restored`)

        return { threadId, reportId }
      }
    }
  ]
}
