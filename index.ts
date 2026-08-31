import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  TextChannel,
  Interaction,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import {
  getValorantAssets,
  getAgentIcon,
  getAgentName,
  getMapImage,
  getTierIcon,
  getAgentFallbackEmoji,
  ValorantAssets
} from './valorant-assets';

// Load environment variables from parent .env
dotenv.config({ path: path.join(__dirname, '../.env') });

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const VALORANT_API_KEY = process.env.VALORANT_API_KEY;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('[Bot] Error: DISCORD_TOKEN and DISCORD_CLIENT_ID must be specified in the .env file.');
  process.exit(1);
}

// Initialize Client
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// Initialize SQLite DB (support custom DATABASE_PATH for Coolify persistence)
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'tracker.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    tag TEXT NOT NULL,
    puuid TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_match_id TEXT,
    daily_start_rr INTEGER,
    daily_start_rank TEXT,
    daily_start_date TEXT,
    UNIQUE(name, tag, channel_id)
  );
`);

interface TrackedPlayer {
  id: number;
  name: string;
  tag: string;
  puuid: string;
  channel_id: string;
  last_match_id: string | null;
  daily_start_rr: number | null;
  daily_start_rank: string | null;
  daily_start_date: string | null;
}

// Cache of Valorant static assets
let assets: ValorantAssets | null = null;

async function loadValorantAssets() {
  try {
    assets = await getValorantAssets();
    console.log('[Bot] Loaded Valorant assets from valorant-api.com successfully.');
  } catch (err) {
    console.error('[Bot] Failed to load static assets:', err);
  }
}

// Helper to find a rank emoji in the bot's cache or application global emojis
// Will match names like "gold3", "gold_3" for a rank named "Gold 3"
function getRankEmoji(rankName: string): string {
  if (!rankName) return '';
  const cleanName = rankName.trim().toLowerCase();
  const normalized = cleanName.replace(/\s+/g, ''); // "gold3"
  const normalizedWithUnderscore = cleanName.replace(/\s+/g, '_'); // "gold_3"

  // Search in guild cache first
  let emoji: any = client.emojis.cache.find(e => {
    const name = e.name?.toLowerCase() || '';
    return name === normalized || name === normalizedWithUnderscore;
  });

  // Fallback to application global emojis cache
  if (!emoji && client.application) {
    emoji = client.application.emojis.cache.find(e => {
      const name = e.name?.toLowerCase() || '';
      return name === normalized || name === normalizedWithUnderscore;
    });
  }

  return emoji ? `${emoji.toString()} ` : '';
}

// HenrikDev API helper
async function fetchHenrikDev<T>(endpoint: string): Promise<T | null> {
  const headers: Record<string, string> = {
    'User-Agent': 'Valorant-Discord-Bot/1.0',
  };
  if (VALORANT_API_KEY) {
    headers['Authorization'] = VALORANT_API_KEY;
  }

  try {
    const res = await fetch(`https://api.henrikdev.xyz${endpoint}`, { headers });
    if (!res.ok) {
      console.error(`[API] HenrikDev Error on ${endpoint}:`, res.status, await res.text());
      return null;
    }
    return await res.json() as T;
  } catch (e) {
    console.error(`[API] Failed to fetch ${endpoint}:`, e);
    return null;
  }
}

// Convert rank and RR to absolute tier/elo for daily calculation
function getAbsoluteMMR(tierName: string, rr: number): number {
  const tiers = [
    'unrated', 'unknown 1', 'unknown 2',
    'iron 1', 'iron 2', 'iron 3',
    'bronze 1', 'bronze 2', 'bronze 3',
    'silver 1', 'silver 2', 'silver 3',
    'gold 1', 'gold 2', 'gold 3',
    'platinum 1', 'platinum 2', 'platinum 3',
    'diamond 1', 'diamond 2', 'diamond 3',
    'ascendant 1', 'ascendant 2', 'ascendant 3',
    'immortal 1', 'immortal 2', 'immortal 3',
    'radiant'
  ];

  const index = tiers.indexOf(tierName.trim().toLowerCase());
  if (index === -1) return 0;
  return (index * 100) + rr;
}

