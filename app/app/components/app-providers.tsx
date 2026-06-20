import { useEffect, useMemo, useState } from 'react'
import { createNetworkConfig, SuiClientProvider, WalletProvider } from '@mysten/dapp-kit'
import { registerEnokiWallets } from '@mysten/enoki'
import { getJsonRpcFullnodeUrl, SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

type EnokiNetwork = 'mainnet' | 'testnet' | 'devnet'

const enokiNetworks = new Set(['mainnet', 'testnet', 'devnet'])

function configuredNetwork(): EnokiNetwork {
  const value = (import.meta.env.VITE_ENOKI_NETWORK ?? import.meta.env.VITE_SUI_NETWORK ?? 'testnet') as string
  return enokiNetworks.has(value) ? value as EnokiNetwork : 'testnet'
}

export function getEnokiConfig() {
  return {
    apiKey: (import.meta.env.VITE_ENOKI_API_KEY as string | undefined)?.trim() ?? '',
    googleClientId: (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? '',
    network: configuredNetwork(),
  }
}

const enokiNetwork = configuredNetwork()

const { networkConfig } = createNetworkConfig({
  devnet: { url: getJsonRpcFullnodeUrl('devnet') },
  testnet: { url: getJsonRpcFullnodeUrl('testnet') },
  mainnet: { url: getJsonRpcFullnodeUrl('mainnet') },
  localnet: { url: 'http://127.0.0.1:9000' },
})

function EnokiWalletRegistration() {
  useEffect(() => {
    const config = getEnokiConfig()
    if (!config.apiKey || !config.googleClientId) return undefined

    const client = new SuiJsonRpcClient({
      network: config.network,
      url: getJsonRpcFullnodeUrl(config.network),
    })

    const { unregister } = registerEnokiWallets({
      apiKey: config.apiKey,
      client,
      network: config.network,
      providers: {
        google: {
          clientId: config.googleClientId,
          redirectUrl: window.location.origin,
        },
      },
    })

    return unregister
  }, [])

  return null
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const preferredWallets = useMemo(() => ['Sign in with Google'], [])

  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={enokiNetwork}>
        <EnokiWalletRegistration />
        <WalletProvider autoConnect preferredWallets={preferredWallets} theme={null}>
          {children}
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  )
}
