'use strict'
const debug = require("debug")("signalk:rest-provider-signalk")
const maxPaths = 9

function buildDeltaUpdate(path, value) {
    return {
        path: path,
        value: value
    }
}

function createPathSchema(schema, limit, ui) {

    let restPaths = {
        type: 'object',
        title: 'Paths provided with REST handlers',
        properties: {}
    }
    if (limit===0)
        return schema

    for (let i = 1; i <= Math.min(limit, maxPaths); i++) {
        let config = {
            type: "object",
            title: "Path " + i,
            required: ['prefix', 'label'],
            properties: {
                enabled: {
                    type: 'boolean',
                    title: 'Enable the SignalK path for PUT calls',
                    default: false
                },
                prefix: {
                    type: 'string',
                    title: 'SignalK Root Path',
                    description: 'Rootlevel path',
                    enum: [
                        "navigation",
                        "environment",
                        "sensors",
                        "electrical",
                        "performance",
                        "propulsion",
                        "sails"
                    ]
                },
                label: {
                    type: 'string',
                    title: 'SignalK Path',
                    description: 'Sublevel path to receive data'
                },
                unit: {
                    type: 'string',
                    title: 'SignalK Unit',
                    description: 'Meta unit to be set (if not PGN, should comply with https://signalk.org/specification/1.7.0/doc/)',
                    default: '' 
                },     
                interval: {
                    type: 'number',
                    title: 'Refresh rate',
                    description: 'Expected time in s between incoming data points',
                    default: null 
                },              
                source: {
                    type: 'string',
                    title: 'Data Source', 
                    description: 'Specify the source (service) for the data item',
                    default: "undefined"
                }
            }
        }

        restPaths.properties[i] = config
    }

    schema.properties["restpaths"] = restPaths
    return schema
}

