/* ============================================================
   Bomb Busters — Cloudflare Worker + Durable Object (game room)
   - One Durable Object instance per room (holds all hands = the "dealer").
   - Polling based (turn-based game): clients GET state and POST actions.
   - Each player only ever receives their own hand (viewFor masks the rest).
   - Disconnect handling: a human who stops polling (>DISCONNECT_MS) is treated
     as AI for their turns; when they poll again they resume control (rejoin).
   - The room auto-deletes after ROOM_TTL of inactivity (Durable Object alarm).
   ============================================================ */
import Engine from './engine.js';

const AI_NAMES = ['アオイ', 'ユメ', 'リク', 'ケン'];
const DISCONNECT_MS = 9000;            // no poll for this long => treated as disconnected
const ROOM_TTL = 6 * 60 * 60 * 1000;   // delete room 6h after last activity
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const rid = (n = 4) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS')
      return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' } });

    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const code = rid();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(new Request(url.origin + '/create', { method: 'POST', body: JSON.stringify({ code, ...(await request.json().catch(() => ({}))) }) }));
    }
    const m = url.pathname.match(/^\/api\/room\/([A-Z0-9]+)\/(\w+)$/);
    if (m) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(new Request(url.origin + '/' + m[2] + url.search, { method: request.method, body: request.method === 'POST' ? await request.text() : undefined }));
    }
    return json({ error: 'not found' }, 404);
  }
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.dirty = false;        // 状態が変わったときだけ保存する
    this.lastSaveTs = 0;
  }

  async load() {
    if (this.room === null) this.room = (await this.state.storage.get('room')) || null;
    return this.room;
  }
  async save() {
    await this.state.storage.put('room', this.room);
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL);
    this.dirty = false;
    this.lastSaveTs = Date.now();
  }
  async alarm() {            // inactivity cleanup
    await this.state.storage.deleteAll();
    this.room = null;
  }

  touch(pid) { if (pid && this.room.lastSeen) this.room.lastSeen[pid] = Date.now(); }
  activeHumans() {
    const now = Date.now();
    return this.room.players.filter(p => (this.room.lastSeen[p.id] || 0) > now - DISCONNECT_MS).map(p => p.seat);
  }
  // advance any AI / disconnected-human turns until an active human's turn (or game over)
  advanceBots() {
    if (!this.room.started || !this.room.game) return;
    const before = JSON.stringify(this.room.game);
    Engine.setState(this.room.game);
    Engine.stepAI(this.activeHumans());
    this.room.game = Engine.getState();
    if (JSON.stringify(this.room.game) !== before) this.bumpRev();
  }
  bumpRev() { this.room.rev = (this.room.rev || 0) + 1; this.dirty = true; }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\//, '');
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    await this.load();

    if (path === 'create') {
      this.room = {
        code: body.code, mission: body.mission || '4', pcount: Math.min(5, Math.max(4, body.pcount || 4)),
        started: false, host: null, players: [], humanSeats: [], game: null, lastSeen: {}, rev: 1
      };
      const me = this.addPlayer(body.hostName || 'ホスト');
      this.room.host = me.id; this.touch(me.id);
      await this.save();
      return json({ ok: true, code: this.room.code, playerId: me.id, seat: me.seat, room: this.publicRoom() });
    }
    if (!this.room) return json({ error: 'room not found' }, 404);
    if (!this.room.lastSeen) this.room.lastSeen = {};

    if (path === 'join') {
      if (this.room.started) return json({ error: 'already started' }, 400);
      if (this.room.players.length >= this.room.pcount) return json({ error: 'room full' }, 400);
      const me = this.addPlayer(body.name || ('P' + (this.room.players.length + 1)));
      this.touch(me.id);
      await this.save();
      return json({ ok: true, playerId: me.id, seat: me.seat, room: this.publicRoom() });
    }

    if (path === 'start') {
      if (this.room.started) return json({ error: 'already started' }, 400);
      if (body.playerId !== this.room.host) return json({ error: 'only host can start' }, 403);
      this.touch(body.playerId);
      this.dealNewGame();
      this.room.started = true;
      await this.save();
      return json({ ok: true, room: this.publicRoom() });
    }

    if (path === 'restart') {
      if (!this.room.started) return json({ error: 'not started' }, 400);
      const isHost = body.playerId === this.room.host;
      const over = this.room.game && this.room.game.over;
      if (!isHost && !over) return json({ error: 'ホスト以外はゲーム終了後に再戦できます' }, 403);
      if (isHost && body.mission) this.room.mission = body.mission;
      this.touch(body.playerId);
      this.dealNewGame();
      await this.save();
      return json({ ok: true, room: this.publicRoom() });
    }

    if (path === 'state') {
      const pid = url.searchParams.get('playerId');
      const me = this.room.players.find(p => p.id === pid);
      this.touch(pid);
      this.advanceBots();                      // let AI / disconnected players take their turns
      const seat = me ? me.seat : -1;
      let view = null;
      if (this.room.started && this.room.game) {
        Engine.setState(this.room.game);
        view = Engine.viewFor(seat);      // seat=-1（観戦・不明ID）は全手札マスク
        this.room.game = Engine.getState();
      }
      // ポーリングごとの書き込みをやめ、状態変化時＋30秒周期のみ保存
      if (this.dirty || Date.now() - this.lastSaveTs > 30000) await this.save();
      return json({ ok: true, started: this.room.started, you: seat, room: this.publicRoom(), view, rev: this.room.rev || 0 });
    }

    if (path === 'action') {
      const me = this.room.players.find(p => p.id === body.playerId);
      if (!me) return json({ error: 'unknown player' }, 403);
      if (!this.room.started) return json({ error: 'not started' }, 400);
      this.touch(body.playerId);
      // 楽観的ロック: クライアントが古い盤面から操作した場合は拒否（rev未送信の旧クライアントは素通し）
      if (body.rev !== undefined && body.rev !== (this.room.rev || 0))
        return json({ ok: false, err: '盤面が更新されました。最新の状態を確認してから操作してください', stale: true, rev: this.room.rev || 0 });
      Engine.setState(this.room.game);
      const r = Engine.applyMove(me.seat, body.move || {}, this.activeHumans());
      this.room.game = Engine.getState();
      if (r.ok) this.bumpRev();
      await this.save();
      return json({ ok: r.ok, err: r.err || null, view: r.ok ? this.viewSafe(me.seat) : null, rev: this.room.rev || 0 });
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
    Engine.serverInfoStep(this.activeHumans());
    this.room.game = Engine.getState();
    this.bumpRev();
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
    const now = Date.now();
    return {
      code: this.room.code, mission: this.room.mission, pcount: this.room.pcount,
      started: this.room.started, host: this.room.host,
      players: this.room.players.map(p => {
        const connected = (this.room.lastSeen[p.id] || 0) > now - DISCONNECT_MS;
        return { name: p.name, seat: p.seat, connected, bot: this.room.started && !connected };
      })
    };
  }
}
