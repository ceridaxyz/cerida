import { useParams } from 'react-router'
import type { Route } from './+types/route'
import Navbar from '../../components/navbar'
import AlertBanner from '../../components/alert-banner'
import MarketHeader from '../../components/market/market-header'
import ChartPlaceholder from '../../components/market/chart-placeholder'
import OrderBook from '../../components/market/order-book'
import TradingPanel from '../../components/market/trading-panel'
import BottomTabs from '../../components/market/bottom-tabs'
import { MARKET_DETAIL, MARKETS } from '../../data/markets'

export const meta = ({ params }: Route.MetaArgs): Route.MetaDescriptors => {
  const detail = MARKET_DETAIL[params.slug ?? '']
  return [
    { title: detail ? `${detail.market.title} — Ultramarkets` : 'Market — Ultramarkets' },
    { name: 'description', content: '' },
  ]
}

const MarketPage = () => {
  const { slug } = useParams<{ slug: string }>()
  const detail = slug ? MARKET_DETAIL[slug] : undefined

  // Fallback to first market if slug not found in detail map
  const market = detail?.market ?? MARKETS.find((m) => m.slug === slug) ?? MARKETS[0]
  const ohlc = detail?.ohlc

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface-primary">
      <Navbar />
      <AlertBanner />

      {/* Main 3-column layout */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Market header spanning full width */}
        <MarketHeader
          icon={market.icon}
          title={market.title}
          price={market.price}
          change={market.change}
          isPositive={market.isPositive}
          openInterest={detail?.openInterest ?? '$0'}
          capacityLeft={detail?.capacityLeft ?? '$0'}
          volume={market.volume}
          liquidity={market.liquidity}
          autoClose={market.autoClose}
          relatedMarkets={detail?.relatedMarkets ?? []}
        />

        {/* 3-column body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Chart + Bottom tabs */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <div className="flex-1 overflow-hidden">
              <ChartPlaceholder
                symbol={market.slug.split('-')[0].toUpperCase()}
                ohlc={ohlc}
              />
            </div>
            <BottomTabs />
          </div>

          {/* Middle: Order Book */}
          <div className="w-[280px] shrink-0 overflow-hidden">
            <OrderBook />
          </div>

          {/* Right: Trading Panel */}
          <div className="w-[280px] shrink-0 overflow-hidden">
            <TradingPanel />
          </div>
        </div>
      </div>
    </div>
  )
}

export default MarketPage
