import { WebContentsView, session, shell, type BrowserWindow, type Rectangle } from 'electron'
import { debugLog } from '@openagent/plugin-kit/main'
import type {
  ReportRuntimeBounds,
  ReportRuntimeFailure
} from '../shared/desktop-api'

export type {
  ReportRuntimeBounds
}

/**
 * Report Thread 的 HTML 运行环境；当前边界与验证入口见仓库根目录
 * .agents/architecture.md 的 Report HTML 条目。
 *
 * 报告保留完整网页能力，但运行在无 OpenAgent preload、无 Node、独立 session 的
 * 隔离上下文。报告没有 preload、宿主事件桥或 OpenAgent 导航能力。
 */
const REPORT_SCHEME = 'openagent-report'
export const REPORT_SESSION_PARTITION = 'persist:openagent-report'

export const REPORT_SCHEME_PRIVILEGES = {
  scheme: REPORT_SCHEME,
  privileges: {
    standard: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
} as const

/** 当前打开的报告文档；协议处理器是它唯一的读取方。 */
let openDocument: { reportId: string; html: string } | null = null
let reportProtocolReady = false

function reportSession(): Electron.Session {
  const reportSession = session.fromPartition(REPORT_SESSION_PARTITION)
  if (!reportProtocolReady) {
    reportProtocolReady = true
    reportSession.protocol.handle(REPORT_SCHEME, (request) => {
      const url = new URL(request.url)
      const document = openDocument
      if (!document || url.hostname !== document.reportId || url.pathname !== '/') {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(document.html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    })
  }
  return reportSession
}

export class ReportRuntimeHost {
  private view: WebContentsView | null = null
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private generation = 0

  constructor(
    private readonly window: BrowserWindow,
    private readonly onFailure: (failure: ReportRuntimeFailure) => void
  ) {}

  /** 打开或按最新持久化 HTML 重新加载。 */
  async open(
    report: { id: string; html: string },
    bounds: ReportRuntimeBounds
  ): Promise<void> {
    if (this.window.isDestroyed()) throw new Error('主窗口已关闭，无法打开报告')
    this.close()
    openDocument = { reportId: report.id, html: report.html }
    const generation = ++this.generation
    const view = this.createView(report.id, generation)
    this.bounds = normalizeBounds(bounds)
    view.setBounds(this.bounds)
    try {
      await view.webContents.loadURL(`${REPORT_SCHEME}://${report.id}/`)
    } catch (error) {
      if (this.generation !== generation || isAbortedNavigation(error)) return
      this.close()
      throw error
    }
  }

  setBounds(bounds: ReportRuntimeBounds): void {
    this.bounds = normalizeBounds(bounds)
    this.view?.setBounds(this.bounds)
  }

  /** 离开报告视图：销毁本次运行实例，卡片态永远不执行 HTML。 */
  close(): void {
    const view = this.view
    this.view = null
    openDocument = null
    if (!view) return
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private createView(reportId: string, generation: number): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: reportSession(),
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false
      }
    })
    const contents = view.webContents

    contents.on('will-navigate', (event, url) => {
      if (!isNavigableReportUrl(url, reportId)) event.preventDefault()
    })
    contents.on('will-frame-navigate', (event) => {
      if (!isNavigableReportUrl(event.url, reportId)) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalReportUrl(url)) void shell.openExternal(url).catch(() => undefined)
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('render-process-gone', (_event, details) => {
      if (this.generation !== generation) return
      this.reportFailure(reportId, `报告运行进程已退出（${details.reason}）`)
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || this.generation !== generation) return
      this.reportFailure(reportId, errorDescription || `报告文档加载失败（${errorCode}）`)
    })
    this.view = view
    this.window.contentView.addChildView(view)
    return view
  }

  private reportFailure(reportId: string, message: string): void {
    debugLog('report.runtime-failed', { threadId: reportId, message })
    this.onFailure({ reportId, message })
  }
}

/** Electron 在一次导航被后续导航取代时以 ERR_ABORTED(-3) reject loadURL。 */
function isAbortedNavigation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { errno?: unknown; code?: unknown; message?: unknown }
  if (candidate.errno === -3 || candidate.code === 'ERR_ABORTED') return true
  return typeof candidate.message === 'string' && candidate.message.includes('ERR_ABORTED')
}

function normalizeBounds(bounds: ReportRuntimeBounds): Rectangle {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  }
}

function isNavigableReportUrl(value: string, reportId: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === `${REPORT_SCHEME}:`) {
      return url.hostname === reportId && url.pathname === '/' &&
        !url.username && !url.password && !url.port
    }
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isExternalReportUrl(value: string): boolean {
  const protocol = urlProtocol(value)
  return protocol === 'http:' || protocol === 'https:'
}

function urlProtocol(value: string): string | undefined {
  try {
    return new URL(value).protocol
  } catch {
    return undefined
  }
}
