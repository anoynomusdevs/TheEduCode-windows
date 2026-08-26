const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB strict limit

function obfuscatePaths(text) {
    if (!text) return text;
    let obfuscated = text;

    try {
        const appData = app.getPath('appData');
        const userData = app.getPath('userData');
        const temp = app.getPath('temp');

        const pathsToReplace = [
            { original: appData, replacement: '[SYSTEM_APPDATA]' },
            { original: userData, replacement: '[SYSTEM_USERDATA]' },
            { original: temp, replacement: '[SYSTEM_TEMP]' }
        ];

        pathsToReplace.forEach(({ original, replacement }) => {
            if (original) {
                const raw = original;
                const normalized = original.replace(/\\/g, '/');
                
                const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                obfuscated = obfuscated.replace(new RegExp(escapeRegExp(raw), 'gi'), replacement);
                obfuscated = obfuscated.replace(new RegExp(escapeRegExp(normalized), 'gi'), replacement);
            }
        });
    } catch (err) {
        // Fallback or ignore if paths cannot be resolved
    }

    return obfuscated;
}

function getSecureRunnerPath() {
    const basePath = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
    const runnerPath = app.isPackaged 
        ? path.join(basePath, 'executables', 'secure_runner.exe')
        : path.join(basePath, 'bin', 'secure_runner.exe');
    
    if (!fs.existsSync(runnerPath)) {
        return null; // Fallback handled by the caller
    }
    return runnerPath;
}

module.exports = {
    MAX_OUTPUT_BYTES,
    obfuscatePaths,
    getSecureRunnerPath
};
