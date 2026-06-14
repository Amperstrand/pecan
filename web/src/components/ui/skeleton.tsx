import { cn } from "@/lib/utils"
import type * as React from "react"

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-sm bg-surface-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
