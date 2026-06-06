import type { Market } from '../components/markets/market-card'

export const MARKETS: Market[] = [
  {
    slug: 'bitcoin-best-performance-2026',
    icon: '₿',
    title: 'Will Bitcoin have the best performance in 2026?',
    price: '23.5¢',
    change: '+3.50%',
    isPositive: true,
    volume: '$410.5K',
    liquidity: '$25.7K',
    autoClose: 'Nov 1, 5pm',
    longPct: 88,
  },
  {
    slug: 'opensea-fdv-1b-launch',
    icon: '🌊',
    title: 'Opensea FDV above $1B one day after launch?',
    price: '26.5¢',
    change: '+2.50%',
    isPositive: true,
    volume: '$2M',
    liquidity: '$19.9K',
    autoClose: 'Dec 27, 5pm',
    longPct: 79,
  },
  {
    slug: 'sp500-best-asset-2026',
    icon: '📈',
    title: 'Will S&P 500 be the best performing asset in 2026?',
    price: '42¢',
    change: '-1.20%',
    isPositive: false,
    volume: '$120K',
    liquidity: '$18K',
    autoClose: 'Dec 31, 5pm',
    longPct: 62,
  },
  {
    slug: 'gold-top-performer-2026',
    icon: '🥇',
    title: 'Will Gold be the top performing asset class in 2026?',
    price: '34¢',
    change: '+0.80%',
    isPositive: true,
    volume: '$85K',
    liquidity: '$12K',
    autoClose: 'Dec 31, 5pm',
    longPct: 55,
  },
  {
    slug: 'ethereum-merge-upgrade',
    icon: 'Ξ',
    title: 'Will Ethereum reach $5,000 before end of 2026?',
    price: '41¢',
    change: '+5.10%',
    isPositive: true,
    volume: '$230K',
    liquidity: '$34K',
    autoClose: 'Dec 31, 5pm',
    longPct: 71,
  },
  {
    slug: 'fed-rate-cut-q3-2026',
    icon: '🏦',
    title: 'Will the Fed cut rates in Q3 2026?',
    price: '58¢',
    change: '-0.50%',
    isPositive: false,
    volume: '$190K',
    liquidity: '$28K',
    autoClose: 'Sep 30, 5pm',
    longPct: 58,
  },
]

export const MARKET_DETAIL: Record<string, {
  market: Market
  openInterest: string
  capacityLeft: string
  relatedMarkets: Array<{ name: string; price: string }>
  ohlc: { open: number; high: number; low: number; close: number; change: number; changePct: number }
}> = {
  'bitcoin-best-performance-2026': {
    market: MARKETS[0],
    openInterest: '$0',
    capacityLeft: '$50K',
    relatedMarkets: [
      { name: 'S&P 500', price: '42¢' },
      { name: 'Gold', price: '34¢' },
      { name: 'Bitcoin', price: '22¢' },
    ],
    ohlc: { open: 19.0, high: 19.0, low: 19.0, close: 19.0, change: 0.0, changePct: 0.0 },
  },
  'opensea-fdv-1b-launch': {
    market: MARKETS[1],
    openInterest: '$176',
    capacityLeft: '$24.8K',
    relatedMarkets: [],
    ohlc: { open: 27.0, high: 26.5, low: 26.5, close: 26.5, change: -0.5, changePct: -1.85 },
  },
}
