import WebSocket from 'ws';
const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
export class Twitch {
  constructor(config, onChat, status) {
    this.c = config;
    this.onChat = onChat;
    this.status = status;
    this.sockets = new Set();
    this.seen = new Map();
    this.stopped = false;
    this.delay = 1000;
    this.queue = [];
  }
  async validate() {
    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${this.c.ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    // Only token problems are fatal; network errors and Twitch outages are retried at the next hourly check.
    const fail = (message) => Object.assign(new Error(message), { auth: true });
    if (response.status === 401) throw fail('Twitch token is invalid or expired. Update ACCESS_TOKEN in .env.');
    if (!response.ok) throw new Error(`Twitch token check returned ${response.status}.`);
    const data = await response.json();
    if (data.client_id !== this.c.CLIENT_ID || data.user_id !== this.c.BOT_ID)
      throw fail('Token must belong to CLIENT_ID and BOT_ID.');
    for (const scope of ['user:read:chat', 'user:write:chat'])
      if (!data.scopes.includes(scope)) throw fail(`Token needs scope ${scope}.`);
  }
  async api(path, body) {
    const response = await fetch(`https://api.twitch.tv/helix/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.c.ACCESS_TOKEN}`,
        'Client-Id': this.c.CLIENT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Twitch API ${response.status}: ${data.message || 'request failed'}`);
    return data;
  }
  async start() {
    await this.validate();
    this.validation = setInterval(
      () =>
        this.validate().catch((e) => {
          if (e.auth) {
            this.status(e.message);
            this.stop();
          } else console.warn(`Token check failed (${e.message}); retrying in an hour.`);
        }),
      3600000,
    );
    this.connect();
  }
  connect(url = ENDPOINT, old = null) {
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.sockets.add(ws);
    let watchdog;
    let timeout = 15000;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), timeout);
    };
    arm();
    ws.on('message', async (raw) => {
      arm();
      try {
        const { metadata: m, payload: p } = JSON.parse(raw);
        if (m.message_type === 'session_welcome') {
          timeout = (p.session.keepalive_timeout_seconds || 10) * 1000 + 2000;
          arm();
          if (old) {
            old.close();
          } else
            await this.api('eventsub/subscriptions', {
              type: 'channel.chat.message',
              version: '1',
              condition: { broadcaster_user_id: this.c.BROADCASTER_ID, user_id: this.c.BOT_ID },
              transport: { method: 'websocket', session_id: p.session.id },
            });
          this.current = ws;
          this.delay = 1000;
          this.status('Connected to Twitch');
        } else if (m.message_type === 'session_reconnect') {
          const target = new URL(p.session.reconnect_url);
          if (target.protocol !== 'wss:' || !target.hostname.endsWith('.twitch.tv'))
            throw new Error('Invalid Twitch reconnect URL');
          this.connect(target.href, ws);
        } else if (m.message_type === 'revocation') {
          this.status(`Subscription revoked: ${p.subscription.status}. Restart after fixing authorization.`);
          this.stop();
        } else if (m.message_type === 'notification' && m.subscription_type === 'channel.chat.message') {
          const id = p.event.message_id || m.message_id;
          if (this.seen.has(id)) return;
          this.seen.set(id, Date.now());
          for (const [key, time] of this.seen) if (Date.now() - time > 600000) this.seen.delete(key);
          // Skip the bot's own replies (they never start with "!"), but keep commands when the bot is also the broadcaster.
          const e = p.event;
          if (e.chatter_user_id === this.c.BOT_ID && !e.message.text.trimStart().startsWith('!')) return;
          this.onChat(
            {
              id: e.chatter_user_id,
              name: e.chatter_user_name,
              mod: e.badges.some((b) => b.set_id === 'moderator'),
              broadcaster: e.chatter_user_id === this.c.BROADCASTER_ID,
            },
            e.message.text,
          );
        }
      } catch (e) {
        this.status(e.message);
        if (!this.current || this.current === ws) ws.terminate();
      }
    });
    ws.on('error', () => this.status('Twitch connection error; reconnecting…'));
    ws.on('close', () => {
      clearTimeout(watchdog);
      this.sockets.delete(ws);
      if (this.current === ws) this.current = null;
      if (!this.stopped && !this.sockets.size) {
        this.status('Reconnecting to Twitch…');
        this.retry = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
      }
    });
  }
  send(message) {
    if (this.queue.length < 50) this.queue.push(message);
    this.drain();
  }
  async drain() {
    if (this.sending || this.stopped) return;
    this.sending = true;
    while (this.queue.length && !this.stopped) {
      const message = this.queue.shift();
      try {
        const data = await this.api('chat/messages', {
          broadcaster_id: this.c.BROADCASTER_ID,
          sender_id: this.c.BOT_ID,
          message: message.slice(0, 500),
        });
        if (!data.data?.[0]?.is_sent)
          this.status(`Chat message dropped: ${data.data?.[0]?.drop_reason?.message || 'unknown reason'}`);
      } catch (e) {
        this.status(e.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
    this.sending = false;
  }
  stop() {
    this.stopped = true;
    clearInterval(this.validation);
    clearTimeout(this.retry);
    for (const ws of this.sockets) ws.close();
  }
}
