/** Logical visibility for Dock feedback and read receipts. A scene owns a token;
 * its late cleanup cannot uncover a Dock still covered by another scene. Pixels
 * and native interaction are owned by scene-host, never a Renderer frame loop. */
class BartPresenceCoordinator {
  private readonly owners = new Set<symbol>()
  private readonly listeners = new Set<(visible: boolean) => void>()
  subscribeDockVisibility(listener: (visible: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  hold(token: symbol): () => void {
    const hidden = this.isDockHidden
    this.owners.add(token)
    if (!hidden) this.publish()
    return () => { if (this.owners.delete(token) && !this.isDockHidden) this.publish() }
  }
  get isDockHidden(): boolean { return this.owners.size > 0 }
  reset(): void { if (this.owners.size) { this.owners.clear(); this.publish() } }
  private publish(): void { for (const listener of [...this.listeners]) listener(!this.isDockHidden) }
}
const singleton = new BartPresenceCoordinator()
export function getBartPresenceCoordinator(): BartPresenceCoordinator { return singleton }
