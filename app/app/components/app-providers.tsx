import { useState } from 'react'
import { createNetworkConfig, SuiClientProvider, WalletProvider, type Theme } from '@mysten/dapp-kit'
import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from './toast/toast-context'
import { ToastContainer } from './toast/toast-container'

const { networkConfig } = createNetworkConfig({
  devnet: { url: getJsonRpcFullnodeUrl('devnet') },
  testnet: { url: getJsonRpcFullnodeUrl('testnet') },
  mainnet: { url: getJsonRpcFullnodeUrl('mainnet') },
  localnet: { url: 'http://127.0.0.1:9000' },
})

const customDarkTheme: Theme = {
  blurs: {
    modalOverlay: 'blur(8px)',
  },
  backgroundColors: {
    primaryButton: '#ffffff',
    primaryButtonHover: 'rgba(255, 255, 255, 0.9)',
    outlineButtonHover: 'rgba(255, 255, 255, 0.05)',
    walletItemHover: 'rgba(255, 255, 255, 0.05)',
    walletItemSelected: 'rgba(255, 255, 255, 0.1)',
    modalOverlay: 'rgba(0, 0, 0, 0.75)',
    modalPrimary: '#161616',
    modalSecondary: '#1c1c1c',
    iconButton: 'transparent',
    iconButtonHover: 'rgba(255, 255, 255, 0.08)',
    dropdownMenu: '#1c1c1c',
    dropdownMenuSeparator: '#2d2d2d',
  },
  borderColors: {
    outlineButton: '#2d2d2d',
  },
  colors: {
    primaryButton: '#000000',
    outlineButton: '#ffffff',
    body: '#ffffff',
    bodyMuted: 'rgba(255, 255, 255, 0.6)',
    bodyDanger: '#ff4d4d',
    iconButton: '#ffffff',
  },
  radii: {
    small: '6px',
    medium: '10px',
    large: '14px',
    xlarge: '18px',
  },
  shadows: {
    primaryButton: 'none',
    walletItemSelected: 'none',
  },
  fontWeights: {
    normal: '400',
    medium: '600',
    bold: '900',
  },
  fontSizes: {
    small: '11px',
    medium: '13px',
    large: '16px',
    xlarge: '20px',
  },
  typography: {
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    fontStyle: 'normal',
    lineHeight: '1.5',
    letterSpacing: 'normal',
  },
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect theme={customDarkTheme}>
          <ToastProvider>
            {children}
            <ToastContainer />
          </ToastProvider>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  )
}
