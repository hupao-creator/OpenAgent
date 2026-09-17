// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportThreadView } from '../src/renderer/src/components/ReportThreadView'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import type { DesktopApi, ReportRuntimeFailure } from '../src/shared/desktop-api'
import type { RendererReport } from '../src/shared/renderer-state-contracts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Report Thread runtime surface', () => {
  it('opens the isolated runtime, keeps HTML out of the host DOM, and closes on unmount', async () => {
    const api = installReportApi()
    const view = renderReport(report())

    await waitFor(() => expect(api.openReportRuntime).toHaveBeenCalledWith(
      'report-1',
      { x: 0, y: 0, width: 0, height: 0 }
    ))
    expect(screen.getByLabelText('报告 交付报告')).toBeEmptyDOMElement()
    expect(document.querySelector('textarea')).toBeNull()

    view.unmount()
    await waitFor(() => expect(api.closeReportRuntime).toHaveBeenCalledTimes(1))
  })

  it('reloads on committed report replacement and displays runtime failure', async () => {
    const api = installReportApi()
    const view = renderReport(report())
    await waitFor(() => expect(api.openReportRuntime).toHaveBeenCalledTimes(1))

    view.rerender(element(report({ title: '交付报告 v2', updatedAt: 3 })))
    await waitFor(() => expect(api.openReportRuntime).toHaveBeenCalledTimes(2))
    api.fail({ reportId: 'report-1', message: '渲染进程创建失败' })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('交付报告 v2')
    expect(alert).toHaveTextContent('渲染进程创建失败')
  })
})

function report(overrides: Partial<RendererReport> = {}): RendererReport {
  return {
    id: 'report-1',
    title: '交付报告',
    tags: [],
    relatedExecutions: [],
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    previewText: '',
    ...overrides
  }
}

function element(value: RendererReport): React.JSX.Element {
  return (
    <I18nProvider locale="zh-CN">
      <ReportThreadView
        onBack={() => undefined}
        onSettings={() => undefined}
        report={value}
        suppressed={false}
      />
    </I18nProvider>
  )
}

function renderReport(value: RendererReport) {
  return render(element(value))
}

function installReportApi(): {
  readonly openReportRuntime: ReturnType<typeof vi.fn<DesktopApi['openReportRuntime']>>
  readonly closeReportRuntime: ReturnType<typeof vi.fn<DesktopApi['closeReportRuntime']>>
  fail(failure: ReportRuntimeFailure): void
} {
  let failureListener: ((failure: ReportRuntimeFailure) => void) | undefined
  const openReportRuntime = vi.fn<DesktopApi['openReportRuntime']>(async () => undefined)
  const closeReportRuntime = vi.fn<DesktopApi['closeReportRuntime']>(async () => undefined)
  window.openAgent = {
    openReportRuntime,
    setReportRuntimeBounds: vi.fn(async () => undefined),
    closeReportRuntime,
    onReportRuntimeFailure: vi.fn((listener) => {
      failureListener = listener
      return () => {
        failureListener = undefined
      }
    })
  } as unknown as DesktopApi
  return {
    openReportRuntime,
    closeReportRuntime,
    fail: (failure) => failureListener?.(failure)
  }
}
