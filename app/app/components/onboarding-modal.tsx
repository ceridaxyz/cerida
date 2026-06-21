import { useEffect, useState } from 'react'
import { ConnectModal } from '@mysten/dapp-kit'

export function OnboardingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <ConnectModal
      trigger={<button className="hidden" aria-hidden="true" />}
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose()
        }
      }}
    />
  )
}

export default OnboardingModal
