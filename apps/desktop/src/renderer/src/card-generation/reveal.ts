/** Mounted content blocks included in the prepared Worker reveal. */
export function cardRevealBlocks(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>(
    '.thread-overview-item-head > strong, .thread-provider-status, ' +
    '.thread-card-identity > small, .thread-overview-context, .thread-overview-steer, ' +
    '.thread-overview-excerpt, .report-overview-preview, .thread-card-identity-tool, ' +
    '.thread-card-extension:not(.harness-overview-content), ' +
    '.thread-card-workflow-phase-cell, .thread-card-workflow-agent-cell, .report-overview-meta'
  )].filter(block => !block.parentElement?.closest('.thread-card-extension:not(.harness-overview-content)'))
}
