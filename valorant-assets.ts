// Fetches and caches static reference assets from valorant-api.com
// (agents, maps, competitive tiers). These endpoints are public and do not
// require an API key. Results are cached at module level so lookups are instant.

export interface ValorantAssets {
  agentsByName: Record<string, { name: string; icon: string; role?: string }>
  agentsById: Record<string, { name: string; icon: string; role?: string }>
  mapsByName: Record<string, { splash: string; listIcon: string }>
  tiersByNumber: Record<number, { name: string; icon: string }>
  tiersByName: Record<string, { number: number; icon: string }>
}

let assetsPromise: Promise<ValorantAssets> | null = null

function normalizeTierName(name: string): string {
  return name.trim().toLowerCase()
}

async function loadAssets(): Promise<ValorantAssets> {
  const [agentsRes, mapsRes, tiersRes] = await Promise.all([
    fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true'),
    fetch('https://valorant-api.com/v1/maps'),
    fetch('https://valorant-api.com/v1/competitivetiers'),
  ])

  const agentsJson = await agentsRes.json()
  const mapsJson = await mapsRes.json()
  const tiersJson = await tiersRes.json()

  const agentsByName: ValorantAssets['agentsByName'] = {}
  const agentsById: ValorantAssets['agentsById'] = {}
  for (const agent of agentsJson.data || []) {
    if (!agent.displayName) continue
    const agentData = {
      name: agent.displayName,
      icon: agent.displayIcon,
      role: agent.role?.displayName,
    }
    agentsByName[agent.displayName.toLowerCase()] = agentData
    agentsById[agent.uuid.toLowerCase()] = agentData
  }

  const mapsByName: ValorantAssets['mapsByName'] = {}
  for (const map of mapsJson.data || []) {
    if (!map.displayName) continue
    mapsByName[map.displayName.toLowerCase()] = {
      splash: map.splash,
      listIcon: map.listViewIcon,
    }
  }

  const tierSets = tiersJson.data || []
  const currentTierSet = tierSets[tierSets.length - 1]
  const tiersByNumber: ValorantAssets['tiersByNumber'] = {}
  const tiersByName: ValorantAssets['tiersByName'] = {}
  for (const tier of currentTierSet?.tiers || []) {
    tiersByNumber[tier.tier] = { name: tier.tierName, icon: tier.largeIcon }
    if (tier.tierName) {
      tiersByName[normalizeTierName(tier.tierName)] = { number: tier.tier, icon: tier.largeIcon }
    }
  }

  return { agentsByName, agentsById, mapsByName, tiersByNumber, tiersByName }
}

export function getValorantAssets(): Promise<ValorantAssets> {
  if (!assetsPromise) {
    assetsPromise = loadAssets().catch((err) => {
      assetsPromise = null
      throw err
    })
  }
  return assetsPromise
}

export function getAgentIcon(assets: ValorantAssets | null, agentNameOrId?: string): string | undefined {
  if (!assets || !agentNameOrId) return undefined
  const key = agentNameOrId.toLowerCase()
  if (assets.agentsById[key]) return assets.agentsById[key].icon
  if (assets.agentsByName[key]) return assets.agentsByName[key].icon
  return undefined
}

export function getAgentName(assets: ValorantAssets | null, agentNameOrId?: string): string {
  if (!assets || !agentNameOrId) return agentNameOrId || 'Inconnu'
  const key = agentNameOrId.toLowerCase()
  if (assets.agentsById[key]) return assets.agentsById[key].name
  if (assets.agentsByName[key]) return assets.agentsByName[key].name
  return agentNameOrId
}

const DEFAULT_AGENT_EMOJIS: Record<string, string> = {
  jett: '💨',
  reyna: '👁️',
  raze: '💥',
  phoenix: '🚀',
  neon: '⚡',
  yoru: '🗡️',
  iso: '🔨',
  clove: '💧',
  omen: '🌀',
  viper: '🐍',
  brimstone: '🧪',
  astra: '🔮',
  harbor: '🌊',
  sova: '🏹',
  fade: '🎨',
  breach: '🛡️',
  skye: '🐺',
  'kay/o': '🤖',
  kayo: '🤖',
  gekko: '🪰',
  cypher: '🕵️',
  killjoy: '🔧',
  sage: '🧊',
  chamber: '👑',
  deadlock: '🩸',
  vyse: '🕷️',
}

export function getAgentFallbackEmoji(agentName?: string): string {
  if (!agentName) return '👤'
  const key = agentName.toLowerCase().trim()
  return DEFAULT_AGENT_EMOJIS[key] || '👤'
}

export function getMapImage(assets: ValorantAssets | null, mapName?: string): string | undefined {
  if (!assets || !mapName) return undefined
  return assets.mapsByName[mapName.toLowerCase()]?.splash
}

export function getTierIcon(
  assets: ValorantAssets | null,
  tierNumber?: number,
  tierName?: string,
): string | undefined {
  if (!assets) return undefined
  if (tierNumber && assets.tiersByNumber[tierNumber]) return assets.tiersByNumber[tierNumber].icon
  if (tierName) return assets.tiersByName[normalizeTierName(tierName)]?.icon
  return undefined
}
