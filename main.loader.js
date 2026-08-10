const bytenode = require('bytenode');
const path = require('path');
const fs = require('fs');

const jscPath = path.join(__dirname, 'main.jsc');
const jsPath = path.join(__dirname, 'main.js');

try {
    require(jscPath);
} catch (err) {
    console.warn('[LOADER] Bytecode loading error:', err.message);
    if (fs.existsSync(jsPath)) {
        try {
            // Re-compile main.js for target machine's V8 engine on first run if bytecode was rejected
            bytenode.compileFile({
                filename: jsPath,
                output: jscPath
            });
            require(jscPath);
        } catch (compileErr) {
            console.warn('[LOADER] Re-compilation failed, loading main.js source directly:', compileErr.message);
            require(jsPath);
        }
    } else {
        throw err;
    }
}
