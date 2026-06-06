import { useParams } from 'react-router'
import Navbar from '../../components/navbar'
import AlertBanner from '../../components/alert-banner'
import MarketHeader from '../../components/market/market-header'
import ChartPlaceholder from '../../components/market/chart-placeholder'
import OrderBook from '../../components/market/order-book'
import TradingPanel from '../../components/market/trading-panel'
import BottomTabs from '../../components/market/bottom-tabs'
import { MARKET_DETAIL, MARKETS } from '../../data/markets'

export const meta = () => [{ title: 'Market — Ultramarkets' }]

const MarketPage = () => {
  const { slug } = useParams<{ slug: string }>()
  const detail = slug ? MARKET_DETAIL[slug] : undefined
  const market = detail?.market ?? MARKETS.find((m) => m.slug === slug) ?? MARKETS[0]
  const ohlc = detail?.ohlc

  return (
    // Outer shell: very dark background so panels "float" on it
    <div className="flex flex-col h-screen overflow-hidden" style={{ backgroundColor: '#161616' }}>
      <Navbar />
      <AlertBanner />

      {/* Panel row — gaps expose the dark outer background */}
      <div className="flex flex-1 overflow-hidden gap-1.5 p-1.5 pt-1.5 min-h-0">

        {/* LEFT panel: rounded card */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden rounded-[10px] bg-surface-primary">
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
          <div className="flex-1 overflow-hidden">
            <ChartPlaceholder
              symbol={market.slug.split('-')[0].toUpperCase()}
              ohlc={ohlc}
            />
          </div>
          <BottomTabs />
        </div>

        {/* MIDDLE panel: Order Book */}
        <div className="w-[272px] shrink-0 overflow-hidden rounded-[10px] bg-surface-primary">
          <OrderBook />
        </div>

        {/* RIGHT panel: Trading Panel */}
        <div className="w-[272px] shrink-0 overflow-hidden rounded-[10px] bg-surface-primary">
          <TradingPanel />
        </div>

      </div>
    </div>
  )
}

export default MarketPage
