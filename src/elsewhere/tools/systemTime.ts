import type { UserBlockParam } from '../../services/api/types.js'

const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const LOCAL_DATE_PREFIX = 'Current local date: '

/** 按日粒度的本地日期快照（不含时分，避免同天内破坏前缀缓存）。 */
export const formatLocalDateLine = (now: Date = new Date()): string => {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const weekday = EN_WEEKDAYS[now.getDay()] ?? 'Sunday'

  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absMinutes = Math.abs(offsetMinutes)
  const offHours = String(Math.floor(absMinutes / 60)).padStart(2, '0')
  const offMins = String(absMinutes % 60).padStart(2, '0')

  return `${LOCAL_DATE_PREFIX}${year}-${month}-${day} (${weekday}, UTC${sign}${offHours}:${offMins}).`
}

export const isLocalDateReminder = (reminder: string): boolean =>
  reminder.trim().startsWith(LOCAL_DATE_PREFIX)

export const formatReminderPrefix = (reminder: string): string => {
  const trimmed = reminder.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.startsWith(LOCAL_DATE_PREFIX)) {
    return `[${trimmed}]`
  }
  const parts = trimmed.split(',')
  if (parts.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0].trim())) {
    const date = parts[0].trim()
    const weekday = parts[1].trim()
    return weekday
      ? `[${LOCAL_DATE_PREFIX}${date} (${weekday}).]`
      : `[${LOCAL_DATE_PREFIX}${date}.]`
  }
  return `[${trimmed}]`
}

export const isToolResultOnlyUserContent = (content: string | UserBlockParam[]): boolean =>
  Array.isArray(content) &&
  content.length > 0 &&
  content.every((block) => block.type === 'tool_result')

export const prependReminderToUserContent = <T extends string | UserBlockParam[]>(
  content: T,
  reminder: string
): T => {
  const prefix = formatReminderPrefix(reminder)
  if (!prefix) {
    return content
  }
  if (typeof content === 'string') {
    return (content ? `${prefix}\n\n${content}` : prefix) as T
  }
  if (isToolResultOnlyUserContent(content)) {
    return content
  }
  const firstTextIndex = content.findIndex((block) => block.type === 'text')
  if (firstTextIndex >= 0) {
    return content.map((block, index) => {
      if (index !== firstTextIndex || block.type !== 'text') {
        return block
      }
      return {
        ...block,
        text: block.text ? `${prefix}\n\n${block.text}` : prefix,
      }
    }) as T
  }
  const firstRegularIndex = content.findIndex((block) => block.type !== 'tool_result')
  const insertAt = firstRegularIndex >= 0 ? firstRegularIndex : content.length
  return [
    ...content.slice(0, insertAt),
    { type: 'text', text: prefix },
    ...content.slice(insertAt),
  ] as T
}
