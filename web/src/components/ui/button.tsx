import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out disabled:pointer-events-none disabled:opacity-55 data-[loading=true]:pointer-events-none data-[loading=true]:opacity-75 [&_svg]:size-4 [&_svg]:shrink-0 active:translate-y-px",
  {
    variants: {
      variant: {
        primary:
          "border border-primary bg-primary text-primary-foreground hover:bg-primary/90",
        secondary:
          "border border-border-strong bg-surface text-foreground hover:bg-surface-muted",
        ghost:
          "border border-transparent bg-transparent text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        danger:
          "border border-border-strong bg-transparent text-danger hover:border-danger hover:bg-danger hover:text-white",
        success:
          "border border-success bg-success text-white hover:bg-success/90",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-10 px-5",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      data-loading={loading ? "true" : "false"}
      ref={ref}
      {...props}
    >
      {children}
    </button>
  ),
)
Button.displayName = "Button"

export { Button, buttonVariants }
