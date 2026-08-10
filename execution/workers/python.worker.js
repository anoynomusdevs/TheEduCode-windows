// Python Web Worker using Pyodide WebAssembly
let pyodideReadyPromise = null;

self.onmessage = async (msg) => {
    if (msg.data.type === 'init') {
        importScripts(msg.data.pyodidePath);
        pyodideReadyPromise = loadPyodide();
        pyodideReadyPromise.then(() => {
            self.postMessage({ type: 'ready' });
        });
        return;
    }

    if (msg.data.type === 'run') {
        const { id, code, sampleInputOutput } = msg.data;
        const pyodide = await pyodideReadyPromise;
        const results = [];

        for (let i = 0; i < sampleInputOutput.length; i++) {
            const [input, expectedOutput] = sampleInputOutput[i];
            let stdoutBuffer = "";
            let stderrBuffer = "";

            pyodide.setStdout({ batched: (str) => { stdoutBuffer += str; } });
            pyodide.setStderr({ batched: (str) => { stderrBuffer += str; } });

            // Mock sys.stdin for input
            pyodide.runPython(`
import sys
import io
sys.stdin = io.StringIO(${JSON.stringify(input || '')})
            `);

            const startTime = performance.now();
            let executionError = null;

            try {
                await pyodide.runPythonAsync(code);
            } catch (err) {
                executionError = err.toString();
            }

            const endTime = performance.now();
            const timeInSeconds = ((endTime - startTime) / 1000).toFixed(3);
            const userOutput = stdoutBuffer.trim();

            let statusId = 3;
            let statusDescription = "Accepted";

            if (executionError) {
                if (executionError.includes("SyntaxError")) {
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
                    memory: 2048,
                    statusId,
                    statusDescription
                }
            });
        }

        self.postMessage({ type: 'result', id, results });
    }
};
