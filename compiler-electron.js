// compile-electron.js
require('bytenode').compileFile('main.js');
console.log('✅ main.js compiled to main.jsc');
console.log(process.version);
process.exit(0);
