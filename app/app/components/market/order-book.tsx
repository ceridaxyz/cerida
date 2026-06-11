const OrderBook = () => {
  return (
    <div className="flex flex-col bg-surface-primary h-full min-w-0">
      <div className="flex items-center px-3 py-2.5 border-b border-border-subtle shrink-0">
        <span className="text-[12px] font-semibold text-text-tertiary tracking-widest uppercase">Order Book</span>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <span className="text-[12px] text-text-tertiary">No orders</span>
      </div>
    </div>
  )
}

export default OrderBook
