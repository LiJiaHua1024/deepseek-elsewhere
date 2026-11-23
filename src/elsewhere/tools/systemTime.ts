const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export const formatLocalDateTimeLine = (now: Date = new Date()): string => {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hour = String(now.getHours()).padStart(2, '0')
  const minute = String(now.getMinutes()).padStart(2, '0')
  const weekday = EN_WEEKDAYS[now.getDay()] ?? 'Sunday'

  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absMinutes = Math.abs(offsetMinutes)
  const offHours = String(Math.floor(absMinutes / 60)).padStart(2, '0')
  const offMins = String(absMinutes % 60).padStart(2, '0')

  return `Current local date and time: ${year}-${month}-${day} ${hour}:${minute} (${weekday}, UTC${sign}${offHours}:${offMins}).`
}

export const injectLocalDateTime = (baseSystem: string, now: Date = new Date()): string => {
  const line = formatLocalDateTimeLine(now)
  const trimmed = baseSystem.trim()
  return trimmed ? `${trimmed}\n\n${line}` : line
}
