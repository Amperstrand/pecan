import * as React from "react"
import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    className={cn(
      "min-h-20 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm leading-5 text-foreground transition-colors placeholder:text-muted-foreground/85 focus:border-primary focus:outline-none focus:shadow-[var(--shadow-focus)] disabled:cursor-not-allowed disabled:opacity-55",
      className,
    )}
    ref={ref}
    {...props}
  />
))
Textarea.displayName = "Textarea"

export { Textarea }
