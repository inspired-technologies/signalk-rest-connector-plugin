'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');
const { createApp, allValues, allMeta, findPut } = require('./helpers/signalk-app');

// Configuration covering the cases the plugin has to distinguish: an enabled
// endpoint without a preset value, an enabled endpoint with one, an explicitly
// disabled endpoint and an incompletely defined endpoint.
function settings() {
  return {
    paths: [
      {
        enabled: true,
        prefix: 'environment',
        label: 'outside.pressure',
        unit: 'Pa',
        interval: 60,
        source: 'rest.weather',
      },
      {
        enabled: true,
        prefix: 'environment',
        label: 'inside.temperature',
        unit: 'K',
        interval: 0,
        source: 'rest.indoor',
        value: 293.15,
        debug: true,
      },
      {
        enabled: false,
        prefix: 'tanks',
        label: 'freshWater.0.currentLevel',
        unit: 'ratio',
        interval: 0,
        source: 'rest.tanks',
      },
      {
        enabled: true,
        prefix: '',
        label: 'nonsense',
        unit: '',
        interval: 0,
        source: 'rest.none',
      },
    ],
  };
}

function put(app, path, value) {
  const handler = findPut(app, path);
  assert.ok(handler, `no PUT handler registered for ${path}`);
  return handler.handler('vessels.self', path, value, () => {});
}

function started(config) {
  const app = createApp();
  const plugin = pluginFactory(app);
  plugin.start(config, () => {});
  return { app, plugin };
}