// Calculate KAST (Kills, Assists, Survived, Traded) for a player in a match
function calculateKAST(match: any, playerPuuid: string): string {
  try {
    const player = match.players?.find((p: any) => p.puuid === playerPuuid);
    if (!player) return 'N/A';

    const teamId = player.team_id;
    const totalRounds = match.rounds?.length ?? 0;
    if (totalRounds === 0) return '0.0%';

    let kastRounds = 0;

    for (let r = 0; r < totalRounds; r++) {
      // 1. Kill in this round?
      const roundStats = match.rounds[r]?.stats?.find((s: any) => s.player?.puuid === playerPuuid);
      const hasKill = roundStats && (roundStats.stats?.kills > 0);

      // 2. Assist in this round?
      const hasAssist = match.kills?.some((k: any) => 
        k.round === r && 
        k.assistants?.some((a: any) => a.puuid === playerPuuid)
      );

      // 3. Survived this round?
      const died = match.kills?.some((k: any) => 
        k.round === r && 
        k.victim?.puuid === playerPuuid
      );
      const survived = !died;

      // 4. Traded in this round?
      let traded = false;
      if (died) {
        const death = match.kills?.find((k: any) => 
          k.round === r && 
          k.victim?.puuid === playerPuuid
        );
        if (death) {
          const killerPuuid = death.killer?.puuid;
          const deathTime = death.time_in_round_in_ms;
          
          traded = match.kills?.some((k: any) => 
            k.round === r &&
            k.killer?.team === teamId &&
            k.killer?.puuid !== playerPuuid &&
            k.victim?.puuid === killerPuuid &&
            k.time_in_round_in_ms >= deathTime &&
            k.time_in_round_in_ms <= deathTime + 4000
          );
        }
      }

      if (hasKill || hasAssist || survived || traded) {
        kastRounds++;
      }
    }

    const percentage = (kastRounds / totalRounds) * 100;
    return `${percentage.toFixed(1)}%`;
  } catch (e) {
    console.error('[Bot] Error calculating KAST:', e);
    return 'N/A';
  }
}

// Helper to find an agent emoji in discord cache or fallback
function getAgentEmoji(agentName: string): string {
  if (!agentName) return '👤 ';
  const cleanName = agentName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

  let emoji: any = client.emojis.cache.find(e => {
    const name = e.name?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
    return name === cleanName;
  });

  if (!emoji && client.application) {
    emoji = client.application.emojis.cache.find(e => {
      const name = e.name?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
      return name === cleanName;
    });
  }

  return emoji ? (emoji.toString() + ' ') : (getAgentFallbackEmoji(agentName) + ' ');
}

interface LeaderboardFieldsResult {
  ownTeamTitle: string;
  ownTeamValue: string;
  enemyTeamTitle: string;
  enemyTeamValue: string;
}

// Build 10-player leaderboard split into 2 team sections while keeping overall 1-10 match ranking numbers
function buildMatchLeaderboardFields(match: any, trackedPuuid?: string): LeaderboardFieldsResult | null {
  try {
    if (!match || !match.players || match.players.length === 0) return null;

    const teamRedObj = match.teams?.find((t: any) => t.team_id === 'Red');
    const teamBlueObj = match.teams?.find((t: any) => t.team_id === 'Blue');

    const roundsRed = teamRedObj?.rounds?.won ?? 0;
    const roundsBlue = teamBlueObj?.rounds?.won ?? 0;

    const totalRounds = (match.rounds?.length && match.rounds.length > 0) ? match.rounds.length : (roundsRed + roundsBlue);

    // Process all players and calculate ACS
    const processedPlayers = match.players.map((p: any) => {
      const name = p.name || 'Joueur';
      const tag = p.tag || '';
      const fullName = tag ? (name + '#' + tag) : name;
      const teamId = p.team_id || 'Red';
      const agentRaw = p.agent?.name || p.agent?.id || (typeof p.agent === 'string' ? p.agent : '');
      const agentName = getAgentName(assets, agentRaw);
      const kills = p.stats?.kills ?? 0;
      const deaths = p.stats?.deaths ?? 0;
      const assists = p.stats?.assists ?? 0;
      const score = p.stats?.score ?? 0;
      const acs = totalRounds > 0 ? Math.round(score / totalRounds) : score;

      return {
        puuid: p.puuid,
        name,
        tag,
        fullName,
        teamId,
        partyId: p.party_id,
        agentName,
        kills,
        deaths,
        assists,
        score,
        acs,
        kda: (kills + '/' + deaths + '/' + assists)
      };
    });

    // Sort ALL players by ACS descending (overall match ranking 1 to 10)
    processedPlayers.sort((a: any, b: any) => {
      if (b.acs !== a.acs) return b.acs - a.acs;
      return b.kills - a.kills;
    });

    const trackedPlayerObj = trackedPuuid ? processedPlayers.find((p: any) => p.puuid === trackedPuuid) : null;
    const trackedPartyId = trackedPlayerObj?.partyId;

    // Determine own team vs enemy team
    const trackedTeamId = trackedPlayerObj?.teamId || 'Red';
    const ownTeamId = trackedTeamId;
    const enemyTeamId = ownTeamId === 'Red' ? 'Blue' : 'Red';

    const ownTeamScore = ownTeamId === 'Red' ? roundsRed : roundsBlue;
    const enemyTeamScore = enemyTeamId === 'Red' ? roundsRed : roundsBlue;

    const ownTeamIcon = ownTeamId === 'Red' ? '🔴' : '🔵';
    const enemyTeamIcon = enemyTeamId === 'Red' ? '🔴' : '🔵';

    const ownTeamName = ownTeamId === 'Red' ? 'Équipe Rouge' : 'Équipe Bleue';
    const enemyTeamName = enemyTeamId === 'Red' ? 'Équipe Rouge' : 'Équipe Bleue';

    const ownTeamLines: string[] = [];
    const enemyTeamLines: string[] = [];

    for (let i = 0; i < processedPlayers.length; i++) {
      const p = processedPlayers[i];
      const overallRankNum = i + 1;
      const agentEmojiStr = getAgentEmoji(p.agentName);

      const isMainTracked = trackedPuuid && p.puuid === trackedPuuid;
      const isPartyMate = trackedPartyId && p.partyId === trackedPartyId;
      const isHighlighted = isMainTracked || isPartyMate;

      const isolatedName = '\u2066' + p.fullName + '\u2069';
      const nameDisplay = isHighlighted ? ('**' + isolatedName + '**') : isolatedName;
      const line = '\u200E' + overallRankNum + '\\. ' + agentEmojiStr + nameDisplay + ' • **' + p.acs + '** ACS • `' + p.kda + '`';

      if (p.teamId === ownTeamId) {
        ownTeamLines.push(line);
      } else {
        enemyTeamLines.push(line);
      }
    }

    return {
      ownTeamTitle: ownTeamIcon + ' ' + ownTeamName + ' (' + ownTeamScore + ')',
      ownTeamValue: ownTeamLines.join('\n') || 'Aucun joueur',
      enemyTeamTitle: enemyTeamIcon + ' ' + enemyTeamName + ' (' + enemyTeamScore + ')',
      enemyTeamValue: enemyTeamLines.join('\n') || 'Aucun joueur'
    };
  } catch (e) {
    console.error('[Bot] Error building match leaderboard fields:', e);
    return null;
  }
}

