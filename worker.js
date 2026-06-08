/* ============================================================
   Bomb Busters — Cloudflare Worker + Durable Object (game room)
   - One Durable Object instance per room (holds all hands = the "dealer").
   - Polling based (turn-based game): clients GET state and POST actions.
   - Each player only ever receives their own hand (viewFor masks the rest).
   ============================================================ */
import Engine from './engine.js';

const AI_NAMES = ['アオイ', 'ユメ', 'リク', 'ケン'];
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const rid = (n = 4) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS')
      return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });

    // POST /api/room/create  -> make a new room, route to its Durable Object
    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const code = rid();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(new Request(url.origin + '/create', { method: 'POST', body: JSON.stringify({ code, ...(await request.json().catch(() => ({}))) }) }));
    }
    // /api/room/:code/...  -> forward to that room's Durable Object
    const m = url.pathname.match(/^\/api\/room\/([A-Z0-9]+)\/(\w+)$/);
    if (m) {
      const code = m[1];
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const fwd = new Request(url.origin + '/' + m[2] + url.search, { method: request.method, body: request.method === 'POST' ? await request.text() : undefined });
      return stub.fetch(fwd);
    }
    return json({ error: 'not found' }, 404);
  }
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null; // { code, mission, pcount, started, host, players:[{id,name,seat}], humanSeats:[], game:S }
  }

  async load() {
    if (this.room === null) this.room = (await this.state.storage.get('room')) || null;
    return this.room;
  }
  async save() { await this.state.storage.put('room', this.room); }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    await this.load();

    // --- create room ---
    if (path === 'create') {
      this.room = {
        code: body.code, mission: body.mission || '4', pcount: Math.min(5, Math.max(4, body.pcount || 4)),
        started: false, host: null, players: [], humanSeats: [], game: null
      };
      const me = this.addPlayer(body.hostName || 'ホスト');
      this.room.host = me.id;
      await this.save();
      return json({ ok: true, code: this.room.code, playerId: me.id, seat: me.seat, room: this.publicRoom() });
    }
    if (!this.room) return json({ error: 'room not found' }, 404);

    // --- join ---
    if (path === 'join') {
      if (this.room.started) return json({ error: 'already started' }, 400);
      const seatsTaken = this.room.players.length;
      if (seatsTaken >= this.room.pcount) return json({ error: 'room full' }, 400);
      const me = this.addPlayer(body.name || ('P' + (seatsTaken + 1)));
      await this.save();
      return json({ ok: true, playerId: me.id, seat: me.seat, room: this.publicRoom() });
    }

    // --- start (host): fill remaining seats with AI, deal ---
    if (path === 'start') {
      if (this.room.started) return json({ error: 'already started' }, 400);
      if (body.playerId !== this.room.host) return json({ error: 'only host can start' }, 403);
      this.dealNewGame();
      this.room.started = true;
      await this.save();
      return json({ ok: true, room: this.publicRoom() });
    }

    // --- restart: same room / same players, deal a fresh game ---
    if (path === 'restart') {
      if (!this.room.started) return json({ error: 'not started' }, 400);
      const isHost = body.playerId === this.room.host;
      const over = this.room.game && this.room.game.over;
      if (!isHost && !over) return json({ error: 'ホスト以外はゲーム終了後に再戦できます' }, 403);
      // allow host to change mission/pcount for the next game
      if (isHost && body.mission) this.room.mission = body.mission;
      this.dealNewGame();
      await this.save();
      return json({ ok: true, room: this.publicRoom() });
    }

    // --- state (per player view) ---
    if (path === 'state') {
      const pid = url.searchParams.get('playerId');
      const me = this.room.players.find(p => p.id === pid);
      const seat = me ? me.seat : -1;
      let view = null;
      if (this.room.started && this.room.game) {
        Engine.setState(this.room.game);
        view = seat >= 0 ? Engine.viewFor(seat) : Engine.viewFor(0);
        this.room.game = Engine.getState();
      }
      return json({ ok: true, started: this.room.started, you: seat, room: this.publicRoom(), view });
    }

    // --- action ---
    if (path === 'action') {
      const me = this.room.players.find(p => p.id === body.playerId);
      if (!me) return json({ error: 'unknown player' }, 403);
      if (!this.room.started) return json({ error: 'not started' }, 400);
      Engine.setState(this.room.game);
      const r = Engine.applyMove(me.seat, body.move || {}, this.room.humanSeats);
      this.room.game = Engine.getState();
      await this.save();
      return json({ ok: r.ok, err: r.err || null, view: r.ok ? this.viewSafe(me.seat) : null });
    }

    return json({ error: 'unknown route' }, 404);
  }

  dealNewGame() {
    const names = [];
    for (let s = 0; s < this.room.pcount; s++) {
      const human = this.room.players.find(p => p.seat === s);
      names.push(human ? human.name : 'AI-' + AI_NAMES[s % AI_NAMES.length]);
    }
    this.room.humanSeats = this.room.players.map(p => p.seat);
    Engine.createGame({ names, mission: this.room.mission, pcount: this.room.pcount });
    Engine.serverInfoStep(this.room.humanSeats);
    this.room.game = Engine.getState();
  }
  addPlayer(name) {
    const used = new Set(this.room.players.map(p => p.seat));
    let seat = 0; while (used.has(seat)) seat++;
    const p = { id: rid(8), name: String(name).slice(0, 16), seat };
    this.room.players.push(p);
    return p;
  }
  viewSafe(seat) { Engine.setState(this.room.game); const v = Engine.viewFor(seat); this.room.game = Engine.getState(); return v; }
  publicRoom() {
    return {
      code: this.room.code, mission: this.room.mission, pcount: this.room.pcount,
      started: this.room.started, host: this.room.host,
      players: this.room.players.map(p => ({ name: p.name, seat: p.seat }))
    };
  }
}
