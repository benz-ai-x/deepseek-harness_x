/** Host-only Agent Teams service request values. */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Request to provision one continuable teammate under the caller's Team. */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  /** Normalized per-child options passed unchanged to the continuable manager. */
  readonly agentOptions?: AgentOptions
  /** Caller cancellation until the initial prompt is durable; Team lifecycle cancellation afterward. */
  readonly signal: AbortSignal
}
