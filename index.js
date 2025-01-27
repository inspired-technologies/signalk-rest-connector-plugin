'use strict'
const debug = require("debug")("signalk:rest-provider-signalk")
const putApi = (tag, summary, desc, type) => { return {
    "put": {
      "tags": [
        tag
      ],
      "summary": summary,
      "description": desc,
      "parameters": [],
      "requestBody": {
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "value", "source"
              ],
              "properties": {
                "value": {
                  "type": type
                },
                "source": {
                    "type": "string"
                }, 
                "login": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "token"
                    ],                
                    "properties": {
                        "token": {
                          "type": "string"
                          },
                    }
                }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Successful operation"
        }
      }
    }
}}}

const openApi = (id, name, description, version) => { return {
    "openapi": "3.0.3",
    "info": {
        "title": name,
        "description": description,
        "version": version
    },
    "servers": [
      {
        "url": "/signalk/v1/api"
      }
    ],
    "tags": [
      {
        "name": id
        // "description": name
      }
    ],
    "paths": {}
}}

let openapi

module.exports = function (app) {

    const noVal = null
    let unsubscribes = []
    let restConfig = []

    const plugin = {
        id: 'rest-provider-signalk',
        name: 'REST Endpoint Provider',
        description: 'Provide RESTful endpoints for selected SignalK paths',
        uiSchema: {},

        start: (settings, restartPlugin) => {
            app.debug('Plugin starting ...');

            // read configuration, initialize & register
            if (settings.hasOwnProperty('limit'))
            {
                delete settings.limit
                let paths = Object.keys(settings.restpaths)
                settings.paths = []
                paths.forEach(p => {
                    let config = settings.restpaths[p]
                    config.debug = false
                    settings.paths.push(config)
                })
                delete settings.restpaths
                app.savePluginOptions(settings, () => { 
                    app.debug('Plugin configuration updated!')
                })
            }
            if (settings.hasOwnProperty('paths') && Array.isArray(settings.paths))
                plugin.init(settings.paths);

            app.debug('Plugin started');
            app.setPluginStatus('Started');  
        },

        init: (restPaths) => {
            if (restConfig.length>0)
                app.setPluginStatus('Re-Initializing');
            else
                app.setPluginStatus('Initializing');
            // do some initialization  
            app.debug("Configuring REST Provider ...")
            let updates = []

            if (Array.isArray(restPaths) && restPaths.length>0)
            {
                restPaths.forEach(p => {
                    let pathEnabled = false
                    let pathLabel
                    let pathValue
                    let pathSource
                    let pathUnit
                    let refreshRate
                    let pathDebug = false
                    if (p.hasOwnProperty('prefix') && p.hasOwnProperty('label') && p.prefix !== '' && p.label !=='' ) 
                    {
                        pathEnabled = p.hasOwnProperty('enabled') ? p.enabled : false
                        pathLabel = `${p.prefix}.${p.label}`
                        pathUnit = p.unit==='' ? null : p.unit 
                        pathValue = p.hasOwnProperty('value') ? p.value : noVal
                        refreshRate = p.interval===0 ? null : p.interval
                        pathSource = p.source
                        pathDebug = p.hasOwnProperty('debug') ? p.debug : false
                    } else {
                        pathEnabled = false
                    }
                    // get current value from SignalK
                    let currentVal = app.getSelfPath(pathLabel)
                    if (pathEnabled) {
                        // configure path for receiving updates
                        restConfig.push(
                            {
                                enabled: pathEnabled,
                                path: pathLabel,
                                value: pathValue,
                                unit: pathUnit,
                                refresh: refreshRate,
                                source: pathSource,
                                last: currentVal,
                                updated: "never",
                                debug: pathDebug,
                                api: putApi(p.prefix, `Update ${p.label.split('.')[0]} ${p.label.split('.')[p.label.split('.').length-1]}`,
                                    `Receive updated value via REST - expected unit: '${p.unit}'`, 
                                    currentVal && currentVal !== null ? typeof currentVal : pathValue!==noVal ? typeof pathValue : 
                                    pathUnit==="" ? "string" : "number")
                            }
                        )
                        // store latest update
                        if (pathValue!==noVal)
                            updates.push(buildDeltaUpdate(pathLabel, pathValue))
                        else if (currentVal)
                            updates.push(buildDeltaUpdate(pathLabel, currentVal))
                        else
                            updates.push(buildDeltaUpdate(pathLabel, noVal))
                    }            
                })
                if (updates.length > 0)
                sendDelta(updates)
                    app.debug(restConfig)
            }

            openapi = openApi(plugin.id, plugin.name, plugin.description, "1.0.0")
            restConfig.forEach(c => {
                openapi.paths['/'+c.path.replaceAll('.','/')] = c.api
            })

            app.setPluginStatus('Initialized');    
        },

        registerWithRouter: () => {
            app.setPluginStatus('Registering');
            let metas = []
    
            // do some initialization     
            app.debug("Registering active PUT Handler(s) ...")
            restConfig.forEach(c => {
                if (c.enabled) {
                    app.registerPutHandler('vessels.self', c.path, plugin.handle, c.source)
                    let value = (c.unit && c.unit!==null ? { units: c.unit } : {} )
                    if (c.refresh!==null) value.timeout = c.refresh 
                    metas.push(buildDeltaUpdate(c.path, value))                
                    app.debug(`Handler for '${c.path}' registered for ${c.source}`)
                }
            })
            if (metas.length>0)
                sendMeta(metas)

            app.setPluginStatus(`Registered: ${restConfig.length} paths active`);
        },

        handle: (context, path, value, callback) => {
            let error = false
            let errMsg = ''
            let update = []

            // push delta for path
            let index = restConfig.map(rc => rc.path).indexOf(path)
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
                    restConfig[index].last = currentVal.value
                    restConfig[index].updated = new Date(Date.now()).toISOString()
                    restConfig[index].value = value
                    update.push(buildDeltaUpdate(path, value, restConfig[index].refresh))
                    if (restConfig[index].debug && restConfig[index].last !== restConfig[index].value)
                        app.debug(`'${path}' value changed from '${restConfig[index].last}' to '${restConfig[index].value}'`)
                }
            }

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
        },

        stop:  () => {
            // resync options
            var options = app.readPluginOptions();
            unsubscribes.forEach(f => f());
            unsubscribes = [];
            app.debug('Plugin stopped');
        },

        getOpenApi: () => openapi,

        schema: {
            type: "object",
            title: "Configuration",
            description: "Configure SignalK paths to receive updates via REST",
            properties: {
                paths: {
                    type: "array",
                    title: "Endpoints",
                    description: 'Paths to be provided with REST handlers',
                    items: {
                        type: 'object',
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
                                    "performance",
                                    "propulsion",
                                    "sails",
                                    "electrical",
                                    "tanks"
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
                            },
                            debug: {
                                type: 'boolean',
                                title: 'Debug', 
                                description: 'Log value if changed',
                                default: false
                            }
                        }
                    }
                }
            }   
        }

    }

    function buildDeltaUpdate(path, value) {
        return {
            path: path,
            value: value
        }
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

    return plugin;
}