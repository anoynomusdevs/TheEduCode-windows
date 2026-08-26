const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * C and C++ Local Compiler Runner utilizing GCC MinGW-w64.
 * Language IDs: 50 (C), 54 (C++)
 */
async function runCpp(userWrittenCode, languageId, sampleInputOutput) {
    const isWindows = process.platform === 'win32';
    const basePath = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
    
    let compilerRelPath;
    const type = languageId === 50 ? 'c' : 'cpp';

    if (isWindows) {
        compilerRelPath = type === 'c' ? 'compilers/win/mingw64/bin/gcc.exe' : 'compilers/win/mingw64/bin/g++.exe';
    } else if (process.platform === 'darwin') {
        compilerRelPath = type === 'c' ? 'compilers/mac/clang/bin/clang' : 'compilers/mac/clang/bin/clang++';
    } else {
        compilerRelPath = type === 'c' ? 'compilers/linux/gcc' : 'compilers/linux/g++';
    }

    let compilerPath = path.join(basePath, compilerRelPath);
    if (!fs.existsSync(compilerPath)) {
        // Fallback to system gcc/g++ if packaged binary isn't present
        compilerPath = type === 'c' ? 'gcc' : 'g++';
    }

    const tempDir = path.join(app.getPath('temp'), `educode_cpp_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const fileExt = type === 'c' ? '.c' : '.cpp';
    const sourcePath = path.join(tempDir, `main${fileExt}`);
    const binaryName = isWindows ? 'main.exe' : 'main';
    const binaryPath = path.join(tempDir, binaryName);

    fs.writeFileSync(sourcePath, userWrittenCode, 'utf8');

    // 1. Compile Phase
    const compileResult = await new Promise((resolve) => {
        const compileArgs = [sourcePath, '-o', binaryPath];
        if (type === 'cpp') compileArgs.push('-std=c++17');

        const compilerDir = path.dirname(compilerPath);
        const env = Object.assign({}, process.env);
        env.PATH = `${compilerDir}${path.delimiter}${env.PATH}`;

        const child = spawn(compilerPath, compileArgs, { cwd: tempDir, env });
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

    // 2. Execution Phase over Test Cases
    const results = [];
    for (let i = 0; i < sampleInputOutput.length; i++) {
        const [input, expectedOutput] = sampleInputOutput[i];
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let executionError = null;
        let isTimeout = false;

        const startTime = process.hrtime();

        await new Promise((resolve) => {
            const runner = spawn(binaryPath, [], { cwd: tempDir });

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

    // Cleanup temp files
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

module.exports = { runCpp };
