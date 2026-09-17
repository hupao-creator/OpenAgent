import { useEffect, useRef, useState } from 'react'
import { harnessDisplayName } from '../../../shared/harnesses'
import { harnessLogoSource } from '../harness-composition'

export function providerLogoSource(provider: string): string {
  return harnessLogoSource(provider)
}

interface LogoProps {
  className?: string
}

/**
 * Provider 品牌 logo。资源以内联 data URI 随 bundle 打包；无论资源为何失败
 * （打包损坏、CSP 变更、恢复场景），失败后立即移除坏图并渲染内置 SVG 图标，
 * 绝不保留裂图。失败状态按实例记忆，重复 render 不会重新裂图。
 */
export function ProviderLogo({
  provider,
  className = ''
}: LogoProps & { provider: string }): React.JSX.Element {
  const src = providerLogoSource(provider)
  const [failed, setFailed] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  // 挂载时资源可能已处于“加载失败但没触发 onError”的状态（例如从缓存恢复、
  // 重挂载）：complete 且无自然尺寸 → 直接判失败，避免裂图闪现。
  useEffect(() => {
    const img = imgRef.current
    if (img && img.complete && img.naturalWidth === 0) setFailed(true)
  }, [])

  if (failed) {
    return (
      <FallbackIcon
        className={className}
        label={harnessDisplayName(provider)}
      />
    )
  }
  return (
    <img
      ref={imgRef}
      className={`provider-logo provider-logo-${provider} ${className}`}
      data-provider={provider}
      src={src}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  )
}

/** 稳定内置图标：纯内联 SVG，零外部资源依赖，任何 provider 失败时使用。 */
function FallbackIcon({ className, label }: { className: string; label: string }): React.JSX.Element {
  return (
    <span className={'provider-logo-fallback ' + className} aria-label={label} role="img">
      <svg
        width="0.9em"
        height="0.9em"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="4" width="19" height="14" rx="2.5" />
        <path d="M6.5 9.5h6M6.5 13h3.5" />
        <path d="M14.5 12.5l2.5 2 2.5-2" />
      </svg>
    </span>
  )
}
