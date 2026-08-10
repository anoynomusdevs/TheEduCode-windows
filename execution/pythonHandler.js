const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Python Local Compiler Runner.
 * Language ID: 71 (Python)
 */
async function runPython(userWrittenCode, sampleInputOutput) {
    const isWindows = process.platform === 'win32';
    const basePath = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
    
    let compilerRelPath;
    if (isWindows) {
        compilerRelPath = 'compilers/win/python/python.exe';
    } else {
        compilerRelPath = 'python3';
    }

    let pythonPath = path.join(basePath, compilerRelPath);
    if (!fs.existsSync(pythonPath) && isWindows) {
        pythonPath = 'python'; // fallback to system python
    }

    const tempDir = path.join(app.getPath('temp'), `educode_python_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const sourcePath = path.join(tempDir, 'main.py');
    fs.writeFileSync(sourcePath, userWrittenCode, 'utf8');

    const results = [];
    for (let i = 0; i < sampleInputOutput.length; i++) {
        const [input, expectedOutput] = sampleInputOutput[i];
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let executionError = null;
        let isTimeout = false;

        const startTime = process.hrtime();

        await new Promise((resolve) => {
            const runner = spawn(pythonPath, [sourcePath], { cwd: tempDir });

            const timer = setTimeout(() => {
                isTimeout = true;
                executionError = "Time Limit Exceeded (5000ms)";
                runner.kill('SIGKILL');
            }, 5000);

            if (input) {
                runner.stdin.write(input);
                runner.stdin.end();
            }

            runner.stdout.on('data', (d) => { stdoutBuffer += d.toString(); });
            runner.stderr.on('data', (d) => { stderrBuffer += d.toString(); });

            runner.on('error', (err) => {
                clearTimeout(timer);
                if (!isTimeout) executionError = err.toString();
                resolve();
            });

            runner.on('close', (code) => {
                clearTimeout(timer);
                if (code !== 0 && !isTimeout) {
                    if (stderrBuffer.includes('SyntaxError')) {
                        executionError = `SyntaxError\n${stderrBuffer}`;
                    } else {
                        executionError = `Process exited with code ${code}\n${stderrBuffer}`;
                    }
                }
                resolve();
            });
        });

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

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    
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

module.exports = { runPython };
