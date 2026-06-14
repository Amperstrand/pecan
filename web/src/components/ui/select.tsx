import * as React from "react"
import { cn } from "@/lib/utils"

const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      className={cn(
        "h-9 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-foreground transition-colors focus:border-primary focus:outline-none focus:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-55",
        className,
      )}
      ref={ref}
      {...props}
    >
      {children}
    </select>
  ),
)
Select.displayName = "Select"

export { Select }
