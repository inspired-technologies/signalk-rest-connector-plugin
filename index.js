'use strict'
const log = require('debug')('rest-provider-signalk')
const units = require('./skunits')

/*
    Units of received values converted to their SignalK unit with the shared skunits.js - any other unit,
    a SignalK unit included, is published unchanged. Fixed list, verified against skunits.js by the tests.
    'deg' is not converted: skunits treats it as °C, SignalK as angle (cohort backlog topic).
*/
const SOURCE_UNITS = {
    'm/s': ['km/h', 'kn', 'mph', 'Bft'],
    'K': ['°C', '°F'],
    'rad': ['°', 'degrees'],
    'Pa': ['hPa', 'mbar', 'kPa', 'inHg', 'mmHg', 'psi'],
    'm': ['km', 'nm', 'mi', 'ft', 'cm'],
    'ratio': ['%'],
    'm3': ['l', 'gal'],
    'Hz': ['rpm'],
    'C': ['Ah'],
    'J': ['Wh', 'kWh'],
    's': ['h', 'min'],
}
const CONVERTIBLE = new Set(Object.values(SOURCE_UNITS).flat())
const UNIT_DESCRIPTION = 'SignalK unit of the path (meta units), or the unit of the received values if it is one of ' +
    Object.entries(SOURCE_UNITS).map(([sk, list]) => `${list.join(', ')} → ${sk}`).join('; ') +
    ' (nm: nautical miles) - those are converted to the SignalK unit. Any other unit is published unchanged.'

const ROOTS = ['navigation', 'environment', 'sensors', 'performance', 'propulsion', 'sails', 'electrical', 'tanks']

function putApi(tag, summary, description, type) {
    return {
        put: {
            tags: [tag],
            summary,
            description,
            parameters: [],
            requestBody: {
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['value', 'source'],
                            properties: {
                                value: { type },
                                source: { type: 'string' },
                                login: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['token'],
                                    properties: { token: { type: 'string' } },
                                },
                            },
                        },
                    },
                },
            },
            responses: {
                200: { description: 'Successful operation' },
                400: { description: 'Value rejected (type or unit)' },
                403: { description: 'No write permission - a user or device with readwrite (or admin) permission is required, ACLs apply' },
            },
        },
    }
}

// configurations before 0.8 kept the paths in an object 'restpaths' with a 'limit'
function migrate(settings, save) {
    if (!settings || !Object.hasOwn(settings, 'limit'))
        return settings || {}
    const { limit, restpaths, ...rest } = settings
    const migrated = { ...rest, paths: Object.values(restpaths || {}).map(p => ({ ...p, debug: false })) }
    save(migrated)
    return migrated
}

