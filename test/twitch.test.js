import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { Twitch } from '../src/twitch.js';

const config = { CLIENT_ID: 'app', ACCESS_TOKEN: 'token', BROADCASTER_ID: '42', BOT_ID: '42' };
const notification = (id, chatter, text) =>
  JSON.stringify({
    metadata: { message_type: 'notification', subscription_type: 'channel.chat.message', message_id: id },
    payload: {
      event: {
        message_id: id,
        chatter_user_id: chatter,
        chatter_user_name: 'user' + chatter,
        badges: [],
        message: { text },
      },
    },
  });
const welcome = JSON.stringify({
  metadata: { message_type: 'session_welcome' },
  payload: { session: { id: 'session', keepalive_timeout_seconds: 10 } },
});

test('a shared bot/broadcaster account keeps its commands but skips its own replies', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  const received = [];
  const twitch = new Twitch(
    config,
    (user, text) => received.push({ user, text }),
    () => {},
  );
  twitch.api = async () => ({});
  t.after(() => {
    twitch.stop();
    server.close();
  });
  server.on('connection', (ws) => {
    ws.send(welcome);
    ws.send(notification('1', '42', '!yes A1B2'));
    ws.send(notification('2', '42', '@viewer called it! #A1B2 · 5m. !back A1B2 or !doubt A1B2'));
    ws.send(notification('3', '42', '#A1B2 CALLED IT! Caller +100pt, backers +25pt.'));
    ws.send(notification('3', '42', '#A1B2 CALLED IT! Caller +100pt, backers +25pt.'));
    ws.send(notification('4', '7', 'hello'));
  });
  twitch.connect(`ws://localhost:${server.address().port}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(
    received.map((r) => r.text),
    ['!yes A1B2', 'hello'],
  );
  assert.equal(received[0].user.broadcaster, true);
});

test('token validation treats only token problems as fatal', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const outcome = async (fetchImpl) => {
    globalThis.fetch = fetchImpl;
    try {
      await new Twitch(
        config,
        () => {},
        () => {},
      ).validate();
      return 'passed';
    } catch (e) {
      return e.auth ? 'fatal' : 'transient';
    }
  };
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const scopes = ['user:read:chat', 'user:write:chat'];
  assert.equal(
    await outcome(async () => {
      throw new TypeError('fetch failed');
    }),
    'transient',
  );
  assert.equal(await outcome(json(503, { message: 'unavailable' })), 'transient');
  assert.equal(await outcome(json(401, { message: 'invalid access token' })), 'fatal');
  assert.equal(await outcome(json(200, { client_id: 'app', user_id: '99', scopes })), 'fatal');
  assert.equal(await outcome(json(200, { client_id: 'app', user_id: '42', scopes: ['user:read:chat'] })), 'fatal');
  assert.equal(await outcome(json(200, { client_id: 'app', user_id: '42', scopes })), 'passed');
});
