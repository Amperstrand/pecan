import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { CirculationPoint } from "@/lib/api"
import { compactNumber, formatAmount, formatDateTime, formatSignedAmount } from "@/lib/format"
import { EmptyState } from "@/components/shared/bits"

export function CirculationChart({ data, unit }: { data: CirculationPoint[]; unit: string }) {
  const chartData = data.map((point) => ({
    ...point,
    label: new Date(point.ts * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
  }))

  if (chartData.length === 0) {
    return (
      <EmptyState
        title="No circulation history yet"
        body="Settled deposits and payouts will build this graph over time."
      />
    )
  }

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ left: 2, right: 12, top: 14, bottom: 0 }}>
          <defs>
            <linearGradient id="circulationFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-3)" stopOpacity={0.5} />
              <stop offset="95%" stopColor="var(--chart-3)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          />
          <YAxis
            width={64}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickFormatter={(value) => compactNumber(Number(value))}
          />
          <Tooltip content={<ChartTooltip unit={unit} />} />
          <Area
            type="monotone"
            dataKey="circulation"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="url(#circulationFill)"
            activeDot={{ r: 4, fill: "var(--chart-1)", stroke: "var(--background)" }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
  unit,
}: {
  active?: boolean
  payload?: Array<{ payload: CirculationPoint }>
  unit: string
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <div className="text-xs font-medium text-muted-foreground">{formatDateTime(point.ts)}</div>
      <div className="mt-1 text-sm font-semibold">
        {formatSignedAmount(point.circulation, unit)}
      </div>
      <div className="text-xs text-muted-foreground">
        Delta {point.delta > 0 ? "+" : ""}
        {formatAmount(point.delta, unit)}
      </div>
    </div>
  )
}
