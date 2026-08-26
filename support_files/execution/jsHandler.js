const vm = require('vm');

/**
 * Sandboxed JavaScript execution engine.
 * Language IDs: 63 (JavaScript Node.js), 93 (JavaScript Sandbox)
 */
async function runJS(userWrittenCode, sampleInputOutput) {
    const results = [];

    for (let i = 0; i < sampleInputOutput.length; i++) {
        const [input, expectedOutput] = sampleInputOutput[i];
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let executionError = null;

        const sandbox = {
            console: {
                log: (...args) => {
                    stdoutBuffer += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
                },
                error: (...args) => {
                    stderrBuffer += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
                },
                warn: (...args) => {
                    stdoutBuffer += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
                }
            },
            input: input,
            process: {
                env: {},
                stdout: {
                    write: (str) => { stdoutBuffer += str; }
                }
            }
        };

        const context = vm.createContext(sandbox);
        const startTime = process.hrtime();

        try {
            // Mock readline/prompt input if code expects input
            const wrappedCode = `
                let __inputLines = ${JSON.stringify(input ? input.split('\n') : [])};
                let __inputIndex = 0;
                function readline() { return __inputLines[__inputIndex++] || ''; }
                function prompt() { return readline(); }
                ${userWrittenCode}
            `;
            const script = new vm.Script(wrappedCode);
            script.runInContext(context, { timeout: 5000 });
        } catch (err) {
            if (err.message && err.message.includes('Script execution timed out')) {
                executionError = 'Time Limit Exceeded (5000ms)';
            } else {
                executionError = err.toString();
            }
        }

        const diff = process.hrtime(startTime);
        const timeInSeconds = (diff[0] + diff[1] / 1e9).toFixed(3);
        const userOutput = stdoutBuffer.trim();
        const testCasePassed = userOutput === expectedOutput.trim() && !executionError;

        results.push({
            run_success: testCasePassed,
            run_error: executionError || (testCasePassed ? "" : "Wrong Answer"),
            stdout: stdoutBuffer,
            stderr: stderrBuffer
        });
    }
    
    return {
        compile_success: true,
        compile_error: "",
        run_success: results.every(r => r.run_success),
        run_error: results.find(r => !r.run_success)?.run_error || "",
        stdout: results[0]?.stdout || "",
        stderr: results[0]?.stderr || "",
        results
    };
}

module.exports = { runJS };
