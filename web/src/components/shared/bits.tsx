import type { ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,0.34fr)_minmax(0,1fr)] items-baseline gap-3 max-sm:grid-cols-1 max-sm:gap-1">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm font-medium">{children}</div>
    </div>
  )
}

export function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  )
}

export function Field({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string
  help?: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help && <p className="m-0 text-xs leading-5 text-muted-foreground">{help}</p>}
    </div>
  )
}

export function MonoChip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-block max-w-full break-all rounded-sm border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard?.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <Button type="button" variant="outline" size="icon" aria-label={label} onClick={() => void copy()}>
      {copied ? <Check /> : <Copy />}
    </Button>
  )
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid justify-items-center gap-1 px-5 py-9 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="max-w-[58ch] text-sm text-muted-foreground">{body}</div>
    </div>
  )
}
