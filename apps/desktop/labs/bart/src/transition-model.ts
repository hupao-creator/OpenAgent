import { targetPose, type Pose, type Role } from '../../../src/renderer/src/bart-motion/resident-pose'
export const roles = [
  { id: 'idle', label: '待机', detail: '自然停留', number: '01' },
  { id: 'running', label: '运行', detail: '彩虹光点与目光', number: '02' },
  { id: 'reasoning', label: '思考', detail: '沿着文字扫读', number: '03' },
  { id: 'tool', label: '工具调用', detail: '收拢目光，专注执行', number: '04' },
  { id: 'reply', label: '最终答复', detail: '回到待机，留下未读提醒', number: '05' }
] as const
export const roleLabel = (role: Role): string => roles.find(item => item.id === role)!.label
export const reasoningText = '先梳理状态之间的关系，再让每一个动作自然衔接。'
export { targetPose, bodyPath, arcSpan, arcSeeds, fitEyes } from '../../../src/renderer/src/bart-motion/resident-pose'
export type { Pose, Role } from '../../../src/renderer/src/bart-motion/resident-pose'
type Channel = keyof Pose
const channels = Object.keys(targetPose('idle', 0, 0)) as Channel[]
const map = (fn: (key: Channel) => number): Pose => Object.fromEntries(channels.map(key => [key, fn(key)])) as Pose
/** Hermite residuals preserve the current pose AND velocity when redirected.
 * The target's ongoing motion continues beneath the residual, without a reset
 * to idle or a second queue. At the endpoint both residual and velocity are 0. */
export class BasicTransitionStudy {
  role: Role = 'idle'
  enteredAt = 0
  private start = 0
  private duration = 0
  private offset = map(() => 0)
  private velocity = map(() => 0)

  sample(time: number): Pose {
    const target = targetPose(this.role, time, this.enteredAt)
    if (!this.duration || time >= this.start + this.duration) return target
    const p = Math.max(0, (time - this.start) / this.duration)
    const hold = 2 * p ** 3 - 3 * p ** 2 + 1
    const tangent = p ** 3 - 2 * p ** 2 + p
    return map(key => target[key] + hold * this.offset[key] + tangent * this.duration * this.velocity[key])
  }

  redirect(role: Role, time: number, duration: number): void {
    const from = this.sample(time), next = this.sample(time + .1)
    this.role = role
    this.enteredAt = time
    const target = targetPose(role, time, time), later = targetPose(role, time + .1, time)
    this.offset = map(key => from[key] - target[key])
    this.velocity = map(key => ((next[key] - from[key]) - (later[key] - target[key])) / .1)
    this.start = time
    this.duration = duration
  }

  progress(time: number): number {
    return this.duration ? Math.min(1, Math.max(0, (time - this.start) / this.duration)) : 1
  }
}
