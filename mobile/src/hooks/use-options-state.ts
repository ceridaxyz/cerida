import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

export interface Band {
  idx: number;
  lower: number;
  upper: number;
}

export interface Epoch {
  id: string;
  idx: number;
  start: number;
  end: number;
}

export interface Leg {
  key: string;
  asset: string;
  epochId: string;
  bandIdx: number;
  lower: number;
  upper: number;
  type: 'YES' | 'NO';
  cost: number;
  multiplier: number;
  prob: number;
  status: 'selected' | 'active' | 'won' | 'lost' | 'claimed';
  settlePrice?: number;
}

const ASSET_CENTERS: Record<string, number> = {
  BTC: 98200,
  ETH: 3450,
  SUI: 3.65,
};

const ASSET_SIGMAS: Record<string, number> = {
  BTC: 150,
  ETH: 15,
  SUI: 0.04,
};

const EPOCH_MS = 60_000;
const EDGE = 0.06;

// Simple normal CDF approximation
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return x >= 0 ? y : -y;
}
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

export function useOptionsState() {
  const [asset, setAsset] = useState<string>('BTC');
  const [balance, setBalance] = useState<number>(10000);
  const [stake, setStake] = useState<number>(10);
  const [now, setNow] = useState<number>(() => Date.now());
  const [price, setPrice] = useState<number>(() => ASSET_CENTERS[asset]!);
  
  // Track historical prices for a mini-chart/sparkline
  const [history, setHistory] = useState<{ t: number; price: number }[]>([]);

  // Selected or active option legs
  const [legs, setLegs] = useState<Map<string, Leg>>(new Map());

  const center = ASSET_CENTERS[asset]!;
  const sigma = ASSET_SIGMAS[asset]!;

  // Reset price and history when asset changes
  useEffect(() => {
    setPrice(ASSET_CENTERS[asset]!);
    setHistory([{ t: Date.now(), price: ASSET_CENTERS[asset]! }]);
  }, [asset]);

  // Live Price Ticking (Random Walk)
  useEffect(() => {
    const interval = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setPrice((p) => {
        const change = (Math.random() - 0.5) * (sigma * 0.4);
        const pull = (ASSET_CENTERS[asset]! - p) * 0.02; // soft pull to center
        const next = p + change + pull;
        
        setHistory((h) => {
          const limit = [...h, { t, price: next }];
          return limit.slice(-50); // keep last 50 points
        });
        return next;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [asset, sigma]);

  // Generate strikes/bands around center
  const bands = useMemo<Band[]>(() => {
    const list: Band[] = [];
    const step = sigma * 0.8;
    for (let i = -6; i <= 5; i++) {
      const lower = center + i * step;
      const upper = center + (i + 1) * step;
      // round to clean numbers
      const fmtLower = asset === 'SUI' ? Math.round(lower * 1000) / 1000 : Math.round(lower);
      const fmtUpper = asset === 'SUI' ? Math.round(upper * 1000) / 1000 : Math.round(upper);
      list.push({
        idx: i + 6,
        lower: fmtLower,
        upper: fmtUpper,
      });
    }
    return list.reverse(); // high prices at top
  }, [center, sigma, asset]);

  // Generate sliding epochs
  const nowBucket = Math.floor(now / EPOCH_MS);
  const epochs = useMemo<Epoch[]>(() => {
    return Array.from({ length: 6 }, (_, k) => {
      const idxAbs = nowBucket + k;
      const start = idxAbs * EPOCH_MS;
      return {
        id: `e${idxAbs}`,
        idx: k,
        start,
        end: start + EPOCH_MS,
      };
    });
  }, [nowBucket]);

  const [selectedEpochId, setSelectedEpochId] = useState<string>('');
  
  // Set default selected epoch to the first future one if not set
  useEffect(() => {
    if (epochs.length > 0 && (!selectedEpochId || !epochs.find(e => e.id === selectedEpochId))) {
      setSelectedEpochId(epochs[1]!.id);
    }
  }, [epochs, selectedEpochId]);

  // Calculate cell probabilities and payouts
  const getCellStats = useCallback((band: Band, epoch: Epoch) => {
    const epochsAhead = Math.max(1, (epoch.end - now) / EPOCH_MS);
    const horizonSigma = sigma * Math.sqrt(epochsAhead);
    
    // Probability that price settles in [lower, upper]
    const pUpper = normCdf((band.upper - price) / horizonSigma);
    const pLower = normCdf((band.lower - price) / horizonSigma);
    let rawProb = pUpper - pLower;
    
    // Cap prob
    rawProb = Math.max(0.02, Math.min(0.98, rawProb));
    
    const multiplierYES = (1 - EDGE) / rawProb;
    const multiplierNO = (1 - EDGE) / (1 - rawProb);
    
    return {
      probYES: rawProb,
      probNO: 1 - rawProb,
      multYES: Math.round(multiplierYES * 100) / 100,
      multNO: Math.round(multiplierNO * 100) / 100,
    };
  }, [price, sigma]);

  // Toggling or adding a leg
  const toggleLeg = useCallback((epoch: Epoch, band: Band, type: 'YES' | 'NO') => {
    const key = `${asset}:${epoch.id}:${band.idx}:${type}`;
    setLegs((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        const stats = getCellStats(band, epoch);
        const mult = type === 'YES' ? stats.multYES : stats.multNO;
        const prob = type === 'YES' ? stats.probYES : stats.probNO;
        
        next.set(key, {
          key,
          asset,
          epochId: epoch.id,
          bandIdx: band.idx,
          lower: band.lower,
          upper: band.upper,
          type,
          cost: stake,
          multiplier: mult,
          prob,
          status: 'selected',
        });
      }
      return next;
    });
  }, [asset, stake, getCellStats]);

  const updateLegCost = useCallback((key: string, cost: number) => {
    setLegs((prev) => {
      const item = prev.get(key);
      if (!item || item.status !== 'selected') return prev;
      const next = new Map(prev);
      next.set(key, {
        ...item,
        cost: Math.max(1, cost),
      });
      return next;
    });
  }, []);

  const removeLeg = useCallback((key: string) => {
    setLegs((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const clearSelected = useCallback(() => {
    setLegs((prev) => {
      const next = new Map(prev);
      for (const [k, v] of next.entries()) {
        if (v.status === 'selected') next.delete(k);
      }
      return next;
    });
  }, []);

  // Confirm and submit selected orders
  const confirmOrders = useCallback(() => {
    setLegs((prev) => {
      const next = new Map(prev);
      let totalCost = 0;
      for (const [k, v] of next.entries()) {
        if (v.status === 'selected') {
          totalCost += v.cost;
          next.set(k, {
            ...v,
            status: 'active',
          });
        }
      }
      setBalance((b) => b - totalCost);
      return next;
    });
  }, []);

  // Epoch Rollover & Settlement logic
  const lastBucketRef = useRef(nowBucket);
  useEffect(() => {
    if (nowBucket !== lastBucketRef.current) {
      const expiredBucket = lastBucketRef.current;
      lastBucketRef.current = nowBucket;

      // Settlement price for the expired epoch
      const settlePrice = price;

      setLegs((prev) => {
        const next = new Map(prev);
        let updated = false;

        for (const [k, leg] of next.entries()) {
          // If leg is active and belongs to the expired epoch
          if (leg.status === 'active' && leg.epochId === `e${expiredBucket}`) {
            const priceInBand = settlePrice >= leg.lower && settlePrice < leg.upper;
            const won = leg.type === 'YES' ? priceInBand : !priceInBand;

            next.set(k, {
              ...leg,
              status: won ? 'won' : 'lost',
              settlePrice,
            });
            updated = true;
          }
        }
        return updated ? next : prev;
      });
    }
  }, [nowBucket, price]);

  // Claim winning payout
  const claimPayout = useCallback((key: string) => {
    setLegs((prev) => {
      const item = prev.get(key);
      if (!item || item.status !== 'won') return prev;
      
      const payout = item.cost * item.multiplier;
      setBalance((b) => b + payout);

      const next = new Map(prev);
      next.set(key, {
        ...item,
        status: 'claimed',
      });
      return next;
    });
  }, []);

  const legsArr = useMemo(() => [...legs.values()], [legs]);

  return {
    asset,
    setAsset,
    balance,
    stake,
    setStake,
    now,
    price,
    history,
    bands,
    epochs,
    selectedEpochId,
    setSelectedEpochId,
    getCellStats,
    legs: legsArr,
    toggleLeg,
    updateLegCost,
    removeLeg,
    clearSelected,
    confirmOrders,
    claimPayout,
  };
}

export type OptionsState = ReturnType<typeof useOptionsState>;