module.exports = function (app) {
    let endpoints = []
    let configured = 0

    const plugin = {
        id: 'rest-provider-signalk',
        name: 'REST Endpoint Provider',
        description: 'Provide RESTful endpoints for selected SignalK paths',
    }

    // the server reads the OpenAPI document once, at plugin registration, and serves this object -
    // its paths are updated in place on every start
    const openapi = {
        openapi: '3.0.3',
        info: { title: plugin.name, description: plugin.description, version: '1.0.0' },
        servers: [{ url: '/signalk/v1/api' }],
        tags: [{ name: plugin.id }],
        paths: {},
    }

    function sourceId(index) {
        return plugin.id + (index ? '.' + index : '')
    }

    function sendDelta(values, index) {
        app.handleMessage(sourceId(index), { updates: [{ values }] })
    }

    function sendMeta(meta) {
        app.handleMessage(plugin.id, { updates: [{ meta }] })
    }

    // value as published: converted to the SignalK unit for a convertible unit
    function convert(endpoint, value) {
        if (!endpoint.convert || value === null || value === undefined)
            return { value }
        const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
        if (typeof number !== 'number' || Number.isNaN(number))
            return { error: `Value '${value}' is not a number (unit '${endpoint.unit}')` }
        return { value: units.toSignalK(endpoint.unit, number).value }
    }

    function endpoint(p, index) {
        if (!p || !p.enabled || !p.prefix || !p.label)
            return null
        const unit = typeof p.unit === 'string' && p.unit.trim() !== '' ? p.unit.trim() : null
        const conversion = unit && CONVERTIBLE.has(unit)
        return {
            index,
            path: `${p.prefix}.${p.label}`,
            prefix: p.prefix,
            label: p.label,
            unit,
            convert: conversion,
            skUnit: conversion ? units.toSignalK(unit, 0).units : unit,
            refresh: typeof p.interval === 'number' && p.interval > 0 ? p.interval : null,
            source: typeof p.source === 'string' && p.source !== '' ? p.source : undefined,
            preset: Object.hasOwn(p, 'value') ? p.value : null,
            debug: p.debug === true,
            updated: null,
        }
    }

    function handler(ep) {
        return (context, path, value) => {
            const converted = convert(ep, value)
            if (converted.error) {
                log(`${sourceId(ep.index)}: '${path}' not updated - ${converted.error}`)
                return { state: 'COMPLETED', statusCode: 400, message: converted.error }
            }
            const node = app.getSelfPath(path)
            const current = node ? node.value : undefined
            if (current !== null && current !== undefined && converted.value !== null && typeof current !== typeof converted.value) {
                const message = `Type mismatch: '${typeof converted.value}' doesn't match '${typeof current}'`
                log(`${sourceId(ep.index)}: '${path}' not updated - ${message}`)
                return { state: 'COMPLETED', statusCode: 400, message }
            }
            ep.updated = new Date().toISOString()
            sendDelta([{ path, value: converted.value }], ep.index)
            if (ep.debug && current !== converted.value)
                log(`'${path}' changed from '${current}' to '${converted.value}'${ep.convert ? ` (received ${value} ${ep.unit})` : ''}`)
            return { state: 'COMPLETED', statusCode: 200 }
        }
    }

    plugin.start = function (options) {
        const settings = migrate(options, (migrated) => app.savePluginOptions(migrated, (err) => {
            if (err) log(`Migrated configuration not saved (${err.message || err})`)
            else log('Configuration migrated to the paths list and saved')
        }))
        const list = Array.isArray(settings.paths) ? settings.paths : []
        configured = list.length
        endpoints = list.map(endpoint).filter(Boolean)
        // index of the source id: position among the active paths, as before
        endpoints.forEach((ep, i) => { ep.index = i })

        Object.keys(openapi.paths).forEach(k => delete openapi.paths[k])
        const values = []
        const meta = []
        endpoints.forEach(ep => {
            // PUT handlers are removed by the server on every stop - registered on every start
            app.registerPutHandler('vessels.self', ep.path, handler(ep), ep.source)

            const node = app.getSelfPath(ep.path)
            const current = node ? node.value : undefined
            const preset = convert(ep, ep.preset)
            const value = !preset.error && preset.value !== null && preset.value !== undefined ? preset.value
                : current !== undefined ? current : null
            values.push({ path: ep.path, value })

            const m = {}
            if (ep.skUnit) m.units = ep.skUnit
            if (ep.refresh) m.timeout = ep.refresh
            if (Object.keys(m).length > 0) meta.push({ path: ep.path, value: m })

            const type = ep.convert ? 'number'
                : value !== null && value !== undefined ? typeof value
                : ep.unit ? 'number' : 'string'
            const words = ep.label.split('.')
            openapi.paths['/vessels/self/' + ep.path.replaceAll('.', '/')] = putApi(ep.prefix, `Update ${words[0]} ${words[words.length - 1]}`,
                ep.convert ? `Receive an updated value via REST in '${ep.unit}' - published in '${ep.skUnit}'`
                    : `Receive an updated value via REST - expected unit: '${ep.unit || ''}'`, type)

            log(`PUT handler for '${ep.path}'${ep.source ? ` (source '${ep.source}')` : ''}` +
                `${ep.convert ? `, ${ep.unit} → ${ep.skUnit}` : ep.unit ? `, ${ep.unit}` : ''} registered`)
        })
        if (values.length > 0) sendDelta(values)
        if (meta.length > 0) sendMeta(meta)

        app.setPluginStatus(`${configured} path${configured === 1 ? '' : 's'} configured · ${endpoints.length} active`)
        log(`Started - ${configured} paths configured, ${endpoints.length} active`)
    }

    plugin.stop = function () {
        endpoints = []
        configured = 0
        log('Stopped')
    }

    // no routes - the PUT endpoints are those of the SignalK API; needed for the server to read getOpenApi
    plugin.registerWithRouter = function () {}

    plugin.getOpenApi = () => openapi

    plugin.schema = {
        type: 'object',
        title: 'Configuration',
        description: 'Configure SignalK paths to receive updates via REST: PUT /signalk/v1/api/vessels/self/<path> with { "value": ..., "source": ... } - requires a user or device with readwrite (or admin) permission.',
        properties: {
            paths: {
                type: 'array',
                title: 'Endpoints',
                description: 'Paths to be provided with REST handlers',
                items: {
                    type: 'object',
                    required: ['prefix', 'label'],
                    properties: {
                        enabled: {
                            type: 'boolean',
                            title: 'Enable the SignalK path for PUT calls',
                            default: false,
                        },
                        prefix: {
                            type: 'string',
                            title: 'SignalK Root Path',
                            description: 'Rootlevel path',
                            enum: ROOTS,
                        },
                        label: {
                            type: 'string',
                            title: 'SignalK Path',
                            description: 'Sublevel path to receive data, eg. outside.pressure',
                        },
                        unit: {
                            type: 'string',
                            title: 'Unit',
                            description: UNIT_DESCRIPTION,
                            default: '',
                        },
                        interval: {
                            type: 'number',
                            title: 'Refresh rate (s)',
                            description: 'Expected time between incoming values, published as meta timeout - 0: no timeout',
                            default: 0,
                        },
                        source: {
                            type: 'string',
                            title: 'Data Source',
                            description: "Source (service) of the values, given as 'source' in the PUT request - several sources can update the same path",
                        },
                        debug: {
                            type: 'boolean',
                            title: 'Debug',
                            description: 'Log value if changed',
                            default: false,
                        },
                    },
                },
            },
        },
    }

    return plugin
}

module.exports.SOURCE_UNITS = SOURCE_UNITS
