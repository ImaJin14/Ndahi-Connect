import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { correlation, withCorrelation, correlationHeaders } from '../lib/correlation.mjs';
import { createLogger, errorFields } from '../lib/logger.mjs';
import { createStore } from '../server.mjs';
import { enqueueRouterCommand, createRouterCommandProcessor } from '../lib/router-queue.mjs';

test('concurrent async operations retain separate correlation contexts', async () => {
  const ids = [randomUUID(), randomUUID()];
  await Promise.all(ids.map(id => withCorrelation({ correlationId: id }, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(correlation().correlationId, id);
    assert.deepEqual(correlationHeaders(), { 'x-correlation-id': id });
  })));
  assert.deepEqual(correlation(), {});
});

test('router jobs restore the durable operation ID during later worker execution', async () => {
  const id = randomUUID(), store = createStore({ persistent: false });
  await withCorrelation({ correlationId: id }, () => store.transaction(s => enqueueRouterCommand(s, { action: 'mark_inactive' })));
  const lines = [];
  const logger = createLogger({ service: 'api', write: (_, line) => lines.push(JSON.parse(line)) });
  const processor = createRouterCommandProcessor({ store, logger, router: { markInactive: async () => {
    assert.equal(correlation().correlationId, id);
    return { ok: true };
  } } });
  await processor.run();
  assert.equal(lines.find(line => line.event === 'network.command_completed').correlationId, id);
  assert.deepEqual(correlation(), {});
});

test('error fields exclude provider messages containing names and PINs', () => {
  const fields = errorFields(Object.assign(new Error('PIN 8642 for Alice rejected'), { code: 'E_PROVIDER' }));
  assert.deepEqual(fields, { errorName: 'Error', code: 'E_PROVIDER' });
});

test('dead-lettered router commands still emit failure logs when metrics are enabled', async () => {
  const store = createStore({ persistent: false }), lines = [];
  await store.transaction(s => enqueueRouterCommand(s, { action: 'mark_inactive' }));
  let deadLetters = 0;
  const processor = createRouterCommandProcessor({ store, maxAttempts: 1,
    logger: createLogger({ service: 'api', write: (_, line) => lines.push(JSON.parse(line)) }),
    metrics: { commandDeadLettered: () => deadLetters++ },
    router: { markInactive: async () => { throw Error('unreachable'); } },
  });
  await processor.run();
  assert.equal(deadLetters, 1);
  const failure = lines.find(line => line.event === 'network.command_failed');
  assert.equal(failure.level, 'error');
  assert.equal(failure.state, 'dead_letter');
});