// Format Discord Embed for match results
async function sendMatchNotification(player: TrackedPlayer, match: any, mmr: any, isCompact: boolean = false) {
  try {
    const channel = await client.channels.fetch(player.channel_id) as TextChannel;
    if (!channel || !channel.isTextBased()) return;

    const matchId = match.metadata.match_id;
    const mapName = match.metadata.map.name;
    const gameStart = new Date(match.metadata.started_at);

    // Find player in the match
    const playerData = match.players.find((p: any) => p.puuid === player.puuid || (p.name.toLowerCase() === player.name.toLowerCase() && p.tag.toLowerCase() === player.tag.toLowerCase()));
    if (!playerData) return;

    const playerTeamId = playerData.team_id;
    const teamRed = match.teams.find((t: any) => t.team_id === 'Red');
    const teamBlue = match.teams.find((t: any) => t.team_id === 'Blue');

    const roundsRed = teamRed?.rounds?.won ?? 0;
    const roundsBlue = teamBlue?.rounds?.won ?? 0;

    const isRed = playerTeamId === 'Red';
    const playerScore = isRed ? `${roundsRed}-${roundsBlue}` : `${roundsBlue}-${roundsRed}`;

    const kda = `${playerData.stats.kills}/${playerData.stats.deaths}/${playerData.stats.assists}`;
    const agentName = getAgentName(assets, playerData.agent.name || playerData.agent.id);
    const agentIcon = getAgentIcon(assets, playerData.agent.id || playerData.agent.name) || '';

    const rrChange = mmr.mmr_change_to_last_game ?? 0;
    const currentRR = mmr.ranking_in_tier ?? 0;
    const currentRank = mmr.currenttierpatched ?? 'Non classé';
    const currentTierId = mmr.currenttier ?? 0;
    const tierIcon = getTierIcon(assets, currentTierId) || 'https://valotracker.sitpi.pro/favicon.ico';

    const isDraw = roundsRed === roundsBlue;
    const won = isDraw ? false : (isRed ? teamRed?.won : teamBlue?.won);

    let color = 0x808080; // Gris pour Égalité
    let winStatusText = 'Égalité';
    if (!isDraw) {
      color = won ? 0x00FF00 : 0xFF0000;
      winStatusText = won ? 'Victoire' : 'Défaite';
    }

    // KAST, ACS, and Party grouping extraction
    const kast = calculateKAST(match, playerData.puuid);
    const totalRounds = roundsRed + roundsBlue;
    const acs = totalRounds > 0 ? Math.round((playerData.stats?.score || 0) / totalRounds) : 0;

    const myPartyId = playerData.party_id;
    const partyTeammates = myPartyId && match.players
      ? match.players.filter((p: any) => p.party_id === myPartyId && p.puuid !== playerData.puuid)
      : [];
    const partySize = partyTeammates.length + 1;
    
    let groupFieldName = '';
    let groupFieldValue = '';
    
    if (partySize > 1) {
      groupFieldName = partySize === 2 ? 'Duo' : (partySize === 3 ? 'Trio' : (partySize === 5 ? '5-Stack' : `Groupe de ${partySize}`));
      groupFieldValue = partyTeammates.map((p: any) => {
        const rankName = p.tier?.name || 'Non classé';
        const mateEmoji = getRankEmoji(rankName);
        const mateName = '\u2066' + p.name + '#' + p.tag + '\u2069';
        return mateEmoji ? (`\u200E${mateEmoji.trim()} ` + mateName) : (`\u200E` + mateName + ` (${rankName})`);
      }).join('\n');
    }

    // MVP check
    const myScore = playerData.stats?.score || 0;
    const highestMatchScore = Math.max(...match.players.map((p: any) => p.stats?.score || 0));
    const isMatchMvp = myScore === highestMatchScore && myScore > 0;

    const ownTeamPlayers = match.players.filter((p: any) => p.team_id === playerTeamId);
    const highestTeamScore = Math.max(...ownTeamPlayers.map((p: any) => p.stats?.score || 0));
    const isTeamMvp = myScore === highestTeamScore && myScore > 0;

    let mvpTitleSuffix = '';
    if (isMatchMvp) {
      mvpTitleSuffix = ' • 🏅 MVP';
    } else if (isTeamMvp) {
      mvpTitleSuffix = ' • 🥈 MVP Équipe';
    }

    // RR description builder
    const rrText = rrChange >= 0 ? `+${rrChange} RR` : `${rrChange} RR`;
    const userRankEmoji = getRankEmoji(currentRank);
    let description = `**${rrText}** (${userRankEmoji}${currentRank} • ${currentRR} RR)`;

    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${player.name}#${player.tag}`,
        iconURL: tierIcon
      })
      .setTitle(`${winStatusText} (${playerScore})${mvpTitleSuffix}`)
      .setDescription(description)
      .setColor(color)
      .addFields(
        { name: 'KDA', value: `\`${kda}\``, inline: true },
        { name: 'KAST', value: `\`${kast}\``, inline: true },
        { name: 'ACS', value: `\`${acs}\``, inline: true }
      )
      .setFooter({ text: mapName })
      .setTimestamp(gameStart);
      
    if (!isCompact) {
      const leaderboardFields = buildMatchLeaderboardFields(match, playerData.puuid);
      if (leaderboardFields) {
        embed.addFields(
          { name: leaderboardFields.ownTeamTitle, value: leaderboardFields.ownTeamValue, inline: false },
          { name: leaderboardFields.enemyTeamTitle, value: leaderboardFields.enemyTeamValue, inline: false }
        );
      }

      if (groupFieldName && groupFieldValue) {
        embed.addFields({ name: groupFieldName, value: groupFieldValue, inline: false });
      }
    }

    if (agentIcon) {
      embed.setThumbnail(agentIcon);
    }

    // Button to go to the website
    const button = new ButtonBuilder()
      .setLabel('Détails du match')
      .setURL(`https://valotracker.sitpi.pro/match/${encodeURIComponent(matchId)}?player=${encodeURIComponent(player.name + '#' + player.tag)}`)
      .setStyle(ButtonStyle.Link);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    await channel.send({ embeds: [embed], components: [row] });
    console.log(`[Bot] Sent match result notification for ${player.name}#${player.tag} in channel ${player.channel_id}`);
  } catch (err) {
    console.error(`[Bot] Failed to send match notification for ${player.name}:`, err);
  }
}

