'use strict';

// Minimal stand-in for the SignalK server app object. Every member used by
// index.js has to be present, otherwise the plugin fails at startup.
// Deltas handled by the server are fed back into the self store, so that
// app.getSelfPath() behaves like a real server: data paths resolve to a value
// object once a delta has been published for them.
function createApp(overrides = {}) {
  const app = {
    deltas: [],
    metas: [],
    statuses: [],
    errors: [],
    putHandlers: [],
    savedOptions: [],
    options: {},
    selfPaths: {},
    optionsRead: 0,

    debug: () => {},
    error: (msg) => app.errors.push(msg),
    setPluginStatus: (msg) => app.statuses.push(msg),
    setPluginError: (msg) => app.errors.push(msg),

    getSelfPath: (path) => app.selfPaths[path],

    registerPutHandler: (context, path, handler, source) => {
      app.putHandlers.push({ context, path, handler, source });
    },

    handleMessage: (id, message) => {
      const update = message.updates[0];
      if (update.values) {
        app.deltas.push({ id, values: update.values });
        update.values.forEach((v) => {
          app.selfPaths[v.path] = { value: v.value };
        });
      }
      if (update.meta) {
        app.metas.push({ id, meta: update.meta });
      }
    },

    readPluginOptions: () => {
      app.optionsRead += 1;
      return { configuration: app.options };
    },

    savePluginOptions: (settings, callback) => {
      app.options = settings;
      app.savedOptions.push(JSON.parse(JSON.stringify(settings)));
      if (callback) callback();
    },

    ...overrides,
  };
  return app;
}

// Flattens every value of every delta the plugin has sent so far.
function allValues(app) {
  return app.deltas.flatMap((d) => d.values);
}

// Flattens every meta entry the plugin has sent so far.
function allMeta(app) {
  return app.metas.flatMap((m) => m.meta);
}

function findPut(app, path) {
  return app.putHandlers.find((h) => h.path === path);
}

module.exports = { createApp, allValues, allMeta, findPut };
