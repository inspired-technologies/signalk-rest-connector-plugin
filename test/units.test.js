'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SOURCE_UNITS } = require('../index');
const sk = require('../skunits');
const pluginFactory = require('../index');
const { createApp } = require('./helpers/signalk-app');

// The convertible units are a fixed list - these tests fail once skunits.js no
// longer converts one of them to the listed SignalK unit.
describe('source units', () => {
  for (const [skUnit, units] of Object.entries(SOURCE_UNITS)) {
    for (const unit of units) {
      it(`converts ${unit} to ${skUnit}`, () => {
        const converted = sk.toSignalK(unit, 10);
        assert.equal(converted.units, skUnit);
        assert.equal(typeof converted.value, 'number');
        assert.ok(!Number.isNaN(converted.value));
        assert.notEqual(converted.value, 10, `${unit} is not converted`);
      });
    }
  }

  it('converts deg as a temperature and ° / degrees as an angle', () => {
    assert.ok(SOURCE_UNITS.K.includes('deg'));
    assert.deepEqual(sk.toSignalK('deg', 4.3), { value: 277.45, units: 'K' });
    assert.ok(Math.abs(sk.toSignalK('degrees', 180).value - Math.PI) < 1e-9);
  });

  it('lists every convertible unit in the description of the unit field', () => {
    const { description } = pluginFactory(createApp()).schema.properties.paths.items.properties.unit;
    for (const [skUnit, units] of Object.entries(SOURCE_UNITS)) {
      assert.ok(description.includes(`${units.join(', ')} → ${skUnit}`), `${skUnit} missing in the description`);
    }
  });
});
