import type { ReactNode } from "react"

export function StatTile({
  label,
  value,
  detail,
  icon,
}: {
  label: string
  value: string
  detail: string
  icon: ReactNode
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="grid size-7 place-items-center rounded-md bg-muted text-foreground [&_svg]:size-4">
          {icon}
        </span>
      </div>
      <div className="mt-3 break-words text-xl font-semibold leading-tight">{value}</div>
      <div className="mt-1 break-words text-xs leading-5 text-muted-foreground">{detail}</div>
    </div>
  )
}
