import type { ClientToolStep, ReplyView } from '../../services/chat/view.js'

export const getClientToolsAreaTitle = (
  view: ReplyView,
  streaming: boolean,
  now: number,
  hasResponse: boolean,
  zh: boolean
): string => {
  const toolSteps = view.steps.filter(
    (step): step is ClientToolStep =>
      step.type === 'client_tool' && step.block.status !== 'aborted_loop'
  )

  let runningStep: ClientToolStep | undefined
  for (let i = toolSteps.length - 1; i >= 0; i--) {
    if (toolSteps[i].block.status === 'running') {
      runningStep = toolSteps[i]
      break
    }
  }

  let hasActiveThinking = false
  for (const step of view.steps) {
    if (step.type === 'thinking') {
      const last = step.blocks[step.blocks.length - 1]
      if (last && last.startedAt !== undefined && last.endedAt === undefined) {
        hasActiveThinking = true
      }
    }
  }

  if (streaming && (!hasResponse || Boolean(runningStep))) {
    if (runningStep) {
      const n = runningStep.stepNumber
      if (runningStep.block.name === 'web_search') {
        return zh ? `正在搜索网页 · 第 ${n} 步` : `Searching web · Step ${n}`
      }
      if (runningStep.block.name === 'web_fetch') {
        return zh ? `正在读取网页 · 第 ${n} 步` : `Reading page · Step ${n}`
      }
      return zh ? `正在调用工具 · 第 ${n} 步` : `Running tool · Step ${n}`
    }
    if (hasActiveThinking) {
      const n = toolSteps.length + 1
      return zh ? `正在思考 · 第 ${n} 步` : `Thinking · Step ${n}`
    }
    if (toolSteps.length > 0) {
      const n = toolSteps[toolSteps.length - 1].stepNumber
      return zh ? `正在检索 · 第 ${n} 步` : `Searching · Step ${n}`
    }
    return zh ? '正在检索' : 'Searching'
  }

  const stepCount = toolSteps.length
  const hasThinking = view.steps.some((step) => step.type === 'thinking')

  if (!streaming && !hasResponse) {
    return zh
      ? `已停止检索（${stepCount} 步）`
      : `Search stopped (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
  }

  const intervals: Array<[number, number]> = []
  let fallbackMs = 0
  for (const step of view.steps) {
    if (step.type === 'thinking') {
      for (const block of step.blocks) {
        if (block.startedAt !== undefined) {
          intervals.push([block.startedAt, block.endedAt ?? now])
        } else if (block.elapsedSeconds !== undefined) {
          fallbackMs += block.elapsedSeconds * 1000
        }
      }
    } else if (step.type === 'client_tool' && step.block.status !== 'aborted_loop') {
      intervals.push([step.block.startedAt, step.block.endedAt ?? now])
    }
  }

  let totalMs = fallbackMs
  if (intervals.length > 0) {
    intervals.sort((a, b) => a[0] - b[0])
    let [curStart, curEnd] = intervals[0]
    for (let i = 1; i < intervals.length; i++) {
      const [start, end] = intervals[i]
      if (start <= curEnd) {
        curEnd = Math.max(curEnd, end)
      } else {
        totalMs += Math.max(0, curEnd - curStart)
        curStart = start
        curEnd = end
      }
    }
    totalMs += Math.max(0, curEnd - curStart)
  }

  const seconds = Math.max(1, Math.round(totalMs / 1000))
  if (hasThinking) {
    return zh
      ? `已思考与检索（用时 ${seconds} 秒 · ${stepCount} 步）`
      : `Thought & searched (${seconds}s · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
  }
  return zh
    ? `已检索（用时 ${seconds} 秒 · ${stepCount} 步）`
    : `Searched (${seconds}s · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
}
