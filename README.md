# signalk-rest-connector-plugin
SignalK plugin to receive selected deltas via REST PUT requests 

## Install & Use
Install the plugin through the SignalK plugin interface. After installation you need to 'Activate' it through the SignalK Plugin Config interface and configure the number of put handlers the plugin shall listen on.

The plugin will inject new SignalK-values, eg.:

`navigation.gnss.antennaAltitude`

by configuring like 

![Plugin Configuration](./PathConfig.png)

Timeout configuration to 0 means no timeout data will be set to the meta data.

Sending a put request requires authorization first and a proper JSON object to be submitted in the body specifying at least the data source as well as the value to be captured. This can be done even manually through POSTMAN - yet the data source specified needs to match the configuration:

![Postman PUT Request](./PostmanPutRequest.png)

Each path can be selectively enabled or disabled. Max # of paths has been set to 9.

***

## Release Notes
- v0.2 update to include metas for units and timeout
- v0.3 added propulsion as base path 
