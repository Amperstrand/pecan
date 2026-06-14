import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const alertVariants = cva("rounded-sm border px-3.5 py-3 text-sm leading-5", {
  variants: {
    variant: {
      info: "border-transparent bg-primary-soft text-primary",
      warning: "border-transparent bg-warning-soft text-warning",
      danger: "border-transparent bg-danger-soft text-danger",
      success: "border-transparent bg-success-soft text-success",
      neutral: "border-border bg-surface-muted text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
})

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

function Alert({ className, variant, ...props }: AlertProps) {
  return <div className={cn(alertVariants({ variant, className }))} {...props} />
}

export { Alert }
