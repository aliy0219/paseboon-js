// Port of the Python reference tests/test_agent.py.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Agent } from '../src/core/agent.js';
import { Action, Policy, Result, makeSettings } from '../src/core/policy.js';

class FakeClock {
  constructor() { this.t = 1000.0; }
  now = () => this.t;
  sleep = async (s) => { this.t += s; };
}

class FakePlatform {
  constructor({ idle = 999.0, lockSticks = true, canTell = true, fallbackSticks = false } = {}) {
    Object.assign(this, { idle, lockSticks, canTell, fallbackSticks });
    this.locked = false;
    this.lockCalls = 0;
    this.fallbackCalls = 0;
    this.notes = [];
  }
  idleSeconds() { return this.idle; }
  async isLocked() { return this.canTell ? this.locked : null; }
  async lock() { this.lockCalls += 1; this.locked = this.lockSticks; return true; }
  async fallbackLock() { this.fallbackCalls += 1; this.locked = this.locked || this.fallbackSticks; return true; }
  notify(text) { this.notes.push(text); }
}

const quiet = { info() {}, warn() {}, error() {} };

function make(plat, results, kw = {}) {
  const clock = new FakeClock();
  const seq = results[Symbol.iterator]();
  const agent = new Agent(plat, new Policy(makeSettings(kw)),
    async () => ({ result: seq.next().value }), { clock: clock.now, sleep: clock.sleep, log: quiet });
  return { agent, clock };
}

async function runTicks(agent, clock, n) {
  const actions = [];
  for (let i = 0; i < n; i += 1) {
    actions.push(await agent.tick());
    await clock.sleep(1.0);
  }
  return actions;
}

const flush = () => new Promise((r) => setImmediate(r));

test('two empty checks lock and verify', async () => {
  const plat = new FakePlatform();
  const { agent, clock } = make(plat, [Result.ABSENT, Result.ABSENT]);
  const actions = await runTicks(agent, clock, 10);
  assert.equal(actions.filter((a) => a === Action.LOCK).length, 1);
  assert.equal(plat.lockCalls, 1);
  assert.equal(plat.fallbackCalls, 0);
});

test('failed lock uses fallback and notifies once', async () => {
  const plat = new FakePlatform({ lockSticks: false, fallbackSticks: false });
  const { agent, clock } = make(plat, [Result.ABSENT, Result.ABSENT]);
  await runTicks(agent, clock, 60);
  assert.equal(plat.lockCalls, 1); // no retry loop
  assert.equal(plat.fallbackCalls, 1);
  assert.equal(plat.notes.length, 1);
});

test('fallback that sticks is accepted', async () => {
  const plat = new FakePlatform({ lockSticks: false, fallbackSticks: true });
  const { agent, clock } = make(plat, [Result.ABSENT, Result.ABSENT]);
  await runTicks(agent, clock, 10);
  assert.equal(plat.locked, true);
  assert.deepEqual(plat.notes, []);
});

test('unknown lock state also fires fallback', async () => {
  const plat = new FakePlatform({ canTell: false });
  const { agent, clock } = make(plat, [Result.ABSENT, Result.ABSENT]);
  await runTicks(agent, clock, 30);
  assert.equal(plat.lockCalls, 1);
  assert.equal(plat.fallbackCalls, 1);
});

test('owner present never locks', async () => {
  const plat = new FakePlatform();
  const { agent, clock } = make(plat, Array(100).fill(Result.OWNER));
  await runTicks(agent, clock, 600);
  assert.equal(plat.lockCalls, 0);
});

test('camera error notifies once then idle lock', async () => {
  const plat = new FakePlatform({ idle: 60.0 });
  const { agent, clock } = make(plat, Array(100).fill(Result.CAMERA_ERROR), { cameraFailIdle: 120 });
  for (let i = 0; i < 100; i += 1) {
    await agent.tick();
    await clock.sleep(1.0);
    plat.idle += 1.0;
    if (plat.locked) break;
  }
  await flush();
  assert.equal(plat.locked, true);
  assert.equal(plat.notes.length, 1);
});

test('paused agent does nothing', async () => {
  const plat = new FakePlatform();
  const { agent, clock } = make(plat, [Result.ABSENT, Result.ABSENT]);
  agent.paused = true;
  const actions = await runTicks(agent, clock, 30);
  assert.ok(actions.every((a) => a === Action.NONE));
  assert.equal(plat.lockCalls, 0);
});

test('run() stops after too many consecutive errors', async () => {
  const plat = new FakePlatform();
  plat.isLocked = async () => { throw new Error('boom'); };
  const { agent } = make(plat, []);
  await assert.rejects(agent.run(), /boom/);
});
