const yts = require('yt-search');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
const { spawn } = require('child_process');
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

const guilds = new Map();

function getGuild(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      connection: null,
      player: null,
      queue: [],
      current: null,
      nowPlayingMsg: null,
      textChannel: null,
    });
  }
  return guilds.get(guildId);
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or add it to the queue')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Song name or YouTube URL')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Disconnect the bot from voice channel'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current queue'),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('spotify')
    .setDescription('Play your current Spotify song'),
].map(c => c.toJSON());

client.once('clientReady', async () => {
  console.log(`Online as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('Commands registered');
});

function ytdlpSearch(query) {
  return new Promise((resolve, reject) => {
    const isUrl = query.startsWith('http');
    const target = isUrl ? query : `ytmsearch:${query}`;
    const ytdlp = spawn('/usr/local/bin/yt-dlp', [
      '--no-playlist',
      '--print', '%(title)s\t%(webpage_url)s\t%(duration_string)s\t%(thumbnail)s',
      '--skip-download',
      '--cookies', '/home/ubuntu/discord-spotify-vc-bot/cookies.txt',
      target,
    ]);
    let output = '';
    ytdlp.stdout.on('data', d => output += d.toString());
    ytdlp.stderr.on('data', d => console.error('yt-dlp search:', d.toString()));
    ytdlp.on('close', () => {
      if (!output.trim()) return reject(new Error('No results'));
      const [title, url, duration, thumbnail] = output.trim().split('\t');
      resolve({ title, url, duration, thumbnail });
    });
  });
}

function getAudioStream(url) {
  const ytdlp = spawn('/usr/local/bin/yt-dlp', [
    '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
    '--no-playlist',
    '--audio-quality', '0',
    '--remote-components', 'ejs:github',
    '--js-runtimes', 'deno:/home/ubuntu/.deno/bin/deno',
    '--cookies', '/home/ubuntu/discord-spotify-vc-bot/cookies.txt',
    '--sponsorblock-remove', 'sponsor,intro,selfpromo,preview,filler,interaction,music_offtopic',
    '-o', '-',
    url,
  ]);
  ytdlp.stderr.on('data', d => console.error('yt-dlp:', d.toString()));
  return ytdlp.stdout;
}

function buildNowPlayingEmbed(track, queue, requester) {
  const upcoming = queue.slice(0, 3).map((v, i) => `\`${i + 1}.\` ${v.title}`).join('\n') || 'Nothing in queue';
  return new EmbedBuilder()
    .setColor(0x1db954)
    .setAuthor({ name: '🎵 Now Playing' })
    .setTitle(track.title)
    .setURL(track.url)
    .setThumbnail(track.thumbnail || null)
    .addFields(
      { name: '⏱ Duration', value: track.duration || 'Unknown', inline: true },
      { name: '👤 Requested by', value: requester || 'Unknown', inline: true },
      { name: '📋 Up Next', value: upcoming }
    )
    .setFooter({ text: `${queue.length} song(s) in queue` });
}

function buildControls(paused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pause_resume')
      .setLabel(paused ? '▶ Resume' : '⏸ Pause')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('skip')
      .setLabel('⏭ Skip')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('stop')
      .setLabel('⏹ Stop')
      .setStyle(ButtonStyle.Danger),
  );
}

async function playNext(guildId) {
  const g = getGuild(guildId);
  if (g.queue.length === 0) {
    g.current = null;
    if (g.textChannel) {
      g.textChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x1db954)
            .setDescription('✅ Queue finished! Add more songs with `/play`.')
        ]
      });
    }
    return;
  }

  const next = g.queue.shift();
  g.current = next;

  const stream = getAudioStream(next.url);
  const resource = createAudioResource(stream);
  g.player.play(resource);

  const embed = buildNowPlayingEmbed(next, g.queue, next.requester);
  const controls = buildControls(false);

  if (g.nowPlayingMsg) {
    try { await g.nowPlayingMsg.delete(); } catch {}
  }

  if (g.textChannel) {
    g.nowPlayingMsg = await g.textChannel.send({ embeds: [embed], components: [controls] });
  }
}

