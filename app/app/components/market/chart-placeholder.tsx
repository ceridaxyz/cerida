interface ChartPlaceholderProps {
  symbol: string
  ohlc?: { open: number; high: number; low: number; close: number; change: number; changePct: number }
}

const ChartPlaceholder = (_props: ChartPlaceholderProps) => (
  <div className="flex-1 h-full bg-surface-primary" />
)

export default ChartPlaceholder