// Poll matches for tracked players with match grouping
async function pollPlayersMatches() {
  const players = db.prepare('SELECT * FROM tracked_players').all() as TrackedPlayer[];
  if (players.length === 0) return;
  console.log(`[Bot] Polling match history for ${players.length} players...`);

  // Step 1: Discover new matches for all players
  const newMatchGroups = new Map<string, Array<{ player: TrackedPlayer; latestMmr: any }>>();

  for (const player of players) {
    try {
      const mmrUrl = `/valorant/v1/mmr-history/eu/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}`;
      const mmrHistory = await fetchHenrikDev<any>(mmrUrl);
      if (!mmrHistory || !mmrHistory.data || mmrHistory.data.length === 0) continue;

      const latestMmr = mmrHistory.data[0];
      const latestMatchId = latestMmr.match_id;

      if (!player.last_match_id) {
        db.prepare('UPDATE tracked_players SET last_match_id = ? WHERE id = ?')
          .run(latestMatchId, player.id);

        if (player.daily_start_rr === null) {
          const todayStr = new Date().toISOString().split('T')[0];
          db.prepare('UPDATE tracked_players SET daily_start_rr = ?, daily_start_rank = ?, daily_start_date = ? WHERE id = ?')
            .run(latestMmr.ranking_in_tier, latestMmr.currenttierpatched, todayStr, player.id);
        }
        continue;
      }

      if (latestMatchId !== player.last_match_id) {
        const key = `${player.channel_id}_${latestMatchId}`;
        if (!newMatchGroups.has(key)) {
          newMatchGroups.set(key, []);
        }
        newMatchGroups.get(key)!.push({ player, latestMmr });
      }
    } catch (e) {
      console.error(`[Bot] Error polling player ${player.name}#${player.tag}:`, e);
    }

    await new Promise(res => setTimeout(res, 1500));
  }

  // Step 2: Process new matches per channel group
  for (const [key, group] of newMatchGroups.entries()) {
    if (group.length === 0) continue;

    const firstItem = group[0];
    const matchId = firstItem.latestMmr.match_id;
    const samplePlayer = firstItem.player;

    try {
      const matchUrl = `/valorant/v4/matches/eu/pc/${encodeURIComponent(samplePlayer.name)}/${encodeURIComponent(samplePlayer.tag)}?size=1`;
      const matchData = await fetchHenrikDev<any>(matchUrl);

      if (matchData && matchData.data && matchData.data.length > 0) {
        const match = matchData.data[0];
        const isComp = match.metadata?.queue?.name?.toLowerCase() === 'competitive';

        if (isComp) {
          for (let i = 0; i < group.length; i++) {
            const { player, latestMmr } = group[i];
            const isCompact = i > 0;
            await sendMatchNotification(player, match, latestMmr, isCompact);
            await new Promise(res => setTimeout(res, 500));
          }
        }

        for (const { player } of group) {
          db.prepare('UPDATE tracked_players SET last_match_id = ? WHERE id = ?')
            .run(matchId, player.id);
        }
      }
    } catch (e) {
      console.error(`[Bot] Error processing match group ${key}:`, e);
    }
  }
}

