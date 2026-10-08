const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pluginFactory = require('../index');
const { createApp, allValues, allMeta, findPut } = require('./helpers/signalk-app');

// Configuration covering the four cases the plugin has to distinguish:
// an enabled endpoint without a preset value, an enabled endpoint with one,
// an explicitly disabled endpoint and an incompletely defined endpoint.
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
        prefix: '',
        label: 'nonsense',
        unit: '',
        interval: 0,
        source: 'rest.none',
      },
    ],
  };
}

describe('plugin', () => {
  it('has required interface', () => {
    const plugin = pluginFactory(createApp());
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.equal(typeof plugin.init, 'function');
    assert.equal(typeof plugin.registerWithRouter, 'function');
    assert.equal(typeof plugin.handle, 'function');
    assert.equal(typeof plugin.getOpenApi, 'function');
    assert.ok(plugin.id);
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
  });

  it('starts and stops cleanly without configuration', () => {
    const app = createApp();
    const plugin = pluginFactory(app);

    plugin.start({}, () => {});

    assert.deepEqual(app.statuses, ['Started']);
    assert.deepEqual(app.errors, []);
    assert.deepEqual(app.deltas, []);
    assert.deepEqual(app.savedOptions, []);

    plugin.stop();
    assert.equal(app.optionsRead, 1);
    assert.deepEqual(app.errors, []);
  });

  it('skips disabled and incomplete endpoint definitions', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start(settings(), () => {});
    plugin.registerWithRouter();

    assert.deepEqual(app.errors, []);
    assert.deepEqual(app.putHandlers.map((h) => h.path), [
      'environment.outside.pressure',
      'environment.inside.temperature',
    ]);
    assert.equal(findPut(app, 'tanks.freshWater.0.currentLevel'), undefined);
    assert.equal(allValues(app).length, 2);
  });

  it('publishes an initial delta per enabled endpoint', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start(settings(), () => {});

    assert.deepEqual(app.statuses, ['Initializing', 'Initialized', 'Started']);
    assert.deepEqual(allValues(app), [
      { path: 'environment.outside.pressure', value: null },
      { path: 'environment.inside.temperature', value: 293.15 },
    ]);
  });

  it('seeds an enabled endpoint from the current server value', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    // the server already holds a reading, which is forwarded as-is
    app.selfPaths['navigation.speedOverGround'] = { value: 3.4 };
    plugin.start({
      paths: [{
        enabled: true,
        prefix: 'navigation',
        label: 'speedOverGround',
        unit: 'm/s',
        interval: 0,
        source: 'rest.nav',
      }],
    }, () => {});

    assert.deepEqual(allValues(app), [
      { path: 'navigation.speedOverGround', value: { value: 3.4 } },
    ]);
  });

  it('registers PUT handlers and publishes meta for enabled endpoints', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start(settings(), () => {});
    plugin.registerWithRouter();

    assert.equal(app.statuses.at(-1), 'Registered: 2 paths active');

    const pressure = findPut(app, 'environment.outside.pressure');
    assert.equal(pressure.context, 'vessels.self');
    assert.equal(pressure.source, 'rest.weather');
    assert.equal(typeof pressure.handler, 'function');

    assert.deepEqual(allMeta(app), [
      // the refresh interval is published as a timeout, 0 means "no timeout"
      { path: 'environment.outside.pressure', value: { units: 'Pa', timeout: 60 } },
      { path: 'environment.inside.temperature', value: { units: 'K' } },
    ]);
  });

  it('exposes an OpenAPI document describing the enabled endpoints', (t) => {
    const app = createApp();
    const plugin = pluginFactory(app);
    t.after(() => plugin.stop());

    plugin.start(settings(), () => {});
    const api = plugin.getOpenApi();

    assert.equal(api.openapi, '3.0.3');
    assert.equal(api.info.title, plugin.name);
    assert.deepEqual(api.tags, [{ name: plugin.id }]);
    assert.deepEqual(Object.keys(api.paths), [
      '/environment/outside/pressure',
      '/environment/inside/temperature',
    ]);

    const pressure = api.paths['/environment/outside/pressure'].put;
    assert.deepEqual(pressure.tags, ['environment']);
    assert.match(pressure.description, /'Pa'/);
    const schema = pressure.requestBody.content['application/json'].schema;
    assert.deepEqual(schema.required, ['value', 'source']);
    assert.equal(schema.properties.value.type, 'number');
    // the preset value determines the documented payload type
    assert.equal(
      api.paths['/environment/inside/temperature'].put.requestBody
        .content['application/json'].schema.properties.value.type,
      'number',
    );
  });
});