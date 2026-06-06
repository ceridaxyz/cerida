import { useParams } from 'react-router'
import Navbar from '../../components/navbar'
import AlertBanner from '../../components/alert-banner'
import MarketHeader from '../../components/market/market-header'
import ChartPlaceholder from '../../components/market/chart-placeholder'
import OrderBook from '../../components/market/order-book'
import TradingPanel from '../../components/market/trading-panel'
import BottomTabs from '../../components/market/bottom-tabs'
import { MARKET_DETAIL, MARKETS } from '../../data/markets'

export const meta = () => [
  { title: 'Market — Ultramarkets' },
]

const MarketPage = () => {
  const { slug } = useParams<{ slug: string }>()
  const detail = slug ? MARKET_DETAIL[slug] : undefined
  const market = detail?.market ?? MARKETS.find((m) => m.slug === slug) ?? MARKETS[0]
  const ohlc = detail?.ohlc

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface-primary">
      <Navbar />
      <AlertBanner />

      <div className="flex flex-col flex-1 overflow-hidden">
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

        <div className="flex flex-1 overflow-hidden">
          {/* Chart + bottom tabs */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <div className="flex-1 overflow-hidden">
              <ChartPlaceholder
                symbol={market.slug.split('-')[0].toUpperCase()}
                ohlc={ohlc}
              />
            </div>
            <BottomTabs />
          </div>

          {/* Order Book */}
          <div className="w-[280px] shrink-0 overflow-hidden">
            <OrderBook />
          </div>

          {/* Trading Panel */}
          <div className="w-[280px] shrink-0 overflow-hidden">
            <TradingPanel />
          </div>
        </div>
      </div>
    </div>
  )
}

export default MarketPage
