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
  let confirmingStep: ClientToolStep | undefined
  for (let i = toolSteps.length - 1; i >= 0; i--) {
    const status = toolSteps[i].block.status
    if (!confirmingStep && status === 'awaiting_confirmation') {
      confirmingStep = toolSteps[i]
    }
    if (!runningStep && status === 'running') {
      runningStep = toolSteps[i]
    }
    if (confirmingStep && runningStep) {
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

  if (streaming && (!hasResponse || Boolean(runningStep) || Boolean(confirmingStep))) {
    if (confirmingStep) {
      const n = confirmingStep.stepNumber
      return zh ? `等待确认工具调用 · 第 ${n} 步` : `Awaiting confirmation · Step ${n}`
    }
    if (runningStep) {
      const n = runningStep.stepNumber
      if (runningStep.block.name === 'web_search') {
        return zh ? `正在搜索网页 · 第 ${n} 步` : `Searching web · Step ${n}`
      }
      if (runningStep.block.name === 'web_fetch') {
        return zh ? `正在读取网页 · 第 ${n} 步` : `Reading page · Step ${n}`
      }
      if (runningStep.block.name === 'run_python') {
        return zh ? `正在运行 Python · 第 ${n} 步` : `Running Python · Step ${n}`
      }
      if (runningStep.block.name === 'search_history') {
        return zh ? `正在搜索历史对话 · 第 ${n} 步` : `Searching history · Step ${n}`
      }
      if (runningStep.block.name === 'memory_read') {
        return zh ? `正在读取记忆 · 第 ${n} 步` : `Reading memory · Step ${n}`
      }
      if (runningStep.block.name === 'memory_search') {
        return zh ? `正在检索记忆 · 第 ${n} 步` : `Searching memory · Step ${n}`
      }
      if (runningStep.block.name === 'memory_write') {
        return zh ? `正在更新记忆 · 第 ${n} 步` : `Updating memory · Step ${n}`
      }
      const label = runningStep.block.displayName || runningStep.block.name
      return zh ? `正在调用 ${label} · 第 ${n} 步` : `Running ${label} · Step ${n}`
    }
    if (hasActiveThinking) {
      const n = toolSteps.length + 1
      return zh ? `正在思考 · 第 ${n} 步` : `Thinking · Step ${n}`
    }
    if (toolSteps.length > 0) {
      const n = toolSteps[toolSteps.length - 1].stepNumber
      return zh ? `正在处理 · 第 ${n} 步` : `Working · Step ${n}`
    }
    return zh ? '正在处理' : 'Working'
  }

  const stepCount = toolSteps.length
  const hasThinking = view.steps.some((step) => step.type === 'thinking')
  const memoryNames = new Set(['memory_read', 'memory_search', 'memory_write'])
  const hasOnlyMemoryTools =
    toolSteps.length > 0 && toolSteps.every((step) => memoryNames.has(step.block.name))
  const hasOnlySearchTools =
    toolSteps.length > 0 &&
    toolSteps.every(
      (step) => step.block.name === 'web_search' || step.block.name === 'web_fetch'
    )

  if (!streaming && !hasResponse) {
  if (hasOnlySearchTools) {
      return zh
        ? `已停止检索（${stepCount} 步）`
        : `Search stopped (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
    }
    return zh
      ? `已停止（${stepCount} 步）`
      : `Stopped (${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
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
  if (hasOnlyMemoryTools && !hasThinking) {
    const hasWrite = toolSteps.some((step) => step.block.name === 'memory_write')
    const hasRead = toolSteps.some((step) => step.block.name !== 'memory_write')
    if (hasWrite && hasRead) {
      return zh ? `已读取并更新记忆（用时 ${seconds} 秒）` : `Read & updated memory (${seconds}s)`
    }
    if (hasWrite) {
      return zh ? `已更新记忆（用时 ${seconds} 秒）` : `Updated memory (${seconds}s)`
    }
    return zh ? `已读取记忆（用时 ${seconds} 秒）` : `Read memory (${seconds}s)`
  }
  if (hasOnlySearchTools) {
    if (hasThinking) {
      return zh
        ? `已思考与检索（用时 ${seconds} 秒 · ${stepCount} 步）`
        : `Thought & searched (${seconds}s · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
    }
    return zh
      ? `已检索（用时 ${seconds} 秒 · ${stepCount} 步）`
      : `Searched (${seconds}s · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
  }
  if (hasThinking) {
    return zh
      ? `已思考并完成（用时 ${seconds} 秒 · ${stepCount} 步）`
      : `Thought & used tools (${seconds}s · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
  }
  return zh
    ? `已使用工具（用时 ${seconds} 秒 · ${stepCount} 步）`
    : `Used tools (${seconds}s · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'})`
}