async function ensureConnection(guildId, vc) {
  const g = getGuild(guildId);
  if (g.connection) return g.connection;

  const connection = joinVoiceChannel({
    channelId: vc.id,
    guildId,
    adapterCreator: vc.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on('error', err => console.error('Voice error:', err));
  connection.on('stateChange', (o, n) => console.log(`Voice: ${o.status} -> ${n.status}`));

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  const player = createAudioPlayer();
  connection.subscribe(player);

  player.on('error', err => console.error('Player error:', err));
  player.on(AudioPlayerStatus.Idle, async () => {
    await new Promise(r => setTimeout(r, 1000));
    await playNext(guildId);
  });

  g.connection = connection;
  g.player = player;

  return connection;
}

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const query = interaction.options.getFocused();
    if (!query || query.length < 2) return interaction.respond([]);
    try {
      const results = await yts(query);
      const choices = results.videos.slice(0, 5).map(v => ({
        name: v.title.slice(0, 100),
        value: v.url,
      }));
      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
    return;
  }

  if (interaction.isButton()) {
    const g = getGuild(interaction.guildId);
    if (!g.player) return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });

    if (interaction.customId === 'pause_resume') {
      const status = g.player.state.status;
      if (status === AudioPlayerStatus.Playing) {
        g.player.pause();
        await interaction.update({ components: [buildControls(true)] });
      } else if (status === AudioPlayerStatus.Paused) {
        g.player.unpause();
        await interaction.update({ components: [buildControls(false)] });
      }
      return;
    }

    if (interaction.customId === 'skip') {
      g.player.stop();
      await interaction.reply({ content: '⏭ Skipped!', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId === 'stop') {
      g.player.stop();
      g.queue = [];
      g.connection?.destroy();
      g.connection = null;
      g.player = null;
      g.current = null;
      guilds.delete(interaction.guildId);
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0xff0000).setDescription('⏹ Stopped and disconnected.')],
        components: [],
      });
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guildId } = interaction;

  if (commandName === 'play') {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: 'Join a voice channel first!', flags: MessageFlags.Ephemeral });

    await interaction.deferReply();

    const query = interaction.options.getString('query');
    const g = getGuild(guildId);
    g.textChannel = interaction.channel;

    try {
      const track = await ytdlpSearch(query);
      track.requester = member.user.username;

      await ensureConnection(guildId, vc);

      if (g.player.state.status === AudioPlayerStatus.Playing || g.player.state.status === AudioPlayerStatus.Paused) {
        g.queue.push(track);
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x1db954)
              .setAuthor({ name: '✅ Added to Queue' })
              .setTitle(track.title)
              .setURL(track.url)
              .addFields(
                { name: '⏱ Duration', value: track.duration || '?', inline: true },
                { name: '📋 Position', value: `#${g.queue.length}`, inline: true },
                { name: '👤 Requested by', value: member.user.username, inline: true },
              )
          ]
        });
      }

      g.queue.push(track);
      await playNext(guildId);
      await interaction.deleteReply();

    } catch (err) {
      console.error(err);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
    return;
  }

  if (commandName === 'spotify') {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: 'Join a voice channel first!', flags: MessageFlags.Ephemeral });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const spotifyActivity = member.presence?.activities?.find(a => a.name === 'Spotify');
    if (!spotifyActivity) return interaction.editReply("You're not playing anything on Spotify!");

    const query = `${spotifyActivity.details} ${spotifyActivity.state}`;
    const g = getGuild(guildId);
    g.textChannel = interaction.channel;

    try {
      const track = await ytdlpSearch(query);
      track.requester = member.user.username;

      await ensureConnection(guildId, vc);

      if (g.player.state.status === AudioPlayerStatus.Playing || g.player.state.status === AudioPlayerStatus.Paused) {
        g.queue.push(track);
        return interaction.editReply(`Added **${track.title}** to the queue at position #${g.queue.length}`);
      }

      g.queue.push(track);
      await playNext(guildId);
      await interaction.editReply(`Playing your Spotify song!`);

    } catch (err) {
      console.error(err);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
    return;
  }

  if (commandName === 'skip') {
    const g = getGuild(guildId);
    if (!g.player) return interaction.reply({ content: 'Nothing is playing!', flags: MessageFlags.Ephemeral });
    g.player.stop();
    await interaction.reply({ content: '⏭ Skipped!', flags: MessageFlags.Ephemeral });
    return;
  }

  if (commandName === 'queue') {
    const g = getGuild(guildId);
    if (!g.current && g.queue.length === 0) {
      return interaction.reply({ content: 'Queue is empty!', flags: MessageFlags.Ephemeral });
    }
    const list = g.queue.map((v, i) => `\`${i + 1}.\` ${v.title} — *${v.requester}*`).join('\n') || 'Nothing up next';
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle('📋 Queue')
      .addFields(
        { name: '🎵 Now Playing', value: g.current?.title || 'Nothing' },
        { name: '⏭ Up Next', value: list }
      )
      .setFooter({ text: `${g.queue.length} song(s) in queue` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (commandName === 'disconnect') {
    const g = getGuild(guildId);
    if (!g.connection) return interaction.reply({ content: "I'm not in a VC!", flags: MessageFlags.Ephemeral });
    g.player?.stop();
    g.connection.destroy();
    guilds.delete(guildId);
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(0xff0000).setDescription('👋 Disconnected. See you next time!')]
    });
    return;
  }
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

const port = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false }));
});

server.listen(port, '0.0.0.0', () => console.log(`Health server listening on port ${port}`));

client.login(process.env.BOT_TOKEN);
