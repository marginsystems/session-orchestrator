'use strict';

const startDemo = function () {
  const Rn = rng(Number(Q.get('seed')) || 7);
  const rooms = [{ id: 'dashboard', label: 'dashboard' }, { id: 'gateway', label: 'gateway' }, { id: 'infra', label: 'infra' }, { id: 'docs', label: 'docs' }];
  const who = [['Fern', 'gateway', 'working', 'Fix flaky test'], ['Moss', 'gateway', 'idle', 'Update docs'], ['Juniper', 'gateway', 'waiting', 'Review PR'], ['Pebble', 'dashboard', 'working', 'Refactor parser'], ['Sage', 'dashboard', 'working', 'Add retry logic'], ['Wren', 'dashboard', 'idle', 'Bump deps'], ['Basil', 'docs', 'idle', 'Write changelog'], ['Cedar', 'docs', 'working', 'Tune query'], ['Clover', 'infra', 'waiting', 'Trace slow call'], ['Ash', 'infra', 'idle', 'Clean up types']];
  let seq = 0;
  const agents = who.map(([name, room, state, title]) => ({ id: 'd_' + name.toLowerCase(), name, room, state, title, since: state === 'waiting' ? ++seq : 0, sleepy: name === 'Basil', perm: name === 'Moss' ? 'auto' : name === 'Ash' ? '' : 'bypass', approval: name === 'Ash' }));
  let pendingEvents = [];
  const push = () => { const events = pendingEvents; pendingEvents = []; applyState({ rooms, agents, events, generatedAt: Date.now() }); };
  push();
  const pick = (arr) => arr[Math.floor(Rn() * arr.length)];
  const movers = () => activeMovers();
  let night = false;
  spawn((function* () {
    for (;;) {
      yield* wait(2.2 + Rn() * 2.8);
      if (night) continue;
      const a = pick(agents);
      if (a.approval) continue;
      const working = agents.filter((x) => x.state === 'working').length;
      if (a.state === 'working') a.state = Rn() < 0.5 && working > 2 ? 'waiting' : 'idle';
      else a.state = 'working';
      a.since = a.state === 'waiting' ? ++seq : 0;
      a.sleepy = a.state === 'idle' && Rn() < 0.3;
      push();
    }
  })());
  spawn((function* () {
    yield* wait(1.2);
    for (;;) {
      const free = agents.filter((x) => { const o = S.agents.get(x.id); return o && !o.away; });
      if (free.length > 1 && !night && movers() < 3) {
        const from = pick(free);
        const others = agents.filter((x) => x !== from);
        const far = others.filter((x) => x.room !== from.room);
        startTrip(from.id, (Rn() < 0.75 ? pick(far) : pick(others)).id, pick(TEXTS));
      }
      yield* wait(3 + Rn() * 2.5);
    }
  })());
  if (AUTOFOCUS) spawn((function* () {
    let i = 0;
    yield* wait(5);
    for (;;) {
      yield* until(() => !night && !UI.tour && S.want.length > 0 && movers() < 3);
      const id = S.want[0];
      const target = agents.find((x) => x.id === id);
      setFocus(id, 'demo' + i++);
      yield* wait(9 + Rn() * 3);
      if (target) { target.state = 'working'; target.since = 0; target.sleepy = false; push(); }
      setFocus(null);
      yield* wait(3);
    }
  })());
  const NEWBIES = ['Quill', 'Nettle', 'Poppy', 'Linden', 'Aspen', 'Heron', 'Finch', 'Lark'];
  const NEWROOMS = ['billing', 'search', 'mobile', 'auth'];
  const TITLES = ['Add pagination', 'Fix typo', 'Profile startup', 'Port tests'];
  let nx = 0;
  const extras = [];
  const addAgent = (newProject) => {
    let room;
    if (newProject && rooms.length < 6) {
      room = { id: 'proj' + nx, label: NEWROOMS[nx % NEWROOMS.length] };
      rooms.push(room);
    } else {
      const open = rooms.filter((r) => agents.filter((x) => x.room === r.id).length < 5);
      room = pick(open.length ? open : rooms);
    }
    const name = NEWBIES[nx % NEWBIES.length] + (nx >= NEWBIES.length ? ' ' + Math.floor(nx / NEWBIES.length + 1) : '');
    const ag = { id: 'dn_' + nx, name, room: room.id, state: 'working', title: TITLES[nx % TITLES.length], since: 0, sleepy: false, perm: 'bypass', approval: false };
    agents.push(ag); extras.push(ag);
    pendingEvents.push({ id: 'jn' + nx, kind: 'join', agentId: ag.id, at: Date.now() });
    nx++;
    push();
    return ag.id;
  };
  const CORE = ['dashboard', 'gateway', 'infra', 'docs'];
  const retire = () => {
    const ag = extras.find((x) => !CORE.includes(x.room)) || extras[0];
    if (!ag) return;
    extras.splice(extras.indexOf(ag), 1);
    agents.splice(agents.indexOf(ag), 1);
    if (!agents.some((x) => x.room === ag.room) && !CORE.includes(ag.room)) rooms.splice(rooms.findIndex((r) => r.id === ag.room), 1);
    push();
  };
  window['__demoJoin'] = (np) => addAgent(!!np);
  if (SIM) spawn((function* () {
    yield* wait(22);
    for (;;) {
      yield* until(() => !night && !UI.tour && movers() < 3);
      addAgent(nx % 3 === 2);
      yield* wait(24 + Rn() * 8);
      if (extras.length >= 3) { yield* until(() => !S.focusVisitor && movers() < 3); retire(); }
    }
  })());
  if (SIM) spawn((function* () {
    yield* wait(11);
    for (;;) {
      yield* until(() => !night && !UI.tour && movers() < 3 && !S.focusVisitor);
      const ready = agents.filter((x) => { const o = S.agents.get(x.id); return o && !o.away && !o.joining && x.state === 'working'; });
      if (ready.length) pushVisit(pick(ready).id);
      yield* wait(15 + Rn() * 8);
    }
  })());
  spawn((function* () {
    for (;;) {
      yield* wait(75);
      night = true;
      for (const a of agents) { a.state = 'idle'; a.since = 0; a.sleepy = Rn() < 0.5; }
      push();
      yield* wait(16);
      night = false;
      for (const a of agents) if (Rn() < 0.6) { a.state = 'working'; a.sleepy = false; }
      push();
    }
  })());
};