// Generate and send daily summary
async function sendDailySummaries() {
  const players = db.prepare('SELECT * FROM tracked_players').all() as TrackedPlayer[];
  if (players.length === 0) return;

  // Group players by channel ID
  const channelGroups: Record<string, TrackedPlayer[]> = {};
  for (const player of players) {
    if (!channelGroups[player.channel_id]) {
      channelGroups[player.channel_id] = [];
    }
    channelGroups[player.channel_id].push(player);
  }

  const todayStr = new Date().toISOString().split('T')[0];

  for (const [channelId, channelPlayers] of Object.entries(channelGroups)) {
    try {
      const channel = await client.channels.fetch(channelId) as TextChannel;
      if (!channel || !channel.isTextBased()) continue;

      let summaryLines: string[] = [];

      for (const player of channelPlayers) {
        // Fetch latest MMR stats
        const mmrUrl = `/valorant/v1/mmr-history/eu/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}`;
        const mmrHistory = await fetchHenrikDev<any>(mmrUrl);

        if (!mmrHistory || !mmrHistory.data || mmrHistory.data.length === 0) continue;
        const latestMmr = mmrHistory.data[0];

        const startRank = player.daily_start_rank || latestMmr.currenttierpatched || 'Non classé';
        const startRR = player.daily_start_rr ?? latestMmr.ranking_in_tier ?? 0;

        const currentRank = latestMmr.currenttierpatched || 'Non classé';
        const currentRR = latestMmr.ranking_in_tier ?? 0;

        // Calculate delta absolute MMR
        const startAbs = getAbsoluteMMR(startRank, startRR);
        const currentAbs = getAbsoluteMMR(currentRank, currentRR);
        const delta = currentAbs - startAbs;

        const deltaSign = delta >= 0 ? `+${delta}` : `${delta}`;

        // Get Wins & Losses in the last 24 hours
        let wins = 0;
        let losses = 0;
        const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

        for (const item of mmrHistory.data) {
          const matchDate = new Date(item.date).getTime();
          if (matchDate < oneDayAgo) break;

          if (item.mmr_change_to_last_game > 0) {
            wins++;
          } else if (item.mmr_change_to_last_game < 0) {
            losses++;
          }
        }

        const totalGames = wins + losses;
        const winrate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;

        if (totalGames > 0) {
          summaryLines.push(
            `**${player.name} : ${deltaSign}**`,
            `${wins}W ${losses}L (${winrate}%) | ${startRank} ${startRR}rr -> ${currentRank} ${currentRR}rr\n`
          );
        }

        // Update database with today's final stats as the start stats for tomorrow
        db.prepare('UPDATE tracked_players SET daily_start_rr = ?, daily_start_rank = ?, daily_start_date = ? WHERE id = ?')
          .run(currentRR, currentRank, todayStr, player.id);
      }

      if (summaryLines.length > 0) {
        const embed = new EmbedBuilder()
          .setTitle("Résumé de la veille")
          .setDescription(summaryLines.join('\n'))
          .setColor(0xE91E63) // Pink accent bar
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log(`[Bot] Posted Yesterday's Summary in channel ${channelId}`);
      }
    } catch (err) {
      console.error(`[Bot] Failed to send daily summary in channel ${channelId}:`, err);
    }
  }
}

// Slash command registration utility
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('track')
      .setDescription('Suivre un joueur Valorant dans ce salon')
      .addStringOption(opt => opt.setName('name').setDescription('Nom de jeu Valorant').setRequired(true))
      .addStringOption(opt => opt.setName('tag').setDescription('Tagline Valorant (sans #)').setRequired(true))
      .addChannelOption(opt => opt.setName('channel').setDescription('Salon pour les notifications (optionnel)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('untrack')
      .setDescription('Arrêter de suivre un joueur Valorant')
      .addStringOption(opt => opt.setName('name').setDescription('Nom de jeu Valorant').setRequired(true))
      .addStringOption(opt => opt.setName('tag').setDescription('Tagline Valorant (sans #)').setRequired(true)),
    new SlashCommandBuilder()
      .setName('list-tracked')
      .setDescription('Liste de tous les joueurs suivis sur ce serveur'),
new SlashCommandBuilder()
      .setName('setup-emojis')
      .setDescription('Téléverse automatiquement les émojis de rangs et d\'agents Valorant sur l\'application du bot'),
    new SlashCommandBuilder()
      .setName('preview')
      .setDescription('Génère un exemple de récapitulatif de fin de match')
      .addStringOption(opt =>
        opt.setName('resultat')
          .setDescription('Résultat du match (win ou loss)')
          .addChoices(
            { name: 'Victoire', value: 'win' },
            { name: 'Défaite', value: 'loss' }
          )
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('groupe')
          .setDescription('Taille du groupe (duo ou trio)')
          .addChoices(
            { name: 'Duo', value: 'duo' },
            { name: 'Trio', value: 'trio' }
          )
          .setRequired(false)
      )
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

  try {
    console.log('[Bot] Registering application slash commands...');
    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID!),
      { body: commands }
    );
    console.log('[Bot] Slash commands registered successfully.');
  } catch (err) {
    console.error('[Bot] Failed to register slash commands:', err);
  }
}

