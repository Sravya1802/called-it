import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from './game.js';
import { Twitch } from './twitch.js';
const demo = process.argv.includes('--demo');
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const game = new Game(resolve(process.env.STATE_FILE || `data/${demo ? 'demo' : 'state'}.json`), {
  minute: demo ? 15000 : 60000,
});
let connection = demo ? 'Demo mode · no Twitch connection' : 'Connecting to Twitch…';
let twitch;
const snapshot = () => ({ ...game.snapshot(), demo, connection });
const broadcast = () => {
  const data = JSON.stringify(snapshot());
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
};
game.on('change', broadcast);
wss.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshot()));
  ws.on('error', () => {});
});
app.use(express.json({ limit: '2kb' }));
app.get('/api/state', (_req, res) => res.json(snapshot()));
const viewers = [
  { id: 'v1', name: 'lunarwitch' },
  { id: 'v2', name: 'pixelpilot' },
  { id: 'v3', name: 'noodlebrain' },
  { id: 'v4', name: 'itsmilo' },
];
function chat(user, text) {
  const reply = game.command(user, text);
  if (reply) {
    console.log(`CalledIt: ${reply}`);
    twitch?.send(reply);
  }
}
app.post('/api/demo', (req, res) => {
  if (!demo) return res.status(404).json({ error: 'Demo mode is disabled.' });
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    return res.status(403).json({ error: 'Origin rejected' });
  const { action, text, user = 0, id } = req.body;
  if (action === 'chat' && typeof text === 'string' && text.length <= 240 && Number.isInteger(user) && viewers[user])
    chat(viewers[user], text);
  else if (['yes', 'no'].includes(action) && typeof id === 'string')
    chat({ id: 'host', name: 'streamer', broadcaster: true }, `!${action} ${id}`);
  else if (action === 'expire') {
    const c = game.state.calls.find((c) => c.id === id && c.status === 'active');
    if (c) {
      c.expiresAt = Date.now();
      game.expire();
    }
  } else if (action === 'seed') seed();
  else return res.status(400).json({ error: 'Invalid demo action' });
  res.json(snapshot());
});
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
app.get('/overlay', (_req, res) => res.sendFile(resolve(publicDir, 'overlay.html')));
app.use(express.static(publicDir));
// Malformed JSON and oversized bodies get a short JSON error instead of Express's HTML stack trace.
app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: 'Malformed request' }));
function seed() {
  const predictions = [
    'First try. No warm-up. No excuses.',
    'The next chest has a legendary.',
    'Chat will behave for a whole minute.',
    'We clutch this with 1 HP.',
  ];
  viewers.forEach((u, i) => {
    if (!game.state.calls.some((c) => c.userId === u.id && c.status === 'active'))
      chat(u, `!call ${predictions[i]} in ${i + 2}m`);
  });
  game.state.calls
    .filter((c) => c.status === 'active')
    .forEach((c, i) =>
      viewers.forEach((u, j) => {
        if (u.id !== c.userId) chat(u, `!${(i + j) % 3 ? 'back' : 'doubt'} ${c.id}`);
      }),
    );
}
const tick = setInterval(() => {
  game.expire();
  broadcast();
}, 1000);
let simulator;
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', async () => {
  console.log(
    `Called It → http://localhost:${server.address().port}\nOBS → http://localhost:${server.address().port}/overlay (1920×1080)`,
  );
  if (demo) {
    if (!game.state.calls.some((c) => c.status === 'active')) seed();
    let step = 0;
    simulator = setInterval(() => {
      const active = game.state.calls.filter((c) => c.status === 'active');
      if (!active.length) {
        seed();
        return;
      }
      const c = active[0];
      if (step++ % 3 === 2) chat({ id: 'host', name: 'streamer', mod: true }, `!${step % 2 ? 'yes' : 'no'} ${c.id}`);
      else {
        const u = viewers.find((u) => u.id !== c.userId);
        chat(u, `!${step % 2 ? 'back' : 'doubt'} ${c.id}`);
      }
    }, 12000);
  } else {
    const keys = ['CLIENT_ID', 'ACCESS_TOKEN', 'BROADCASTER_ID', 'BOT_ID'];
    if (keys.some((k) => !process.env[k])) {
      connection = 'Setup needed · configure .env and restart';
      broadcast();
      console.error(connection);
      return;
    }
    twitch = new Twitch(process.env, chat, (status) => {
      connection = status;
      console.log(status);
      broadcast();
    });
    try {
      await twitch.start();
    } catch (e) {
      connection = e.message;
      console.error(connection);
      broadcast();
    }
  }
});
server.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
function shutdown() {
  clearInterval(tick);
  clearInterval(simulator);
  twitch?.stop();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
