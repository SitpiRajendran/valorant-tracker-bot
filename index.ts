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

// Format Discord Embed for match results
async function sendMatchNotification(player: TrackedPlayer, match: any, mmr: any) {
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
    let outcomeEmoji = '⚖️';
    if (!isDraw) {
      color = won ? 0x00FF00 : 0xFF0000;
      winStatusText = won ? 'Victoire' : 'Défaite';
      outcomeEmoji = won ? '🏆' : '💀';
    }

    // KAST, ACS, and Party grouping extraction
    const kast = playerData.stats?.kast !== undefined ? `${playerData.stats.kast}%` : 'N/A';
    const totalRounds = roundsRed + roundsBlue;
    const acs = totalRounds > 0 ? Math.round((playerData.stats?.score || 0) / totalRounds) : 0;

    const myPartyId = playerData.party_id;
    const partyTeammates = myPartyId && match.players
      ? match.players.filter((p: any) => p.party_id === myPartyId && p.puuid !== playerData.puuid)
      : [];
    const partySize = partyTeammates.length + 1;
    let groupText = 'Solo';
    if (partySize > 1) {
      const label = partySize === 2 ? 'Duo' : (partySize === 3 ? 'Trio' : (partySize === 5 ? '5-Stack' : `Groupe de ${partySize}`));
      const teammatesNames = partyTeammates.map((p: any) => {
        const rankName = p.currenttier_patched || 'Non classé';
        const mateEmoji = getRankEmoji(rankName);
        return mateEmoji ? `${p.name}#${p.tag} ${mateEmoji.trim()}` : `${p.name}#${p.tag} (${rankName})`;
      }).join(', ');
      groupText = `${label} (avec ${teammatesNames})`;
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
      mvpTitleSuffix = ' • 🥈 MVP';
    }

    // RR description builder
    const rrText = rrChange >= 0 ? `+${rrChange} RR` : `${rrChange} RR`;
    const userRankEmoji = getRankEmoji(currentRank);
    let description = `${userRankEmoji}**${currentRank}** • **${currentRR} RR** (\`${rrText}\`)`;

    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${player.name}#${player.tag}`,
        iconURL: tierIcon
      })
      .setTitle(`${outcomeEmoji} ${winStatusText} (${playerScore})${mvpTitleSuffix}`)
      .setDescription(description)
      .setColor(color)
      .addFields(
        { name: 'KDA', value: `\`${kda}\``, inline: true },
        { name: 'KAST', value: `\`${kast}\``, inline: true },
        { name: 'ACS', value: `\`${acs}\``, inline: true },
        { name: 'Groupe', value: `👥 ${groupText}`, inline: false }
      )
      .setFooter({ text: mapName })
      .setTimestamp(gameStart);

    if (agentIcon) {
      embed.setThumbnail(agentIcon);
    }

    // Button to go to the website
    const button = new ButtonBuilder()
      .setLabel('Détails du match')
      .setURL(`https://valotracker.sitpi.pro/player/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}`)
      .setStyle(ButtonStyle.Link);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    await channel.send({ embeds: [embed], components: [row] });
    console.log(`[Bot] Sent match result notification for ${player.name}#${player.tag} in channel ${player.channel_id}`);
  } catch (err) {
    console.error(`[Bot] Failed to send match notification for ${player.name}:`, err);
  }
}

// Poll matches for tracked players
async function pollPlayersMatches() {
  const players = db.prepare('SELECT * FROM tracked_players').all() as TrackedPlayer[];
  console.log(`[Bot] Polling match history for ${players.length} players...`);

  for (const player of players) {
    try {
      // Get MMR history (Competitive games only)
      const mmrUrl = `/valorant/v1/mmr-history/eu/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}`;
      const mmrHistory = await fetchHenrikDev<any>(mmrUrl);
      if (!mmrHistory || !mmrHistory.data || mmrHistory.data.length === 0) continue;

      const latestMmr = mmrHistory.data[0];
      const latestMatchId = latestMmr.match_id;

      // Initialize last_match_id if empty without sending notification
      if (!player.last_match_id) {
        db.prepare('UPDATE tracked_players SET last_match_id = ? WHERE id = ?')
          .run(latestMatchId, player.id);

        // Also set starting daily stats if empty
        if (player.daily_start_rr === null) {
          const todayStr = new Date().toISOString().split('T')[0];
          db.prepare('UPDATE tracked_players SET daily_start_rr = ?, daily_start_rank = ?, daily_start_date = ? WHERE id = ?')
            .run(latestMmr.ranking_in_tier, latestMmr.currenttierpatched, todayStr, player.id);
        }
        continue;
      }

      // Check if it's a new match
      if (latestMatchId !== player.last_match_id) {
        // Fetch detailed match info
        const matchUrl = `/valorant/v4/matches/eu/pc/${encodeURIComponent(player.name)}/${encodeURIComponent(player.tag)}?size=1`;
        const matchData = await fetchHenrikDev<any>(matchUrl);

        if (matchData && matchData.data && matchData.data.length > 0) {
          const match = matchData.data[0];

          // Verify it matches the queue type (Competitive)
          const isComp = match.metadata?.queue?.name?.toLowerCase() === 'competitive';
          if (isComp) {
            await sendMatchNotification(player, match, latestMmr);
          }

          // Save last match ID
          db.prepare('UPDATE tracked_players SET last_match_id = ? WHERE id = ?')
            .run(latestMatchId, player.id);
        }
      }
    } catch (e) {
      console.error(`[Bot] Error polling player ${player.name}#${player.tag}:`, e);
    }

    // Slight delay to be gentle with rate limiting
    await new Promise(res => setTimeout(res, 2000));
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

        summaryLines.push(
          `**${player.name} : ${deltaSign}**`,
          `${wins}W ${losses}L (${winrate}%) | ${startRank} ${startRR}rr -> ${currentRank} ${currentRR}rr\n`
        );

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
      .setName('preview')
      .setDescription('Affiche un aperçu de la notification de match directement dans Discord'),
    new SlashCommandBuilder()
      .setName('setup-emojis')
      .setDescription('Téléverse automatiquement les émojis de rangs Valorant sur l\'application du bot')
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

      const mockEmoji = getRankEmoji('Gold 3'); // Test resolving local emoji if it exists
      const mockMateEmoji = getRankEmoji('Silver 2');

      const embed = new EmbedBuilder()
        .setAuthor({
          name: `Sitpi#EUW`,
          iconURL: mockTierIcon
        })
        .setTitle(`🏆 Victoire (13-5) • 🏅 MVP`)
        .setDescription(`${mockEmoji ? mockEmoji + '**Or 3**' : '**Or 3**'} • **62 RR** (\`+22 RR\`)`)
        .setColor(0x00FF00) // Green
        .addFields(
          { name: 'KDA', value: '`24/11/5`', inline: true },
          { name: 'KAST', value: '`83.3%`', inline: true },
          { name: 'ACS', value: '`285`', inline: true },
          { name: 'Groupe', value: `👥 Duo (avec ${mockMateEmoji ? 'malstrom#EUW ' + mockMateEmoji.trim() : 'malstrom#EUW (Argent 2)'})`, inline: false }
        )
        .setFooter({ text: 'Ascent' })
        .setTimestamp(new Date());

      if (mockAgentIcon) {
        embed.setThumbnail(mockAgentIcon);
      }

      const button = new ButtonBuilder()
        .setLabel('Détails du match')
        .setURL('https://valotracker.sitpi.pro/player/Sitpi/EUW')
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
