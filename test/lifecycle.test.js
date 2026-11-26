'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');
const { createApp, allValues, allMeta, findPut } = require('./helpers/signalk-app');

const PRESSURE = 'environment.outside.pressure';
const TEMPERATURE = 'environment.inside.temperature';
const WIND = 'environment.wind.speedTrue';

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

// As the server: PUT handlers registered by a plugin are removed when it stops,
// a configuration save stops and starts the same plugin object.
function stop(app, plugin) {
  plugin.stop();
  app.putHandlers = [];
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

    assert.deepEqual(app.statuses, ['2 paths configured · 2 active']);
    assert.deepEqual(app.errors, []);

    assert.equal(app.savedOptions.length, 1);
    const saved = app.savedOptions[0];
    assert.ok(!('limit' in saved));
    assert.ok(!('restpaths' in saved));
    assert.deepEqual(saved.paths.map((p) => `${p.prefix}.${p.label}`), [PRESSURE, TEMPERATURE]);
    assert.ok(saved.paths.every((p) => p.debug === false));
  });

  it('announces the configured endpoints without a value and publishes their meta', () => {
    assert.deepEqual(allValues(app), [
      { path: PRESSURE, value: null },
      { path: TEMPERATURE, value: null },
    ]);
    assert.deepEqual(allMeta(app), [
      { path: PRESSURE, value: { units: 'Pa', timeout: 60 } },
      { path: TEMPERATURE, value: { units: 'K' } },
    ]);
  });

  it('accepts PUT updates right after start', () => {
    assert.deepEqual(put(app, PRESSURE, 101300), { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(put(app, TEMPERATURE, 293.15), { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(app.getSelfPath(PRESSURE), { value: 101300 });
  });

  it('serves the PUT endpoints again after a configuration save restarted it', () => {
    stop(app, plugin);
    assert.equal(findPut(app, PRESSURE), undefined);

    const statuses = app.statuses.length;
    const deltas = app.deltas.length;
    const config = app.options;
    config.paths.push({ enabled: true, prefix: 'environment', label: 'wind.speedTrue', unit: 'kn', source: 'rest.wind' });
    plugin.start(config, () => {});

    // no second migration, no duplicated paths
    assert.equal(app.savedOptions.length, 1);
    assert.deepEqual(app.statuses.slice(statuses), ['3 paths configured · 3 active']);
    assert.deepEqual(app.putHandlers.map((h) => h.path), [PRESSURE, TEMPERATURE, WIND]);
    // the last known values are picked up from the server on restart
    assert.deepEqual(app.deltas.slice(deltas)[0].values, [
      { path: PRESSURE, value: 101300 },
      { path: TEMPERATURE, value: 293.15 },
      { path: WIND, value: null },
    ]);
    assert.deepEqual(put(app, WIND, 10), { state: 'COMPLETED', statusCode: 200 });
    assert.ok(Math.abs(app.getSelfPath(WIND).value - 5.144444) < 1e-5);
    assert.deepEqual(app.errors, []);
  });

  it('keeps the OpenAPI document served by the server up to date', () => {
    const api = plugin.getOpenApi();
    assert.deepEqual(Object.keys(api.paths), [
      '/vessels/self/environment/outside/pressure',
      '/vessels/self/environment/inside/temperature',
      '/vessels/self/environment/wind/speedTrue',
    ]);

    stop(app, plugin);
    plugin.start({ paths: [app.options.paths[0]] }, () => {});
    // the same object, read by the server at plugin registration
    assert.equal(plugin.getOpenApi(), api);
    assert.deepEqual(Object.keys(api.paths), ['/vessels/self/environment/outside/pressure']);
  });

  it('registers no handlers once all paths are disabled', () => {
    stop(app, plugin);
    plugin.start({ paths: app.options.paths.map((p) => ({ ...p, enabled: false })) }, () => {});

    assert.deepEqual(app.putHandlers, []);
    assert.equal(app.statuses.at(-1), '3 paths configured · 0 active');
  });
});