describe('plugin', () => {
  it('has required interface', () => {
    const plugin = pluginFactory(createApp());
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.equal(typeof plugin.registerWithRouter, 'function');
    assert.equal(typeof plugin.getOpenApi, 'function');
    assert.equal(plugin.id, 'rest-provider-signalk');
    assert.ok(plugin.name);
    assert.ok(plugin.description);
    assert.ok(plugin.schema);
  });

  it('describes the endpoint configuration in its schema', () => {
    const plugin = pluginFactory(createApp());
    const paths = plugin.schema.properties.paths;

    assert.equal(paths.type, 'array');
    assert.deepEqual(paths.items.required, ['prefix', 'label']);
    assert.deepEqual(
      Object.keys(paths.items.properties),
      ['enabled', 'prefix', 'label', 'unit', 'interval', 'source', 'debug'],
    );
    assert.ok(paths.items.properties.prefix.enum.includes('environment'));
    assert.equal(paths.items.properties.interval.default, 0);
    assert.equal(paths.items.properties.source.default, undefined);
    assert.match(paths.items.properties.unit.description, /km\/h, kn, mph, Bft → m\/s/);
    assert.match(plugin.schema.description, /readwrite/);
  });

  it('starts and stops cleanly without configuration', () => {
    const { app, plugin } = started({});

    assert.deepEqual(app.statuses, ['0 paths configured · 0 active']);
    assert.deepEqual(app.errors, []);
    assert.deepEqual(app.deltas, []);
    assert.deepEqual(app.savedOptions, []);

    plugin.stop();
    assert.deepEqual(app.errors, []);
  });

  it('registers PUT handlers on start for enabled and complete endpoints only', (t) => {
    const { app, plugin } = started(settings());
    t.after(() => plugin.stop());

    assert.deepEqual(app.errors, []);
    assert.deepEqual(app.putHandlers.map((h) => [h.context, h.path, h.source]), [
      ['vessels.self', 'environment.outside.pressure', 'rest.weather'],
      ['vessels.self', 'environment.inside.temperature', 'rest.indoor'],
    ]);
    assert.equal(findPut(app, 'tanks.freshWater.0.currentLevel'), undefined);
    assert.deepEqual(app.statuses, ['4 paths configured · 2 active']);
  });

  it('registers a handler without source under the plugin id', (t) => {
    const { app, plugin } = started({ paths: [{ enabled: true, prefix: 'environment', label: 'depth', unit: 'm' }] });
    t.after(() => plugin.stop());

    assert.equal(app.putHandlers[0].source, undefined);
  });

  it('publishes an initial delta and the meta per enabled endpoint', (t) => {
    const { app, plugin } = started(settings());
    t.after(() => plugin.stop());

    assert.deepEqual(allValues(app), [
      { path: 'environment.outside.pressure', value: null },
      { path: 'environment.inside.temperature', value: 293.15 },
    ]);
    assert.deepEqual(allMeta(app), [
      // the refresh interval is published as a timeout, 0 means "no timeout"
      { path: 'environment.outside.pressure', value: { units: 'Pa', timeout: 60 } },
      { path: 'environment.inside.temperature', value: { units: 'K' } },
    ]);
  });

  it('seeds an enabled endpoint with the value of the server', (t) => {
    const app = createApp();
    app.selfPaths['navigation.speedOverGround'] = { value: 3.4, $source: 'nmea.GP', timestamp: '2026-11-25T10:00:00Z' };
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start({
      paths: [{ enabled: true, prefix: 'navigation', label: 'speedOverGround', unit: 'm/s', source: 'rest.nav' }],
    }, () => {});

    // the value, not the whole node of the server's data model
    assert.deepEqual(allValues(app), [{ path: 'navigation.speedOverGround', value: 3.4 }]);
  });

  it('accepts a PUT update and publishes it under the source id of the endpoint', (t) => {
    const { app, plugin } = started(settings());
    t.after(() => plugin.stop());

    assert.deepEqual(put(app, 'environment.outside.pressure', 101300), { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(app.deltas.at(-1), { id: 'rest-provider-signalk', values: [{ path: 'environment.outside.pressure', value: 101300 }] });

    assert.deepEqual(put(app, 'environment.inside.temperature', 294), { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(app.deltas.at(-1), { id: 'rest-provider-signalk.1', values: [{ path: 'environment.inside.temperature', value: 294 }] });
    assert.deepEqual(app.errors, []);
  });

  it('accepts a PUT update for a path the server has no value for', (t) => {
    const app = createApp({ handleMessage: (id, message) => app.deltas.push({ id, values: message.updates[0].values }) });
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());
    plugin.start({ paths: [{ enabled: true, prefix: 'environment', label: 'depth', unit: 'm' }] }, () => {});

    // the server keeps no value - it crashed on the missing node before
    assert.deepEqual(put(app, 'environment.depth', 4.2), { state: 'COMPLETED', statusCode: 200 });
  });

  it('rejects a value that does not match the type of the current value', (t) => {
    const { app, plugin } = started(settings());
    t.after(() => plugin.stop());
    put(app, 'environment.outside.pressure', 101300);
    const before = app.deltas.length;

    const result = put(app, 'environment.outside.pressure', 'much too high');

    assert.equal(result.statusCode, 400);
    assert.equal(result.message, "Type mismatch: 'string' doesn't match 'number'");
    assert.equal(app.deltas.length, before);
  });

  it('exposes an OpenAPI document of the SignalK API paths of the enabled endpoints', (t) => {
    const { plugin } = started(settings());
    t.after(() => plugin.stop());
    const api = plugin.getOpenApi();

    assert.equal(api.openapi, '3.0.3');
    assert.deepEqual(api.servers, [{ url: '/signalk/v1/api' }]);
    assert.deepEqual(Object.keys(api.paths), [
      '/vessels/self/environment/outside/pressure',
      '/vessels/self/environment/inside/temperature',
    ]);
    const pressure = api.paths['/vessels/self/environment/outside/pressure'].put;
    assert.deepEqual(pressure.tags, ['environment']);
    assert.match(pressure.description, /'Pa'/);
    assert.ok(pressure.responses[403]);
    const schema = pressure.requestBody.content['application/json'].schema;
    assert.deepEqual(schema.required, ['value', 'source']);
    assert.equal(schema.properties.value.type, 'number');
  });
});

describe('unit conversion', () => {
  function converting(unit, extra = {}) {
    return started({ paths: [{ enabled: true, prefix: 'environment', label: 'wind.speedTrue', unit, source: 'rest.wind', ...extra }] });
  }

  it('converts values of a source unit and publishes the SignalK unit as meta', (t) => {
    const { app, plugin } = converting('km/h');
    t.after(() => plugin.stop());

    assert.deepEqual(allMeta(app), [{ path: 'environment.wind.speedTrue', value: { units: 'm/s' } }]);
    assert.deepEqual(put(app, 'environment.wind.speedTrue', 36), { state: 'COMPLETED', statusCode: 200 });
    assert.deepEqual(app.deltas.at(-1).values, [{ path: 'environment.wind.speedTrue', value: 10 }]);

    const api = plugin.getOpenApi().paths['/vessels/self/environment/wind/speedTrue'].put;
    assert.match(api.description, /in 'km\/h' - published in 'm\/s'/);
  });

  it('converts numbers sent as text and rejects text that is no number', (t) => {
    const { app, plugin } = converting('hPa');
    t.after(() => plugin.stop());

    put(app, 'environment.wind.speedTrue', '1013.5');
    assert.deepEqual(app.deltas.at(-1).values, [{ path: 'environment.wind.speedTrue', value: 101350 }]);

    const result = put(app, 'environment.wind.speedTrue', 'calm');
    assert.equal(result.statusCode, 400);
    assert.equal(result.message, "Value 'calm' is not a number (unit 'hPa')");
  });

  it('converts a preset value', (t) => {
    const { app, plugin } = converting('kn', { value: 10 });
    t.after(() => plugin.stop());

    assert.ok(Math.abs(allValues(app)[0].value - 5.144444) < 1e-5);
  });

  it('passes SignalK units, unknown units and deg through unchanged', (t) => {
    for (const unit of ['m/s', 'V', 'deg']) {
      const { app, plugin } = converting(unit);
      t.after(() => plugin.stop());

      assert.deepEqual(allMeta(app), [{ path: 'environment.wind.speedTrue', value: { units: unit } }]);
      put(app, 'environment.wind.speedTrue', 12.5);
      assert.deepEqual(app.deltas.at(-1).values, [{ path: 'environment.wind.speedTrue', value: 12.5 }]);
    }
  });
});
