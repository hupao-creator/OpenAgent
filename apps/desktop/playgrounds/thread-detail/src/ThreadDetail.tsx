import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Copy,
  FileCode2,
  FileText,
  Folder,
  GitBranch,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  X
} from 'lucide-react'
import {
  HarnessMessageTimeline,
  ThreadDetailEmptyState,
  HarnessToolActivityGroup,
  ThreadActivityRow,
  ThreadSurfacePlan,
  ThreadSurfacePlanRow,
  ThreadTimelineAssistantMessage,
  ThreadTimelineMarkdown,
  ThreadTimelineUserMessage
} from '@openagent/plugin-kit/renderer'
import {
  activities,
  answer,
  attachment,
  changedFiles,
  phaseLabels,
  plan,
  prompt,
  taskTitle,
  type Phase,
  type PreviewHarness,
  type Scenario,
  type ThreadKind
} from './fixtures'

type Inspector = 'context' | 'attachment' | 'files' | null
type ExtraTurn = { id: string; prompt: string }

export function ThreadDetail(props: {
  harness: PreviewHarness
  scenario: Scenario
  kind: ThreadKind
  annotations: boolean
  onBack: () => void
  onNotice: (message: string) => void
}): React.JSX.Element {
  const { harness, scenario, kind, annotations, onBack, onNotice } = props
  const [phase, setPhase] = useState<Phase>(scenario.phase)
  const [playing, setPlaying] = useState(scenario.phase === 'running')
  const [progress, setProgress] = useState(
    scenario.phase === 'running'
      ? 0.08
      : scenario.phase === 'interrupted'
        ? 0.4
        : 1
  )
  const [inspector, setInspector] = useState<Inspector>(null)
  const [selectedFile, setSelectedFile] = useState(0)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [extraTurns, setExtraTurns] = useState<ExtraTurn[]>([])
  const [decision, setDecision] = useState('')
  const [showLatest, setShowLatest] = useState(false)
  const [toolsVisible, setToolsVisible] = useState(scenario.phase === 'running')
  const [userMessagesVisible, setUserMessagesVisible] = useState(false)
  const surfaceRef = useRef<HTMLElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const followTail = useRef(
    scenario.id === 'history' || scenario.phase === 'running'
  )
  const active = phase === 'running'
  const currentAnswer =
    active || phase === 'interrupted'
      ? answer.slice(0, Math.floor(answer.length * progress))
      : answer

  // Reapply the default at execution boundaries, including retry and follow-up.
  useEffect(() => {
    setToolsVisible(phase === 'running')
  }, [phase])

  useEffect(() => {
    if (!active || !playing) return
    const interval = window.setInterval(() => {
      setProgress((value) => Math.min(1, value + 0.018))
    }, 240)
    return () => window.clearInterval(interval)
  }, [active, playing])

  useEffect(() => {
    if (active && progress >= 1) {
      setPhase('completed')
      setPlaying(false)
    }
  }, [active, progress])

  const scrollToLatest = (): void => {
    const scroll = surfaceRef.current?.querySelector('.message-scroll')
    if (!scroll) return
    scroll.scrollTop = scroll.scrollHeight
    followTail.current = true
    setShowLatest(false)
  }

  useLayoutEffect(() => {
    if (
      ['history', 'running', 'approval', 'question', 'failed'].includes(
        scenario.id
      )
    )
      scrollToLatest()
  }, [scenario.id])

  // Markdown is worker-rendered: observe actual content growth, not token timing.
  useEffect(() => {
    const column = surfaceRef.current?.querySelector('.message-column')
    if (!column || !active) return
    const observer = new ResizeObserver(() => {
      if (followTail.current) scrollToLatest()
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [active])

  useEffect(() => {
    if (followUpOpen) draftRef.current?.focus()
  }, [followUpOpen])

  const startRun = (): void => {
    setProgress(0.04)
    setPhase('running')
    setPlaying(true)
    followTail.current = true
  }

  const submitDraft = (): void => {
    const text = draft.trim()
    if (!text || active) return
    setExtraTurns((turns) => [
      ...turns,
      { id: `follow-up-${turns.length + 1}`, prompt: text }
    ])
    setDraft('')
    setFollowUpOpen(false)
    startRun()
    onNotice(
      kind === 'bart'
        ? '已模拟发送；回复使用本地样例。'
        : '已模拟经 Bart 定向续写；回复使用本地样例。'
    )
  }

  const completedSteps =
    phase === 'completed' || phase === 'background'
      ? 3
      : phase === 'running'
        ? Math.min(2, Math.floor(progress * 3))
        : 1

  const rows =
    scenario.id === 'history'
      ? Array.from({ length: 159 }, (_, index) => ({
          id: `history-${index}`,
          createdAt: index,
          node: (
            <div className="td-history-turn" role="listitem">
              <div className="td-turn-divider">
                <span>第 {index + 1} 轮</span>
                <time>昨天 14:{String(index % 60).padStart(2, '0')}</time>
              </div>
              {userMessagesVisible ? (
                <div className="td-history-prompt">
                  {
                    [
                      '把搜索条件保留到地址栏。',
                      '补充没有搜索结果时的提示。',
                      '检查较窄窗口下的布局。'
                    ][index % 3]
                  }
                </div>
              ) : null}
              <p>
                {
                  [
                    '已将查询条件写入 URL，返回列表时会恢复。',
                    '已增加清除筛选入口，可以继续修改关键词。',
                    '筛选栏会自动换行，项目名称保持可读。'
                  ][index % 3]
                }
              </p>
            </div>
          )
        }))
      : []

  const originalPhase = extraTurns.length ? 'completed' : phase
  if (scenario.phase !== 'empty')
    rows.push({
      id: 'current-turn',
      createdAt: 160,
      node: (
        <Turn
          promptText={prompt}
          phase={originalPhase}
          answerText={extraTurns.length ? answer : currentAnswer}
          toolsVisible={toolsVisible && (!active || originalPhase === 'running')}
          userMessagesVisible={userMessagesVisible}
          completedSteps={extraTurns.length ? 3 : completedSteps}
          progress={extraTurns.length ? 1 : progress}
          decision={decision}
          onAttachment={() => setInspector('attachment')}
          onFiles={() => setInspector('files')}
          onCopy={() => void copyText(answer, onNotice)}
          onStart={startRun}
          onDecision={(text, approved) => {
            setDecision(text)
            if (approved) startRun()
            else {
              setPhase('interrupted')
              setProgress(0.22)
            }
          }}
        />
      )
    })
  extraTurns.forEach((turn, index) =>
    rows.push({
      id: turn.id,
      createdAt: 161 + index,
      node: (
        <Turn
          promptText={turn.prompt}
          phase={index === extraTurns.length - 1 ? phase : 'completed'}
          answerText={index === extraTurns.length - 1 ? currentAnswer : answer}
          toolsVisible={
            toolsVisible && (!active || index === extraTurns.length - 1)
          }
          userMessagesVisible={userMessagesVisible}
          completedSteps={index === extraTurns.length - 1 ? completedSteps : 3}
          progress={progress}
          onFiles={() => setInspector('files')}
          onCopy={() => void copyText(answer, onNotice)}
          onStart={startRun}
          onDecision={() => undefined}
        />
      )
    })
  )

  return (
    <section
      ref={surfaceRef}
      className="thread-preview"
      data-annotated={annotations}
      aria-label="Thread 详情预览"
      onScrollCapture={(event) => {
        const element = event.target as HTMLElement
        if (!element.classList.contains('message-scroll')) return
        const away =
          element.scrollHeight - element.scrollTop - element.clientHeight > 120
        followTail.current = !away
        setShowLatest(away)
      }}
    >
      <header className="td-header" data-region="01 · 任务上下文">
        <button
          className="td-icon"
          type="button"
          aria-label="返回场景导航"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </button>
        <div className="td-heading">
          <h1>{kind === 'bart' ? 'Bart' : taskTitle}</h1>
          <div>
            <span>{harness.label}</span>
            <span className="td-meta-dot">·</span>
            <Folder size={11} />
            <span>OpenAgent</span>
            <span className="td-meta-dot">·</span>
            <span>{kind === 'bart' ? '协调会话' : '开发任务'}</span>
          </div>
        </div>
        <Status phase={phase} />
        <button
          className="td-icon td-context-trigger"
          type="button"
          aria-label="查看任务信息"
          aria-expanded={inspector === 'context'}
          onClick={() =>
            setInspector(inspector === 'context' ? null : 'context')
          }
        >
          <BookOpen size={16} />
        </button>
      </header>

      <main className="td-main" data-region="02 · 消息阅读列">
        <HarnessMessageTimeline
          timelineKey={scenario.id}
          rows={rows}
          emptyState={<ThreadDetailEmptyState />}
          toolbar={
            <>
              <div className="td-page-title">
                <FileText size={32} strokeWidth={1.4} />
                <h2>{kind === 'bart' ? '一起推进今天的工作' : taskTitle}</h2>
                <p>
                  <span>{harness.label}</span>
                  <span className="td-meta-dot">·</span>
                  <span>OpenAgent</span>
                  <span className="td-meta-dot">·</span>
                  <span>
                    {scenario.id === 'history' ? '160 轮对话' : '今天 14:28'}
                  </span>
                </p>
              </div>
              <div className="td-timeline-toolbar">
                <span>{scenario.id === 'history' ? '最近的记录' : '对话'}</span>
                <div className="td-timeline-controls">
                  <button
                    type="button"
                    aria-pressed={userMessagesVisible}
                    onClick={() => setUserMessagesVisible((visible) => !visible)}
                  >
                    <MessageSquare size={13} />
                    {userMessagesVisible ? '隐藏用户消息' : '显示用户消息'}
                  </button>
                  <button
                    type="button"
                    aria-pressed={toolsVisible}
                    onClick={() => setToolsVisible(!toolsVisible)}
                  >
                    <ListChecks size={13} />
                    {toolsVisible ? '收起执行过程' : '显示执行过程'}
                  </button>
                </div>
              </div>
            </>
          }
        />
        {showLatest ? (
          <button className="td-jump" type="button" onClick={scrollToLatest}>
            <ArrowDown size={13} />
            回到最新
          </button>
        ) : null}
      </main>

      <footer className="td-footer" data-region="05 · 状态与下一步">
        {phase === 'background' ? (
          <div className="td-background">
            <LoaderCircle size={14} className="td-spin" />
            <span>
              <strong>预览服务正在后台运行</strong>
              <small>回复已完成 · 可继续对话</small>
            </span>
            <button
              type="button"
              className="td-quiet-button"
              onClick={() => setPhase('completed')}
            >
              停止后台任务
            </button>
          </div>
        ) : null}
        {kind === 'bart' || followUpOpen ? (
          <form
            className="td-composer"
            onSubmit={(event) => {
              event.preventDefault()
              submitDraft()
            }}
          >
            {kind !== 'bart' ? (
              <div className="td-composer-target">
                <MessageSquare size={12} />
                通过 Bart 续写此任务
                <button
                  className="td-icon"
                  type="button"
                  aria-label="关闭续写"
                  onClick={() => setFollowUpOpen(false)}
                >
                  <X size={13} />
                </button>
              </div>
            ) : null}
            <textarea
              ref={draftRef}
              aria-label={kind === 'bart' ? '给 Bart 的消息' : '续写指令'}
              placeholder={
                kind === 'bart'
                  ? '告诉 Bart 下一步做什么…'
                  : '补充这个任务的下一步…'
              }
              value={draft}
              rows={2}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  submitDraft()
                }
              }}
            />
            <div className="td-composer-bottom">
              <span>
                {active ? '任务执行中' : 'Enter 发送 · Shift Enter 换行'}
              </span>
              {active ? (
                <button
                  className="td-send"
                  type="button"
                  aria-label="停止执行"
                  onClick={() => {
                    setPhase('interrupted')
                    setPlaying(false)
                  }}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  className="td-send"
                  type="submit"
                  disabled={!draft.trim()}
                  aria-label="发送消息"
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </form>
        ) : (
          <div className="td-footer-line">
            <span>
              {active ? (
                <LoaderCircle className="td-spin" size={14} />
              ) : phase === 'approval' || phase === 'question' ? (
                <CircleAlert size={14} />
              ) : (
                <MessageSquare size={14} />
              )}
              {active
                ? playing
                  ? '正在完成当前任务'
                  : '演示已暂停'
                : phase === 'approval' || phase === 'question'
                  ? '请在消息中处理待办请求'
                  : '由 Bart 协调此任务'}
            </span>
            {active ? (
              <div className="td-footer-actions">
                <button
                  className="td-icon"
                  type="button"
                  aria-label={playing ? '暂停演示' : '继续演示'}
                  onClick={() => setPlaying(!playing)}
                >
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  className="td-quiet-button"
                  type="button"
                  onClick={() => {
                    setPhase('interrupted')
                    setPlaying(false)
                  }}
                >
                  <Square size={12} />
                  停止执行
                </button>
              </div>
            ) : (
              <button
                className="td-primary"
                type="button"
                onClick={() => setFollowUpOpen(true)}
              >
                <MessageSquare size={14} />
                {phase === 'empty' ? '通过 Bart 开始' : '通过 Bart 续写'}
                <ArrowUp size={13} />
              </button>
            )}
          </div>
        )}
      </footer>

      {inspector ? (
        <InspectorPanel
          title={
            inspector === 'context'
              ? '任务信息'
              : inspector === 'attachment'
                ? attachment.name
                : '文件变更'
          }
          onClose={() => setInspector(null)}
        >
          {inspector === 'context' ? (
            <>
              <div className="td-inspector-section">
                <span className="td-eyebrow">任务</span>
                <h2>{kind === 'bart' ? 'Bart' : taskTitle}</h2>
                <Status phase={phase} />
              </div>
              <dl className="td-facts">
                <dt>Harness</dt>
                <dd>{harness.label}</dd>
                <dt>模型</dt>
                <dd>{harness.model}</dd>
                <dt>工作目录</dt>
                <dd>/workspace/OpenAgent</dd>
                <dt>分支</dt>
                <dd>
                  <GitBranch size={12} /> feature/project-search
                </dd>
                <dt>开始时间</dt>
                <dd>今天 14:28</dd>
                <dt>数据来源</dt>
                <dd>Playground 本地样例</dd>
              </dl>
            </>
          ) : inspector === 'attachment' ? (
            <ThreadTimelineMarkdown>
              {attachment.content}
            </ThreadTimelineMarkdown>
          ) : (
            <>
              <p className="td-inspector-caption">
                3 个文件 <span className="td-added">+86</span>{' '}
                <span className="td-removed">−12</span>
              </p>
              <div className="td-file-tabs" aria-label="选择变更文件">
                {changedFiles.map((file, index) => (
                  <button
                    type="button"
                    aria-pressed={selectedFile === index}
                    key={file.path}
                    onClick={() => setSelectedFile(index)}
                  >
                    <FileCode2 size={13} />
                    <span>{file.path}</span>
                    <small>
                      +{file.added} −{file.removed}
                    </small>
                  </button>
                ))}
              </div>
              <pre
                className="td-diff"
                aria-label={`${changedFiles[selectedFile].path} 的示例差异`}
              >
                {changedFiles[selectedFile].before
                  .split('\n')
                  .filter(Boolean)
                  .map((line, index) => (
                    <span className="td-diff-remove" key={`old-${index}`}>
                      − {line}
                      {'\n'}
                    </span>
                  ))}
                {changedFiles[selectedFile].after
                  .split('\n')
                  .map((line, index) => (
                    <span className="td-diff-add" key={`new-${index}`}>
                      + {line}
                      {'\n'}
                    </span>
                  ))}
              </pre>
            </>
          )}
        </InspectorPanel>
      ) : null}
    </section>
  )
}

function Turn(props: {
  promptText: string
  phase: Phase
  answerText: string
  toolsVisible: boolean
  userMessagesVisible: boolean
  completedSteps: number
  progress: number
  decision?: string
  onAttachment?: () => void
  onFiles: () => void
  onCopy: () => void
  onStart: () => void
  onDecision: (text: string, approved: boolean) => void
}): React.JSX.Element {
  const id = useId()
  const active = props.phase === 'running'
  const finished = props.phase === 'completed' || props.phase === 'background'
  return (
    <div className="td-turn" role="presentation">
      {props.userMessagesVisible ? (
        <ThreadTimelineUserMessage id={`${id}-user`}>
          <span className="td-user-label">你</span>
          <p>{props.promptText}</p>
          {props.onAttachment ? (
            <button
              className="td-attachment"
              type="button"
              onClick={props.onAttachment}
            >
              <FileText size={13} />
              {attachment.name}
              <span>1.2 KB</span>
            </button>
          ) : null}
        </ThreadTimelineUserMessage>
      ) : null}
      <ThreadTimelineAssistantMessage id={`${id}-assistant`}>
        <div className="td-author">
          <span className="td-agent-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <strong>OpenAgent</strong>
          <span>{active ? '正在工作' : '14:32'}</span>
        </div>
        {props.toolsVisible ? (
          <div className="td-work" data-region="03 · 执行过程">
            <p className="td-progress-copy">
              先检查现有列表和筛选入口，再把搜索条件接入页面状态。
            </p>
            <WorkDetails
              phase={props.phase}
              progress={props.progress}
              completedSteps={props.completedSteps}
            />
          </div>
        ) : null}
        {props.decision ? (
          <div className="td-decision">
            <Check size={13} />
            {props.decision}
          </div>
        ) : null}
        {props.phase === 'approval' ? (
          <Approval onDecision={props.onDecision} />
        ) : props.phase === 'question' ? (
          <Question onDecision={props.onDecision} />
        ) : props.phase === 'failed' ? (
          <div className="td-error" role="alert">
            <div>
              <CircleAlert size={17} />
              <strong>依赖安装未完成</strong>
            </div>
            <p>连接包服务时超时，已有的文件修改已保留。可以重试当前步骤。</p>
            <details>
              <summary>
                查看错误详情
                <ChevronDown size={12} />
              </summary>
              <pre>
                ETIMEDOUT · registry.npmjs.org{'\n'}请求在 30 秒后超时，退出码
                1。{'\n'}步骤：pnpm install
              </pre>
            </details>
            <button
              type="button"
              className="td-quiet-button"
              onClick={props.onStart}
            >
              <RotateCcw size={13} />
              重试当前步骤
            </button>
          </div>
        ) : (
          <>
            {props.answerText ? (
              <div className="td-answer" data-region="04 · 回复与结果">
                <ThreadTimelineMarkdown streaming={active}>
                  {props.answerText}
                </ThreadTimelineMarkdown>
              </div>
            ) : null}
            {finished ? (
              <>
                <button
                  className="td-files-summary"
                  type="button"
                  onClick={props.onFiles}
                >
                  <FileCode2 size={15} />
                  <span>已修改 3 个文件</span>
                  <span className="td-added">+86</span>
                  <span className="td-removed">−12</span>
                  <ChevronRight size={14} />
                </button>
                <div className="td-turn-footer">
                  <span>
                    <Check size={12} />
                    已完成<span className="td-meta-dot">·</span>用时 2 分 14 秒
                  </span>
                  <button
                    className="td-icon"
                    type="button"
                    aria-label="复制回复"
                    onClick={props.onCopy}
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </>
            ) : null}
            {props.phase === 'interrupted' ? (
              <div className="td-stopped">
                <Square size={12} />
                <span>任务已停止，已有内容已保留。</span>
                <button type="button" onClick={props.onStart}>
                  继续执行
                  <ArrowUp size={12} />
                </button>
              </div>
            ) : null}
          </>
        )}
      </ThreadTimelineAssistantMessage>
    </div>
  )
}

function WorkDetails({
  phase,
  progress,
  completedSteps
}: {
  phase: Phase
  progress: number
  completedSteps: number
}): React.JSX.Element {
  const running = phase === 'running'
  const settled = phase === 'completed' || phase === 'background'
  const toolIndex = settled
    ? activities.length
    : running
      ? Math.min(3, Math.floor(progress * 4))
      : 2
  const icons = {
    read: FileText,
    search: Search,
    edit: FileCode2,
    terminal: Terminal
  }
  return (
    <>
      <HarnessToolActivityGroup
        groupId="preview-work"
        summary={
          <>
            <span>
              {running ? '正在执行' : settled ? '已完成' : '已执行'}{' '}
              {settled ? 4 : toolIndex} 项操作
            </span>
            <small>读取 · 搜索 · 编辑 · 检查</small>
          </>
        }
        summaryLabel="展开工具调用"
        summaryState={
          running ? (
            <LoaderCircle className="td-spin" size={13} />
          ) : (
            <Check size={13} />
          )
        }
        items={activities
          .slice(0, settled ? 4 : toolIndex + (running ? 1 : 0))
          .map((activity, index) => {
            const Icon = icons[activity.kind]
            const live = running && index === toolIndex
            return {
              id: activity.id,
              running: live,
              node: (
                <ThreadActivityRow
                  id={activity.id}
                  state={
                    live ? (
                      <LoaderCircle className="td-spin" size={12} />
                    ) : (
                      <Check size={12} />
                    )
                  }
                  icon={<Icon size={13} />}
                  label={
                    <>
                      <span>{activity.label}</span>
                      <small>{live ? '执行中' : activity.meta}</small>
                    </>
                  }
                  detail={activity.detail}
                />
              )
            }
          })}
      />
      <details className="td-plan">
        <summary>
          <ListChecks size={14} />
          <span>执行计划</span>
          <small>{completedSteps} / 3</small>
          <ChevronRight size={13} />
        </summary>
        <ThreadSurfacePlan
          label="执行计划"
          completed={completedSteps}
          total={3}
        >
          {plan.map((step, index) => (
            <ThreadSurfacePlanRow
              key={step}
              className={index < completedSteps ? 'completed' : ''}
              state={
                index < completedSteps ? (
                  <Check size={12} />
                ) : running && index === completedSteps ? (
                  <LoaderCircle className="td-spin" size={12} />
                ) : (
                  <Circle size={10} />
                )
              }
            >
              {step}
            </ThreadSurfacePlanRow>
          ))}
        </ThreadSurfacePlan>
      </details>
    </>
  )
}

function Approval({
  onDecision
}: {
  onDecision: (text: string, approved: boolean) => void
}): React.JSX.Element {
  return (
    <section className="td-request" aria-label="授权请求">
      <div className="td-request-heading">
        <ShieldCheck size={17} />
        <h3>允许安装项目依赖？</h3>
      </div>
      <p>需要连接包服务，安装这个项目所需的依赖。</p>
      <pre>pnpm install</pre>
      <dl className="td-request-properties">
        <div>
          <dt>工作目录</dt>
          <dd>/workspace/OpenAgent</dd>
        </div>
        <div>
          <dt>授权范围</dt>
          <dd>仅此操作</dd>
        </div>
      </dl>
      <div className="td-request-actions">
        <button
          className="td-primary"
          type="button"
          onClick={() => onDecision('已允许本次安装依赖。', true)}
        >
          <Check size={14} />
          允许本次
        </button>
        <button
          className="td-secondary"
          type="button"
          onClick={() => onDecision('已拒绝安装依赖。', false)}
        >
          拒绝
        </button>
      </div>
    </section>
  )
}

function Question({
  onDecision
}: {
  onDecision: (text: string, approved: boolean) => void
}): React.JSX.Element {
  const [choice, setChoice] = useState('name')
  const [note, setNote] = useState('')
  const name = useId()
  return (
    <form
      className="td-request"
      aria-label="问题回答"
      onSubmit={(event) => {
        event.preventDefault()
        onDecision(
          `已回答：${choice === 'name' ? '仅搜索项目名称' : '搜索名称和描述'}${note.trim() ? `；${note.trim()}` : '。'}`,
          true
        )
      }}
    >
      <div className="td-request-heading">
        <MessageSquare size={16} />
        <h3>搜索需要覆盖哪些内容？</h3>
      </div>
      <p>这会决定搜索匹配范围。</p>
      <fieldset>
        <legend className="td-sr-only">搜索范围</legend>
        {[
          {
            id: 'name',
            title: '仅项目名称',
            description: '匹配更精确，列表结果更容易预期。'
          },
          {
            id: 'all',
            title: '项目名称和描述',
            description: '覆盖更多内容，适合用关键词查找。'
          }
        ].map((item) => (
          <label className="td-choice" key={item.id}>
            <input
              type="radio"
              name={name}
              checked={choice === item.id}
              onChange={() => setChoice(item.id)}
            />
            <span>
              <strong>{item.title}</strong>
              <small>{item.description}</small>
            </span>
            {item.id === 'name' ? <em>建议</em> : null}
          </label>
        ))}
      </fieldset>
      <label className="td-question-note">
        <span>
          补充说明 <small>可选</small>
        </span>
        <textarea
          aria-label="补充说明"
          placeholder="添加更多背景…"
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          rows={2}
        />
      </label>
      <div className="td-request-actions">
        <button className="td-primary" type="submit">
          提交回答
          <ArrowUp size={13} />
        </button>
      </div>
    </form>
  )
}

function Status({ phase }: { phase: Phase }): React.JSX.Element {
  return (
    <span className="td-status" data-phase={phase} role="status">
      <span
        className={
          phase === 'running' || phase === 'background'
            ? 'td-status-dot live'
            : 'td-status-dot'
        }
      />
      {phaseLabels[phase]}
    </span>
  )
}

function InspectorPanel({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus()
  }, [])
  return (
    <div
      className="td-inspector-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <aside
        ref={panelRef}
        className="td-inspector"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
          if (event.key !== 'Tab') return
          const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
            'button, [href], input, textarea, select, [tabindex="0"]'
          )
          if (!focusable?.length) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header>
          <strong id={titleId}>{title}</strong>
          <button
            ref={closeRef}
            className="td-icon"
            type="button"
            aria-label="关闭详情"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="td-inspector-body">{children}</div>
      </aside>
    </div>
  )
}

export async function copyText(
  value: string,
  notify: (message: string) => void
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    notify('已复制到剪贴板。')
  } catch {
    notify('浏览器未允许复制，请使用浏览器复制功能。')
  }
}
