// Loads the browser-agnostic core (js/core/*.js) into Node and returns the BB namespace.
'use strict';
const path = require('path');

const CORE_FILES = ['isa.js', 'geometry.js', 'assembler.js', 'vm.js', 'world.js', 'examples.js', 'missions.js'];

module.exports = function loadCore() {
  for (const f of CORE_FILES) require(path.join(__dirname, '..', 'js', 'core', f));
  return globalThis.BB;
};