module.exports = function (app) {
    var plugin = {};
    var restConfig = {};
    let configuredPaths = 0;
    const noVal = null

    plugin.id = 'rest-provider-signalk';
    plugin.name = 'REST Endpoint Provider';
    plugin.description = 'Provide RESTful endpoint for selected SignalK paths';
    plugin.uiSchema = {}

    var unsubscribes = [];
    plugin.start = function (options, restartPlugin) {

        app.debug('Plugin starting ...');

        // read configuration, initialize & register
        configuredPaths = options["limit"];
        if (typeof restConfig === 'object' && Object.keys(restConfig).length<1) {
            init(configuredPaths, options["restpaths"]);
        } 
        if (configuredPaths>0 && typeof restConfig === 'object' && Object.keys(restConfig).length>0)     
            register();

        app.debug('Plugin started');
        app.setPluginStatus('Started');  
    };

    function init (handlercount, restpaths) {
        app.setPluginStatus('Initializing');
        restConfig = {}
    
        // do some initialization     
        app.debug("Configuring REST Provider ...")
        let updates = []
    
        for (let i = 1; i <= handlercount; i++) {
            let pathEnabled = false
            let pathLabel
            let pathValue
            let pathSource
            let pathUnit
            let refreshRate
            if (restpaths && (restpaths[i].prefix!='' && restpaths[i].label!='')) {
                pathEnabled = restpaths[i].hasOwnProperty('enabled') ? restpaths[i].enabled : false
                pathLabel = restpaths[i].prefix+"."+restpaths[i].label
                pathUnit = restpaths[i].unit==='' ? null : restpaths[i].unit 
                pathValue = restpaths[i].hasOwnProperty('value') ? restpaths[i].value : noVal
                refreshRate = restpaths[i].interval===0 ? null : restpaths[i].interval
                pathSource = restpaths[i].source
            } else {
                pathEnabled = false
            }
    
            let currentVal = app.getSelfPath(pathLabel)

            if (pathEnabled) {
                restConfig[i] = {
                "enabled": pathEnabled,
                "path": pathLabel,
                "value": pathValue,
                "unit": pathUnit,
                "refresh": refreshRate,
                "source": pathSource,
                "last": currentVal,
                "updated": "never"
                }
                if (pathValue!==noVal)
                    updates.push(buildDeltaUpdate(pathLabel, pathValue))
                else if (currentVal)
                    updates.push(buildDeltaUpdate(pathLabel, currentVal))
                else
                    updates.push(buildDeltaUpdate(pathLabel, noVal))
            }
            else
                restConfig[i] = { "enabled": false }
        }
        app.debug(restConfig)
        if (updates.length > 0)
            sendDelta(updates)
    
        app.setPluginStatus('Done initializing');    
    }

    function register () {
        app.setPluginStatus('Registering');
        let metas = []
    
        // do some initialization     
        app.debug("Registering active PUT Handler(s) ...")
        for (let i = 1; i <= Object.keys(restConfig).length; i++) {
            if (restConfig[i].enabled) {
                app.registerPutHandler('vessels.self', restConfig[i].path, handle, restConfig[i].source)
                let value = (restConfig[i].unit && restConfig[i].unit!==null ? { units: restConfig[i].unit } : {} )
                if (restConfig[i].refresh!==null) value.timeout = restConfig[i].refresh 
                metas.push(buildDeltaUpdate(restConfig[i].path, value))                
                app.debug("Handler for '"+restConfig[i].path+"' registered for "+ restConfig[i].source)
            }
        }
        if (metas.length>0)
            sendMeta(metas)

        app.setPluginStatus('Registered');    
    }

    function handle (context, path, value, callback) {
        let error = false
        let errMsg = ''
        let update = []

        // push delta for path
        let configured = Object.keys(restConfig).map(i => { return { "key": i, "config": restConfig[i] }})
            .filter(rc => rc.config.hasOwnProperty('enabled') && rc.config.enabled===true)
        let index = configured.map(rc => rc.config.path).indexOf(path)
        if (context === 'vessels.self' && index!==-1) {
            let currentVal = app.getSelfPath(path)
            if (currentVal.value!==noVal && typeof currentVal.value !== typeof value) { 
                error = true; 
                errMsg = "Type mismatch: '"+ typeof value + "' doesn't match '" + typeof currentVal +"'"
                let handler = 'rest-provider-signalk' + (index ? '.'+index : '')
                app.debug(handler+ ": couldn't update '"+path+"', error: "+errMsg)
            }
            else
            {
                restConfig[configured[index].key].last = currentVal.value
                restConfig[configured[index].key].updated = new Date(Date.now()).toISOString()
                restConfig[configured[index].key].value = value
                update.push(buildDeltaUpdate(path, value, restConfig[configured[index].key].refresh))
            }
        }

        // TODO - add logging for val before / after

        if (!error && update.length>0) 
        {
            sendDelta(update, (index!=0 ? index : null))
            let handler = 'rest-provider-signalk' + (index ? '.'+index : '')
            app.debug( { [[handler]]: update[0] } )
        }

        if (!error)
            return {
                state: 'COMPLETED',
                statusCode: 200
           }
        else
            return {
                state:'COMPLETED',
                statusCode: 400,
                message: errMsg
           }
    }

    plugin.stop = function () {
        // resync options
        var options = app.readPluginOptions();
        unsubscribes.forEach(f => f());
        unsubscribes = [];
        app.debug('Plugin stopped');
    };

    plugin.schema = function() {

        var schema = {
            type: "object",
            title: "Handler Configuration",
            description: "Configure SignalK paths to receive updates via REST calls",
            properties: {
                limit: {
                    type: 'number',
                    title: 'Limit',
                    description: 'maximum '+maxPaths,
                    default: 0
                }
            }
        }

        if (configuredPaths>0)
            createPathSchema(schema, configuredPaths, plugin.uiSchema)

        return schema
    }

    /**
     * 
     * @param {Array<[{path:path, value:value}]>} messages 
     */
    function sendDelta(sentences, index) {
        app.handleMessage('rest-provider-signalk' + (index ? '.'+index : ''), {
            updates: [
                {
                    values: sentences
                }
            ]
        });
    }

    function sendMeta(units) {
        app.handleMessage('rest-provider-signalk', {
            updates: [
                {
                    meta: units
                }
            ]   
        })
    }

    function log(msg) { app.debug(msg); }

    return plugin;
};