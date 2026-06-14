import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none",
  {
    variants: {
      variant: {
        neutral: "border-border bg-surface-muted text-muted-foreground",
        info: "border-transparent bg-primary-soft text-primary",
        success: "border-transparent bg-success-soft text-success",
        warning: "border-transparent bg-warning-soft text-warning",
        danger: "border-transparent bg-danger-soft text-danger",
      },
      dot: {
        true: "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current",
      },
    },
    defaultVariants: {
      variant: "neutral",
      dot: true,
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, dot, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, dot, className }))} {...props} />
}

export { Badge, badgeVariants }
