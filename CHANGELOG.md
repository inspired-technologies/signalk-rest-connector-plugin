# Change Log

Releases 0.5 - 0.7.5 are not documented here.

## [0.8.0]

### Fix
- PUT handlers are registered on every plugin start - they were registered once, when the server loaded the plugin, while the server removes them on every stop: after saving the configuration, or enabling the plugin after the server started, no path accepted PUT requests until the server was restarted.
- Restarting the plugin no longer duplicates the configured paths.
- A path is seeded with the current value of the server - the whole entry of the data model (value, source, timestamp) was published as value.
- A PUT request for a path without value on the server no longer fails with an exception.
- The OpenAPI description lists the paths of the SignalK API (`/vessels/self/...`) and follows configuration changes; it is available also when the plugin is enabled after the server started.
- The debug log is enabled with the *Debug log* switch of the plugin (namespace `rest-provider-signalk`).
- Configuration defaults: refresh rate 0 instead of empty, no `"undefined"` text as data source.

### Feature
- Unit conversion with the shared `skunits.js`: the unit of a path can be the unit the values are sent in - km/h, kn, mph, Bft, °C, °F, °, hPa, mbar, kPa, inHg, mmHg, psi, km, nm, mi, ft, cm, %, l, gal, rpm, Ah, Wh, kWh, h, min are converted to their SignalK unit, which is published as meta. Any other unit is published unchanged, as before. **Note:** a path configured with one of these units so far published the values as received with that unit as meta - it now publishes them converted, with the SignalK unit (the measured quantity stays the same, eg. 10 kn → 5.14 m/s). Clients were expected to send SignalK units anyway.
- The plugin status shows the number of configured and active paths.
- README: PUT requests need a user or device with readwrite (or admin) permission, the server's ACLs apply.

### Update
- Package updates.
- Release to NPM via npm trusted publishing (OIDC) on a push to `main`, no npm token; the package contents are whitelisted (`files`), tests and repository files are no longer published.
- SignalK Plugin CI and automated tests (`npm test`): plugin, lifecycle and unit tests against a stubbed server app.

## [0.3]
- Added propulsion as base path

## [0.2]
- Include metas for units and timeout
