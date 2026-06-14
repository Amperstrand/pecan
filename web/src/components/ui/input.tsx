import * as React from "react"
import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "h-9 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground/85 read-only:bg-surface-muted read-only:text-muted-foreground focus:border-primary focus:outline-none focus:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-55",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
)
Input.displayName = "Input"

export { Input }
