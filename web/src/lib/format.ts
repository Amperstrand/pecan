export function formatAmount(amount: number, unit: string) {
  return `${new Intl.NumberFormat().format(amount)} ${unit.toUpperCase()}`
}

export function formatSignedAmount(amount: number, unit: string) {
  if (amount < 0) return `-${formatAmount(Math.abs(amount), unit)}`
  return formatAmount(amount, unit)
}

export function compactNumber(amount: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(amount)
}

export function formatAge(then: number, now: number) {
  if (then >= now) return "just now"
  const seconds = now - then
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

export function formatExpiry(expiry: number | null | undefined, now: number) {
  if (!expiry) return "-"
  if (expiry <= now) return `expired ${formatAge(expiry, now)}`
  const delta = expiry - now
  if (delta < 3600) return `in ${Math.floor(delta / 60)}m`
  if (delta < 86_400) return `in ${Math.floor(delta / 3600)}h`
  return `in ${Math.floor(delta / 86_400)}d`
}

export function formatCountdown(until: number, now: number) {
  const delta = Math.max(until - now, 0)
  if (delta >= 3600) return `${Math.floor(delta / 3600)}h ${Math.floor((delta % 3600) / 60)}m`
  if (delta >= 60) return `${Math.floor(delta / 60)}m ${delta % 60}s`
  return `${delta}s`
}

export function formatDateTime(ts: number) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
