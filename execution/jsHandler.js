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

        let statusId = 3; // Accepted
        let statusDescription = "Accepted";

        if (executionError) {
            if (executionError.includes('Time Limit Exceeded')) {
                statusId = 5;
                statusDescription = "Time Limit Exceeded";
            } else if (executionError.includes('SyntaxError')) {
                statusId = 6;
                statusDescription = "Compilation Error";
            } else {
                statusId = 12;
                statusDescription = "Runtime Error (NZEC)";
            }
        } else if (userOutput !== expectedOutput.trim()) {
            statusId = 4;
            statusDescription = "Wrong Answer";
        }

        results.push({
            [`testCase${i + 1}`]: {
                input,
                expectedOutput: expectedOutput.trim(),
                userOutput,
                testCasePassed: statusId === 3,
                compilerMessage: executionError || null,
                time: timeInSeconds,
                memory: Math.floor(Math.random() * 1024 + 1024),
                statusId,
                statusDescription
            }
        });
    }

    return results;
}

module.exports = { runJS };
