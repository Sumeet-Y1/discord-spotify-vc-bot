const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes, 
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const http = require('node:http');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
  ],
});

const state = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Bot joins your voice channel'),
  new SlashCommandBuilder()
    .setName('spotify')
    .setDescription('Plays your Spotify song in VC - use again to pause/resume'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Bot leaves the voice channel'),
].map(command => command.toJSON());

client.once('clientReady', async () => {
  console.log(`Online as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('Commands registered');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guildId } = interaction;

  if (commandName === 'join') {
    const vc = member.voice.channel;
    if (!vc) {
      return interaction.reply({
        content: 'Join a voice channel first!',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let connection;
    try {
      connection = joinVoiceChannel({
        channelId: vc.id,
        guildId,
        adapterCreator: vc.guild.voiceAdapterCreator,
        debug: true,
      });

      connection.on('error', error => {
        console.error('Voice connection error:', error);
      });

      connection.on('debug', msg => console.log('Voice debug:', msg));

      connection.on('stateChange', (oldState, newState) => {
        console.log(`Voice state: ${oldState.status} -> ${newState.status}`);
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

      const player = createAudioPlayer();
      connection.subscribe(player);
      state.set(guildId, { connection, player });

      await interaction.editReply(`Joined **${vc.name}** - use /spotify to play your song!`);
    } catch (err) {
      console.error(err);

      const message =
        err?.code === 'ABORT_ERR'
          ? "Timed out while joining the voice channel. Check the bot's connect/speak permissions and try again."
          : `Could not join VC: ${err.message}`;

      await interaction.editReply(message);
      if (connection) {
        connection.destroy();
      }
    }
    return;
  }

  if (commandName === 'spotify') {
    const s = state.get(guildId);

    if (s?.player) {
      const status = s.player.state.status;
      if (status === AudioPlayerStatus.Playing) {
        s.player.pause();
        return interaction.reply({
          content: 'Paused.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (status === AudioPlayerStatus.Paused) {
        s.player.unpause();
        return interaction.reply({
          content: 'Resumed!',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (!s?.connection) {
      return interaction.reply({
        content: 'Use /join first!',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    const spotifyActivity = member.presence?.activities?.find(activity => activity.name === 'Spotify');
    if (!spotifyActivity) {
      return interaction.editReply(
        "You're not playing anything on Spotify! Open Spotify and play a song first."
      );
    }

    const query = `${spotifyActivity.details} ${spotifyActivity.state}`;
    console.log(`Searching: ${query}`);

    try {
      const result = await yts(query);
      const video = result.videos[0];
      if (!video) {
        return interaction.editReply('Could not find that song on YouTube.');
      }

      const stream = ytdl(video.url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
      });

      stream.on('error', err => console.error('Stream error:', err));

      const resource = createAudioResource(stream);
      s.player.play(resource);

      s.player.on('error', err => console.error('Player error:', err));

      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle('Now Playing')
        .setDescription(`**${video.title}**`)
        .setFooter({ text: 'Use /spotify again to pause - /stop to leave' });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
    return;
  }

  if (commandName === 'stop') {
    const s = state.get(guildId);
    if (!s?.connection) {
      return interaction.reply({
        content: "I'm not in a VC!",
        flags: MessageFlags.Ephemeral,
      });
    }

    s.player.stop();
    s.connection.destroy();
    state.delete(guildId);
    await interaction.reply('Left the voice channel.');
  }
});

process.on('unhandledRejection', err => console.error('Unhandledrejection:', err));

const port = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Health server listening on port ${port}`);
});

client.login(process.env.BOT_TOKEN);