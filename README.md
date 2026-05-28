# Discord Spotify VC Bot

A Discord bot that joins your voice channel, reads your Spotify presence, and tries to play a matching YouTube track in VC.

## Features

- `/join` joins your current voice channel
- `/spotify` finds the song you are listening to on Spotify and plays it in VC
- `/stop` leaves the voice channel
- Built-in `/health` endpoint for Render

## Requirements

- Node.js 18+ recommended
- A Discord bot application
- Spotify presence enabled in the Discord Developer Portal if you want `/spotify` to work

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from `.env.example`:

```bash
copy .env.example .env
```

3. Fill in:

- `BOT_TOKEN`
- `PORT` only if your host requires a custom port

4. Start the bot:

```bash
node bot.js
```

## Discord Setup

In the Discord Developer Portal:

- Enable `Presence Intent` if you want Spotify detection
- Enable `Server Members Intent` if your bot logic needs member data

In your server and voice channel permissions, the bot needs:

- `View Channel`
- `Connect`
- `Speak`

## Render Deployment

This bot includes a small HTTP server so Render can ping it at `/health`.

### Recommended Render setup

- Use a service type that keeps a Node process running continuously
- Set the start command to:

```bash
node bot.js
```

- Set the environment variables from your `.env` file in Render
- Use `https://your-service.onrender.com/health` for uptime checks

### Notes

- Free web services on Render can spin down when idle.
- If you want the bot online all the time, use an always-on service type.

## Files

- `bot.js` - bot logic and health endpoint
- `.env.example` - sample environment variables
- `.gitignore` - ignores secrets and dependencies
