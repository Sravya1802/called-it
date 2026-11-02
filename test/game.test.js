import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Game } from '../src/game.js';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'called-it-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let time = 100000;
  const file = join(dir, 'state.json');
  return { game: new Game(file, { now: () => time }), file, advance: (n) => (time += n) };
}
const u = (id, extra = {}) => ({ id, name: id, ...extra });
test('one call per viewer, five slots, valid bounded duration', (t) => {
  const { game: g } = fixture(t);
  assert.match(g.command(u('a'), '!call win in 0m'), /1 to 180/);
  g.command(u('a'), '!call win in 1m');
  assert.match(g.command(u('a'), '!call win in 1m'), /already/);
  for (let i = 0; i < 4; i++) g.command(u('b' + i), '!call win in 1m');
  assert.match(g.command(u('z'), '!call win in 1m'), /full/);
  assert.equal(g.snapshot().calls.length, 5);
});
test('votes switch, caller cannot vote, moderator resolves exactly once', (t) => {
  const { game: g, file } = fixture(t);
  g.command(u('a'), '!call win in 5m');
  const id = g.state.calls[0].id;
  assert.match(g.command(u('a'), `!back ${id}`), /own/);
  g.command(u('b'), `!doubt ${id}`);
  g.command(u('b'), `!back ${id}`);
  assert.equal(g.snapshot().calls[0].doubters, 0);
  assert.match(g.command(u('b'), `!yes ${id}`), /Only/);
  assert.match(g.command(u('a', { mod: true }), `!yes ${id}`), /own call/);
  assert.match(g.command(u('b', { broadcaster: true }), `!yes ${id}`), /voted on/);
  assert.equal(g.state.calls[0].status, 'active');
  g.command(u('mod', { mod: true }), `!yes ${id}`);
  g.command(u('mod', { mod: true }), `!yes ${id}`);
  assert.equal(g.state.players.a.points, 100);
  assert.equal(g.state.players.b.points, 25);
  assert.equal(new Game(file).state.players.a.points, 100);
});
test('busted calls reward only doubters; expiry awards nothing and cannot resolve', (t) => {
  const { game: g, advance } = fixture(t);
  g.command(u('a'), '!call win in 1m');
  let id = g.state.calls[0].id;
  g.command(u('b'), `!doubt ${id}`);
  g.command(u('host', { broadcaster: true }), `!no ${id}`);
  assert.equal(g.state.players.a.points, 0);
  assert.equal(g.state.players.b.points, 25);
  g.command(u('a'), '!call again in 1m');
  id = g.state.calls[1].id;
  advance(60001);
  g.expire();
  assert.equal(g.state.calls[1].status, 'unresolved');
  assert.match(g.command(u('host', { mod: true }), `!yes ${id}`), /no longer/);
  advance(8001);
  assert.equal(g.snapshot().calls.length, 0);
  assert.match(g.command(u('a'), '!oracle'), /b 25pt/);
});
test('three caller wins earn a next-card flame; votes do not count and bust resets it', (t) => {
  const { game: g, file } = fixture(t);
  const host = u('host', { mod: true });
  for (let i = 0; i < 3; i++) {
    g.command(u('a'), '!call win in 5m');
    const c = g.state.calls.at(-1);
    assert.equal(c.onFire, false);
    g.command(u('voter'), `!back ${c.id}`);
    g.command(host, `!yes ${c.id}`);
  }
  assert.equal(g.state.players.a.streak, 3);
  assert.equal(g.state.players.voter.streak, 0);
  const restored = new Game(file);
  assert.equal(restored.state.players.a.streak, 3);
  restored.command(u('a'), '!call next in 5m');
  const next = restored.state.calls.at(-1);
  assert.equal(next.onFire, true);
  restored.command(host, `!no ${next.id}`);
  assert.equal(restored.state.players.a.streak, 0);
  restored.command(u('a'), '!call after bust in 5m');
  assert.equal(restored.state.calls.at(-1).onFire, false);
});
test('battle is persistent, symmetric, bounded, and ignores expiry or duplicate resolutions', (t) => {
  const { game: g, file, advance } = fixture(t);
  const host = u('host', { broadcaster: true });
  assert.equal(g.snapshot().battle.chatPercent, 50);
  for (const outcome of ['yes', 'yes', 'no']) {
    g.command(u('a'), '!call win in 1m');
    const id = g.state.calls.at(-1).id;
    g.command(host, `!${outcome} ${id}`);
    g.command(host, `!${outcome} ${id}`);
  }
  assert.deepEqual(g.snapshot().battle, { chatWins: 2, streamerWins: 1, chatPercent: 55 });
  g.command(u('a'), '!call expire in 1m');
  advance(60001);
  g.expire();
  assert.equal(g.state.players.a.streak, 0);
  assert.equal(g.snapshot().battle.chatPercent, 55);
  assert.deepEqual(new Game(file).snapshot().battle, g.snapshot().battle);
  for (let i = 0; i < 15; i++) {
    g.command(u('a'), '!call win in 1m');
    g.command(host, `!yes ${g.state.calls.at(-1).id}`);
  }
  assert.equal(g.snapshot().battle.chatPercent, 95);
});
