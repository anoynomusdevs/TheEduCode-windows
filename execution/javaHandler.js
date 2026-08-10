const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Java Compiler Runner using portable OpenJDK 21.
 * Language ID: 62 (Java)
 */
async function runJava(userWrittenCode, sampleInputOutput, files) {
    const isWindows = process.platform === 'win32';
    const basePath = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');

    let javaHome;
    if (isWindows) {
        javaHome = path.join(basePath, 'compilers/win/java');
    } else {
        javaHome = path.join(basePath, `compilers/${process.platform === 'darwin' ? 'mac' : 'linux'}/java`);
    }

    let javacPath = path.join(javaHome, 'bin', isWindows ? 'javac.exe' : 'javac');
    let javaPath = path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');

    if (!fs.existsSync(javacPath)) javacPath = 'javac';
    if (!fs.existsSync(javaPath)) javaPath = 'java';

    const tempDir = path.join(app.getPath('temp'), `educode_java_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Extract main class name from user code or default to Main
    const match = userWrittenCode.match(/public\s+class\s+([A-Za-z0-9_]+)/);
    const mainClassName = match ? match[1] : 'Main';

    const mainSourcePath = path.join(tempDir, `${mainClassName}.java`);
    fs.writeFileSync(mainSourcePath, userWrittenCode, 'utf8');

    // Write additional file structures if present
    if (Array.isArray(files)) {
        for (const file of files) {
            if (file.name && file.content && file.name !== `${mainClassName}.java`) {
                const filePath = path.join(tempDir, file.name);
                const fileSubDir = path.dirname(filePath);
                if (!fs.existsSync(fileSubDir)) fs.mkdirSync(fileSubDir, { recursive: true });
                fs.writeFileSync(filePath, file.content, 'utf8');
            }
        }
    }

    // 1. Compile Phase
    const compileResult = await new Promise((resolve) => {
        const compileArgs = [mainSourcePath];
        const child = spawn(javacPath, compileArgs, { cwd: tempDir });
        let stderr = '';

        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
        child.on('close', (code) => resolve({ code, stderr }));
    });

    if (compileResult.code !== 0) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        return {
            compile_success: false,
            compile_error: compileResult.stderr,
            run_success: false,
            run_error: "",
            stdout: "",
            stderr: "",
            results: []
        };
    }

    // 2. Execution Phase
    const results = [];
    for (let i = 0; i < sampleInputOutput.length; i++) {
        const [input, expectedOutput] = sampleInputOutput[i];
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let executionError = null;
        let isTimeout = false;

        const startTime = process.hrtime();

        await new Promise((resolve) => {
            const runArgs = ['-cp', '.', mainClassName];
            const runner = spawn(javaPath, runArgs, { cwd: tempDir });

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
                    executionError = `Process exited with code ${code}\n${stderrBuffer}`;
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

module.exports = { runJava };
