const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');
const { createApp, allValues, allMeta, findPut } = require('./helpers/signalk-app');

const PRESSURE = 'environment.outside.pressure';
const TEMPERATURE = 'environment.inside.temperature';

// Configuration in the pre-0.8 format, which the plugin migrates on start.
function legacySettings() {
  return {
    limit: 10,
    restpaths: {
      pressure: {
        enabled: true,
        prefix: 'environment',
        label: 'outside.pressure',
        unit: 'Pa',
        interval: 60,
        source: 'rest.weather',
      },
      temperature: {
        enabled: true,
        prefix: 'environment',
        label: 'inside.temperature',
        unit: 'K',
        interval: 0,
        source: 'rest.indoor',
      },
    },
  };
}

function put(app, path, value) {
  const handler = findPut(app, path);
  assert.ok(handler, `no PUT handler registered for ${path}`);
  return handler.handler('vessels.self', path, value, () => {});
}

describe('plugin lifecycle', () => {
  let app;
  let plugin;

  before(() => {
    app = createApp();
    plugin = pluginFactory(app);
  });

  after(() => plugin.stop());

  it('migrates a legacy configuration and persists it on start', () => {
    plugin.start(legacySettings(), () => {});

    assert.deepEqual(app.statuses, ['Initializing', 'Initialized', 'Started']);
    assert.deepEqual(app.errors, []);

    assert.equal(app.savedOptions.length, 1);
    const saved = app.savedOptions[0];
    assert.ok(!('limit' in saved));
    assert.ok(!('restpaths' in saved));
    assert.deepEqual(saved.paths.map((p) => `${p.prefix}.${p.label}`), [PRESSURE, TEMPERATURE]);
    assert.ok(saved.paths.every((p) => p.debug === false));
  });

  it('announces the configured endpoints without a value', () => {
    assert.deepEqual(allValues(app), [
      { path: PRESSURE, value: null },
      { path: TEMPERATURE, value: null },
    ]);
  });

  it('registers the PUT handlers and publishes their meta', () => {
    plugin.registerWithRouter();

    assert.deepEqual(app.statuses.slice(-2), ['Registering', 'Registered: 2 paths active']);
    assert.deepEqual(app.putHandlers.map((h) => [h.context, h.path, h.source]), [
      ['vessels.self', PRESSURE, 'rest.weather'],
      ['vessels.self', TEMPERATURE, 'rest.indoor'],
    ]);
    assert.deepEqual(allMeta(app), [
      { path: PRESSURE, value: { units: 'Pa', timeout: 60 } },
      { path: TEMPERATURE, value: { units: 'K' } },
    ]);
  });

  it('accepts a PUT update and publishes it as a delta', () => {
    const result = put(app, PRESSURE, 101300);

    assert.deepEqual(result, { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(app.deltas.at(-1), {
      id: 'rest-provider-signalk',
      values: [{ path: PRESSURE, value: 101300 }],
    });
    assert.deepEqual(app.getSelfPath(PRESSURE), { value: 101300 });
    assert.deepEqual(app.errors, []);
  });

  it('uses a dedicated source id per configured endpoint', () => {
    const result = put(app, TEMPERATURE, 293.15);

    assert.deepEqual(result, { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(app.deltas.at(-1), {
      id: 'rest-provider-signalk.1',
      values: [{ path: TEMPERATURE, value: 293.15 }],
    });
  });

  it('rejects a value that does not match the type of the current value', () => {
    const before = app.deltas.length;
    const result = put(app, PRESSURE, 'much too high');

    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.statusCode, 400);
    assert.match(result.message, /Type mismatch/);
    assert.equal(app.deltas.length, before);
    assert.deepEqual(app.getSelfPath(PRESSURE), { value: 101300 });
  });

  it('ignores updates for unknown paths and other vessels', () => {
    const before = app.deltas.length;

    const unknown = plugin.handle('vessels.self', 'environment.wind.speedTrue', 7.5, () => {});
    assert.deepEqual(unknown, { state: 'COMPLETED', statusCode: 200 });

    const otherVessel = plugin.handle('vessels.urn:mrn:imo:mmsi:123456789', PRESSURE, 99000, () => {});
    assert.deepEqual(otherVessel, { state: 'COMPLETED', statusCode: 200 });

    assert.equal(app.deltas.length, before);
    assert.deepEqual(app.errors, []);
  });

  it('keeps serving the endpoints described by the OpenAPI document', () => {
    const api = plugin.getOpenApi();

    assert.deepEqual(Object.keys(api.paths), [
      '/environment/outside/pressure',
      '/environment/inside/temperature',
    ]);
    assert.equal(api.info.version, '1.0.0');
  });

  it('stops cleanly and reloads the persisted options', () => {
    const read = app.optionsRead;
    plugin.stop();

    assert.equal(app.optionsRead, read + 1);
    assert.deepEqual(app.errors, []);
  });

  it('restarts from the migrated configuration without migrating again', () => {
    const restarted = pluginFactory(app);
    const statuses = app.statuses.length;
    const deltas = app.deltas.length;

    restarted.start(app.options, () => {});
    restarted.registerWithRouter();

    assert.deepEqual(app.savedOptions.length, 1);
    assert.deepEqual(app.statuses.slice(statuses), [
      'Initializing',
      'Initialized',
      'Started',
      'Registering',
      'Registered: 2 paths active',
    ]);
    // the last known values are picked up from the server on restart
    assert.deepEqual(app.deltas.slice(deltas).flatMap((d) => d.values), [
      { path: PRESSURE, value: { value: 101300 } },
      { path: TEMPERATURE, value: { value: 293.15 } },
    ]);
    assert.deepEqual(app.errors, []);

    restarted.stop();
  });
});
