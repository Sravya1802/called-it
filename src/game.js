import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export class Game extends EventEmitter {
  constructor(file, { now = Date.now, minute = 60000 } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.minute = minute;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { calls: [], players: {}, messages: [] };
    if (!Array.isArray(this.state.calls) || !this.state.players)
      throw new Error('Invalid state file; restore a backup before starting.');
    this.state.messages ??= [];
    // Rebuild caller streaks from history so existing save files need no reset.
    for (const player of Object.values(this.state.players)) player.streak = 0;
    for (const call of this.state.calls
      .filter((c) => c.status !== 'active')
      .sort((a, b) => a.resolvedAt - b.resolvedAt)) {
      const player = this.state.players[call.userId];
      if (player) player.streak = call.status === 'yes' ? player.streak + 1 : 0;
    }
    this.expire();
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2));
    renameSync(this.file + '.tmp', this.file);
    this.emit('change', this.snapshot());
  }
  player(user) {
    return (this.state.players[user.id] ??= { id: user.id, name: user.name, points: 0, wins: 0, streak: 0 });
  }
  snapshot() {
    const now = this.now();
    const chatWins = this.state.calls.filter((c) => c.status === 'yes').length;
    const streamerWins = this.state.calls.filter((c) => c.status === 'no').length;
    return {
      now,
      battle: { chatWins, streamerWins, chatPercent: Math.max(5, Math.min(95, 50 + (chatWins - streamerWins) * 5)) },
      calls: this.state.calls
        .filter((c) => c.status === 'active' || now - c.resolvedAt < 8000)
        .map((c) => ({
          ...c,
          backers: Object.values(c.votes).filter((v) => v.side === 'back').length,
          doubters: Object.values(c.votes).filter((v) => v.side === 'doubt').length,
          votes: undefined,
        })),
      leaderboard: Object.values(this.state.players)
        .sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name))
        .slice(0, 5),
      messages: this.state.messages.slice(-60),
      stats: {
        total: this.state.calls.length,
        active: this.state.calls.filter((c) => c.status === 'active').length,
        resolved: this.state.calls.filter((c) => ['yes', 'no'].includes(c.status)).length,
        points: Object.values(this.state.players).reduce((n, p) => n + p.points, 0),
      },
    };
  }
  log(name, text, bot = false) {
    this.state.messages.push({ name, text, bot, at: this.now() });
    this.state.messages = this.state.messages.slice(-60);
  }
  expire() {
    let changed = false;
    for (const c of this.state.calls)
      if (c.status === 'active' && c.expiresAt <= this.now()) {
        c.status = 'unresolved';
        c.resolvedAt = this.now();
        if (this.state.players[c.userId]) this.state.players[c.userId].streak = 0;
        changed = true;
      }
    if (changed) this.save();
  }
  command(user, message) {
    this.expire();
    this.log(user.name, message);
    const reply = this.handle(user, message.trim());
    if (reply) this.log('CalledIt', reply, true);
    this.save();
    return reply;
  }
  handle(user, text) {
    if (!/^!(call|back|doubt|yes|no|oracle)\b/i.test(text)) return null;
    if (/^!oracle$/i.test(text)) {
      const top = this.snapshot().leaderboard;
      return top.length
        ? '🔮 Oracles: ' + top.map((p, i) => `${i + 1}. ${p.name} ${p.points}pt`).join(' • ')
        : 'No points yet. Make your first call!';
    }
    const match = text.match(/^!call\s+(.+?)\s+in\s+(\d+)m$/i);
    if (match) {
      const minutes = Number(match[2]);
      const active = this.state.calls.filter((c) => c.status === 'active');
      if (minutes < 1 || minutes > 180) return 'Choose a duration from 1 to 180 minutes.';
      if (match[1].length > 180) return 'Keep your prediction to 180 characters.';
      if (active.some((c) => c.userId === user.id)) return `@${user.name}, you already have an active call.`;
      if (active.length >= 5) return 'The board is full (5 calls). Try again when a call clears.';
      this.player(user).name = user.name;
      let id;
      do {
        id = randomBytes(2).toString('hex').toUpperCase();
      } while (this.state.calls.some((c) => c.id === id));
      this.state.calls.push({
        id,
        userId: user.id,
        username: user.name,
        text: match[1],
        createdAt: this.now(),
        expiresAt: this.now() + minutes * this.minute,
        status: 'active',
        onFire: this.state.players[user.id].streak >= 3,
        votes: {},
      });
      return `@${user.name} called it! #${id} · ${minutes}m. !back ${id} or !doubt ${id}`;
    }
    const action = text.match(/^!(back|doubt|yes|no)\s+#?([a-f\d]{4})$/i);
    if (!action)
      return 'Commands: !call <prediction> in <1–180>m · !back <id> · !doubt <id> · !yes/!no <id> (mods) · !oracle';
    const [, raw, id] = action;
    const verb = raw.toLowerCase();
    const c = this.state.calls.find((c) => c.id === id.toUpperCase());
    if (!c || c.status !== 'active') return 'That call is no longer active (or the ID is unknown).';
    if (verb === 'back' || verb === 'doubt') {
      if (c.userId === user.id) return 'You cannot vote on your own call.';
      this.player(user).name = user.name;
      if (c.votes[user.id]?.side === verb) return `@${user.name}, you already chose ${verb} for #${c.id}.`;
      c.votes[user.id] = { side: verb };
      return `@${user.name} ${verb === 'back' ? 'backs' : 'doubts'} #${c.id}.`;
    }
    if (!user.mod && !user.broadcaster) return 'Only the broadcaster or a moderator can resolve calls.';
    // Nobody settles a call they have points riding on; another mod has to make the ruling.
    if (c.userId === user.id) return `@${user.name}, you cannot resolve your own call. Ask another mod.`;
    if (c.votes[user.id]) return `@${user.name}, you voted on #${c.id}, so another mod has to resolve it.`;
    c.status = verb;
    c.resolvedAt = this.now();
    this.state.players[c.userId].streak = verb === 'yes' ? (this.state.players[c.userId].streak || 0) + 1 : 0;
    if (verb === 'yes') {
      this.state.players[c.userId].points += 100;
      this.state.players[c.userId].wins++;
    }
    for (const [uid, vote] of Object.entries(c.votes))
      if (vote.side === (verb === 'yes' ? 'back' : 'doubt')) {
        this.state.players[uid].points += 25;
        this.state.players[uid].wins++;
      }
    return `#${c.id} ${verb === 'yes' ? 'CALLED IT! Caller +100pt, backers +25pt.' : 'BUSTED! Doubters +25pt.'}`;
  }
}