// Client Handlers
client.once('ready', async () => {
  console.log(`[Bot] Logged in as ${client.user?.tag}`);
  client.user?.setActivity('les parties de compète', { type: ActivityType.Watching });

  await loadValorantAssets();

  // Fetch existing global application emojis into cache
  try {
    await client.application?.emojis.fetch();
    console.log(`[Bot] Loaded ${client.application?.emojis.cache.size || 0} application emojis.`);
  } catch (err) {
    console.error('[Bot] Failed to fetch application emojis:', err);
  }

  await registerCommands();

  // Start matches polling loop (Every 2 minutes)
  pollPlayersMatches(); // initial run
  setInterval(pollPlayersMatches, 2 * 60 * 1000);

  // Schedule Daily Summary at 10:00 AM every day
  cron.schedule('0 10 * * *', () => {
    console.log('[Scheduler] Running scheduled Daily Summary...');
    sendDailySummaries();
  });
});

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'setup-emojis') {
    // Check permissions (Must be owner/admin of application or guild expression manager)
    const member = interaction.member as any;
    if (!member.permissions.has('ManageGuildExpressions') && !member.permissions.has('Administrator')) {
      await interaction.reply({ content: 'Vous devez avoir la permission d\'administrateur ou de gérer les expressions pour lancer cette commande.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      if (!assets || !assets.tiersByNumber) {
        await interaction.editReply('Les ressources Valorant ne sont pas chargées. Réessayez dans quelques secondes.');
        return;
      }

      if (!client.application) {
        await interaction.editReply('Impossible d\'accéder aux données d\'application du bot.');
        return;
      }

      let count = 0;
      let skipped = 0;

      // Force fetch to ensure fresh cache
      await client.application.emojis.fetch();

      // Fetch all tiers (Iron 1 (3) to Radiant (27))
      for (const [tierIdStr, tierInfo] of Object.entries(assets.tiersByNumber)) {
        const tierId = parseInt(tierIdStr, 10);
        // Exclude unrated (0), unknown (1, 2)
        if (tierId < 3 || tierId > 27) continue;

        const rawName = tierInfo.name;
        if (!rawName) continue;

        // Normalize name: "Gold 3" -> "gold3"
        const emojiName = rawName.replace(/\s+/g, '').toLowerCase();

        // Check if already exists in the application emojis cache
        const existing = client.application.emojis.cache.find(e => e.name?.toLowerCase() === emojiName);
        if (existing) {
          skipped++;
          continue;
        }

        try {
          await client.application.emojis.create({
            attachment: tierInfo.icon,
            name: emojiName
          });
          count++;
          // Be gentle with Discord rate limits
          await new Promise(res => setTimeout(res, 1000));
        } catch (err) {
          console.error(`Failed to create application emoji ${emojiName}:`, err);
        }
      }

      // Fetch all agents and upload their icons as application emojis
      if (assets && assets.agentsByName) {
        for (const [rawAgentKey, agentInfo] of Object.entries(assets.agentsByName)) {
          if (!agentInfo.icon || !agentInfo.name) continue;

          // Normalize agent name: "KAY/O" -> "kayo", "Jett" -> "jett"
          const emojiName = agentInfo.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          if (!emojiName) continue;

          const existing = client.application.emojis.cache.find(e => e.name?.toLowerCase() === emojiName);
          if (existing) {
            skipped++;
            continue;
          }

          try {
            await client.application.emojis.create({
              attachment: agentInfo.icon,
              name: emojiName
            });
            count++;
            // Be gentle with Discord rate limits
            await new Promise(res => setTimeout(res, 1000));
          } catch (err) {
            console.error(`Failed to create application emoji for agent ${emojiName}:`, err);
          }
        }
      }

      await interaction.editReply(`Configuration des émojis d'application terminée !\n✅ **${count}** émojis créés.\n⏭️ **${skipped}** émojis déjà existants (passés).`);
    } catch (e) {
      console.error('[Bot] Setup emojis error:', e);
      await interaction.editReply('Une erreur est survenue lors de la création des émojis.');
    }
  }

  if (commandName === 'preview') {
    await interaction.deferReply();
    try {
      const mockTierIcon = getTierIcon(assets, 14) || 'https://valotracker.sitpi.pro/favicon.ico';
      const mockAgentIcon = getAgentIcon(assets, 'jett') || '';
      const agentName = getAgentName(assets, 'jett');

      const optResultat = interaction.options.getString('resultat') || 'win';
      const optGroupe = interaction.options.getString('groupe') || 'duo';

      const mockEmoji = getRankEmoji('Gold 3'); 
      const mockMateEmoji = getRankEmoji('Silver 2');
      const mockMate2Emoji = getRankEmoji('Bronze 3');

      // 1. Result fields mapping
      let title = '';
      let color = 0x00FF00;
      let rrChangeText = '';
      let rankDetails = '';
      if (optResultat === 'loss') {
        title = 'Défaite (5-13) • 🥈 MVP Équipe';
        color = 0xFF0000;
        rrChangeText = '**-12 RR**';
        rankDetails = 'Or 3 • 50 RR';
      } else {
        title = 'Victoire (13-5) • 🏅 MVP';
        color = 0x00FF00;
        rrChangeText = '**+22 RR**';
        rankDetails = 'Or 3 • 62 RR';
      }
      
      const userRankDisplay = mockEmoji 
        ? `${rrChangeText} (${mockEmoji.trim()} ${rankDetails})` 
        : `${rrChangeText} (${rankDetails})`;

      // 2. Teammates group formatting
      let groupFieldName = '';
      let groupFieldValue = '';
      const mate1Disp = mockMateEmoji ? mockMateEmoji.trim() : 'Argent 2';
      const mate2Disp = mockMate2Emoji ? mockMate2Emoji.trim() : 'Bronze 3';

      if (optGroupe === 'duo') {
        groupFieldName = 'Duo';
        groupFieldValue = mockMateEmoji ? `${mate1Disp} malstrom#EUW` : 'malstrom#EUW (Argent 2)';
      } else if (optGroupe === 'trio') {
        groupFieldName = 'Trio';
        const disp1 = mockMateEmoji ? `${mate1Disp} malstrom#EUW` : 'malstrom#EUW (Argent 2)';
        const disp2 = mockMate2Emoji ? `${mate2Disp} teammate2#EUW` : 'teammate2#EUW (Bronze 3)';
        groupFieldValue = `${disp1}\n${disp2}`;
      }

      const embed = new EmbedBuilder()
        .setAuthor({ 
          name: `Sitpi#EUW`, 
          iconURL: mockTierIcon
        })
        .setTitle(title)
        .setDescription(userRankDisplay)
        .setColor(color)
        .addFields(
          { name: 'KDA', value: optResultat === 'loss' ? '`12/15/4`' : '`24/11/5`', inline: true },
          { name: 'KAST', value: optResultat === 'loss' ? '`65.0%`' : '`83.3%`', inline: true },
          { name: 'ACS', value: optResultat === 'loss' ? '`165`' : '`285`', inline: true }
        )
        .setFooter({ text: 'Ascent' })
        .setTimestamp(new Date());

      // Mock match for 10-player leaderboard preview
      const isWin = optResultat !== 'loss';
      const mockMatch: any = {
        teams: [
          { team_id: 'Red', rounds: { won: isWin ? 13 : 5 } },
          { team_id: 'Blue', rounds: { won: isWin ? 5 : 13 } }
        ],
        players: [
          {
            puuid: 'main-tracked-puuid', name: 'Sitpi', tag: 'EUW', team_id: 'Red', party_id: 'party-group-1',
            agent: { name: 'Jett' }, stats: { score: isWin ? 5130 : 2970, kills: isWin ? 24 : 12, deaths: isWin ? 11 : 15, assists: isWin ? 5 : 4 }
          },
          {
            puuid: 'p2', name: 'EnemyMVP', tag: 'EUW', team_id: 'Blue', party_id: 'enemy-party-1',
            agent: { name: 'Reyna' }, stats: { score: 4500, kills: 22, deaths: 13, assists: 3 }
          },
          {
            puuid: 'p3', name: 'malstrom', tag: 'EUW', team_id: 'Red', party_id: 'party-group-1',
            agent: { name: 'Omen' }, stats: { score: 3780, kills: 16, deaths: 12, assists: 8 }
          },
          ...(optGroupe === 'trio' ? [{
            puuid: 'p4', name: 'teammate2', tag: 'EUW', team_id: 'Red', party_id: 'party-group-1',
            agent: { name: 'Sova' }, stats: { score: 3240, kills: 13, deaths: 14, assists: 6 }
          }] : [{
            puuid: 'p4', name: 'Ally3', tag: 'EUW', team_id: 'Red', party_id: 'solo-red-1',
            agent: { name: 'Brimstone' }, stats: { score: 3240, kills: 13, deaths: 14, assists: 6 }
          }]),
          {
            puuid: 'p5', name: 'Enemy2', tag: 'EUW', team_id: 'Blue', party_id: 'enemy-party-1',
            agent: { name: 'Neon' }, stats: { score: 3060, kills: 14, deaths: 13, assists: 4 }
          },
          {
            puuid: 'p6', name: 'Ally4', tag: 'EUW', team_id: 'Red', party_id: 'solo-red-2',
            agent: { name: 'Killjoy' }, stats: { score: 2700, kills: 11, deaths: 15, assists: 5 }
          },
          {
            puuid: 'p7', name: 'Enemy3', tag: 'EUW', team_id: 'Blue', party_id: 'solo-blue-1',
            agent: { name: 'Clove' }, stats: { score: 2520, kills: 10, deaths: 16, assists: 7 }
          },
          {
            puuid: 'p8', name: 'Enemy4', tag: 'EUW', team_id: 'Blue', party_id: 'solo-blue-2',
            agent: { name: 'Cypher' }, stats: { score: 2160, kills: 9, deaths: 15, assists: 3 }
          },
          {
            puuid: 'p9', name: 'Ally5', tag: 'EUW', team_id: 'Red', party_id: 'solo-red-3',
            agent: { name: 'Fade' }, stats: { score: 1980, kills: 8, deaths: 16, assists: 6 }
          },
          {
            puuid: 'p10', name: 'Enemy5', tag: 'EUW', team_id: 'Blue', party_id: 'solo-blue-3',
            agent: { name: 'Viper' }, stats: { score: 1800, kills: 7, deaths: 17, assists: 4 }
          }
        ]
      };

      const previewFields = buildMatchLeaderboardFields(mockMatch, 'main-tracked-puuid');
      if (previewFields) {
        embed.addFields(
          { name: previewFields.ownTeamTitle, value: previewFields.ownTeamValue, inline: false },
          { name: previewFields.enemyTeamTitle, value: previewFields.enemyTeamValue, inline: false }
        );
      }

      if (groupFieldName && groupFieldValue) {
        embed.addFields({ name: groupFieldName, value: groupFieldValue, inline: false });
      }

      if (mockAgentIcon) {
        embed.setThumbnail(mockAgentIcon);
      }

      const button = new ButtonBuilder()
        .setLabel('Détails du match')
        .setURL('https://valotracker.sitpi.pro/match/0de43634-c682-4f47-ab04-07357081a906?player=Sitpi%23EUW')
        .setStyle(ButtonStyle.Link);
        
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

      await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
      console.error('[Bot] Preview command error:', e);
      await interaction.editReply('Une erreur est survenue lors de la génération de l\'aperçu.');
    }
  }

  if (commandName === 'track') {
    await interaction.deferReply();
    const name = interaction.options.getString('name')!.trim();
    const tag = interaction.options.getString('tag')!.trim().replace('#', '');
    const channel = (interaction.options.getChannel('channel') || interaction.channel) as any;

    if (!channel || (typeof channel.isTextBased === 'function' && !channel.isTextBased())) {
      await interaction.editReply('Erreur : Le salon sélectionné n\'est pas un salon textuel valide.');
      return;
    }

    try {
      // Validate with API
      const accUrl = `/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;
      const accountData = await fetchHenrikDev<any>(accUrl);

      if (!accountData || !accountData.data || !accountData.data.puuid) {
        await interaction.editReply(`Impossible de trouver le joueur Valorant \`${name}#${tag}\`. Veuillez vérifier le nom et le tag.`);
        return;
      }

      const puuid = accountData.data.puuid;
      const verifiedName = accountData.data.name;
      const verifiedTag = accountData.data.tag;

      // Insert into SQLite
      const query = db.prepare(`
        INSERT OR REPLACE INTO tracked_players (name, tag, puuid, channel_id, last_match_id) 
        VALUES (?, ?, ?, ?, NULL)
      `);
      query.run(verifiedName, verifiedTag, puuid, channel.id);

      await interaction.editReply(`Le suivi des matchs compétitifs de **${verifiedName}#${verifiedTag}** est activé dans <#${channel.id}> !`);
    } catch (e) {
      console.error('[Bot] Track command error:', e);
      await interaction.editReply('Une erreur est survenue lors de l\'ajout du joueur.');
    }
  }

  if (commandName === 'untrack') {
    const name = interaction.options.getString('name')!.trim();
    const tag = interaction.options.getString('tag')!.trim().replace('#', '');

    try {
      const info = db.prepare('DELETE FROM tracked_players WHERE name = ? COLLATE NOCASE AND tag = ? COLLATE NOCASE')
        .run(name, tag);

      if (info.changes > 0) {
        await interaction.reply(`Le suivi compétitif de **${name}#${tag}** a été arrêté.`);
      } else {
        await interaction.reply(`Le joueur **${name}#${tag}** n'était pas suivi.`);
      }
    } catch (e) {
      console.error('[Bot] Untrack command error:', e);
      await interaction.reply('Une erreur est survenue.');
    }
  }

  if (commandName === 'list-tracked') {
    try {
      const players = db.prepare('SELECT * FROM tracked_players').all() as TrackedPlayer[];
      if (players.length === 0) {
        await interaction.reply('Aucun joueur n\'est actuellement suivi.');
        return;
      }

      const list = players.map(p => `- **${p.name}#${p.tag}** dans le salon <#${p.channel_id}>`).join('\n');
      await interaction.reply(`**Joueurs suivis :**\n${list}`);
    } catch (e) {
      console.error('[Bot] List command error:', e);
      await interaction.reply('Une erreur est survenue.');
    }
  }
});

client.login(DISCORD_TOKEN);
