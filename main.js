// File-based logger configuration
(function () {
    const fs = require('fs');
    const path = require('path');
    const logFile = path.join(__dirname, 'app.log');

    try {
        fs.writeFileSync(logFile, '', 'utf8'); // clear log file on launch
    } catch (e) {
        // ignore errors clearing the log file
    }

    function writeToLog(type, args) {
        const message = args.map(arg => {
            if (arg instanceof Error) {
                return arg.stack || arg.message;
            }
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch (err) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');
        const logLine = `[${new Date().toISOString()}] [${type}] ${message}\n`;
        try {
            fs.appendFileSync(logFile, logLine, 'utf8');
        } catch (e) {
            // ignore logging write errors
        }
    }

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args) => {
        originalLog(...args);
        writeToLog('INFO', args);
    };
    console.warn = (...args) => {
        originalWarn(...args);
        writeToLog('WARN', args);
    };
    console.error = (...args) => {
        originalError(...args);
        writeToLog('ERROR', args);
    };
})();

function showErrorTop(title, msg) {
    const { dialog, BrowserWindow } = require('electron');
    const focusedWin = BrowserWindow.getFocusedWindow() || (typeof mainWin !== 'undefined' && mainWin && !mainWin.isDestroyed() ? mainWin : null) || (typeof global.splashWin !== 'undefined' && global.splashWin && !global.splashWin.isDestroyed() ? global.splashWin : null);

    if (focusedWin) {
        dialog.showMessageBoxSync(focusedWin, { type: 'error', title: title, message: msg });
    } else {
        dialog.showErrorBox(title, msg);
    }
}

function robustFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const urlObj = new URL(url);
            const client = urlObj.protocol === 'https:' ? require('https') : require('http');

            const headers = options.headers || {};
            if (options.cache === 'no-store') {
                headers['Cache-Control'] = 'no-cache';
                headers['Pragma'] = 'no-cache';
            }

            const reqOptions = {
                method: options.method || 'GET',
                headers: headers,
                rejectUnauthorized: false,
                timeout: 15000
            };

            const req = client.request(url, reqOptions, (res) => {
                let chunks = [];
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const textContent = buffer.toString('utf8');
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        statusText: res.statusMessage,
                        json: async () => JSON.parse(textContent),
                        text: async () => textContent,
                        headers: {
                            get: (name) => res.headers[name.toLowerCase()]
                        }
                    });
                });
                res.on('error', (err) => reject(err));
            });

            req.on('error', (err) => reject(err));

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (options.body) {
                req.write(options.body);
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

const { app, BrowserWindow, globalShortcut, dialog, ipcMain, desktopCapturer, clipboard, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');
const { time } = require('console');
const express = require('express');
const CryptoJS = require("crypto-js");
const packageJson = require('./package.json');
const { runBootstrap } = require('./bootstrapper');

let sessionKey;
let cachedSKey; // ← pre-fetched before process_killer spawns


// const URL_TO_OPEN = 'https://obaz8ndujtjb.theeducode.com/student/dashboard'; // Change this to your desired URL
// const URL_TO_OPEN = 'https://frontend-tau-six-58.vercel.app/student/login'; // Change this to your desired URL
const URL_TO_OPEN = 'https://befnasa.theeducode.com/student/login';
// const URL_TO_OPEN = 'file://' + require('path').join(__dirname, 'test-compiler.html'); // Offline compiler test
// const URL_TO_OPEN = 'http://localhost:3000/student/dashboard'; // For local frontend testing
// const URL_TO_OPEN = 'file://' + require('path').join(__dirname, 'test-ipc.html'); // For local IPC validation
let killerProcess;

const secretKey2 = "dd62cc4fd422cd179bc5501ed0f4c3b252af92bd01c340647fe8549fae5bb6ad";

let mainWin;
let isCleaningUp = false;
let cachedPsCommand = null;





async function checkForUpdates() {
    try {
        const response = await robustFetch(
            `https://9ebrg3s7tuzj40ahkipn2m5oflxd16cq.theeducode.com/app-updates/windows`,
            { cache: 'no-store' }
        );
        const updateInfo = await response.json();

        console.log('[UPDATE] Server response:', updateInfo);

        if (!updateInfo.update_available) {
            console.log('[UPDATE] App is up to date.');
            return false;
        }

        // Compare versions
        const current = packageJson.version; // e.g. "1.3.0"
        const latest = updateInfo.latest_version; // e.g. "1.4.0"

        if (!isNewerVersion(latest, current)) {
            console.log('[UPDATE] No newer version found.');
            return false;
        }

        console.log(`[UPDATE] New version available: ${latest}. Current: ${current}`);

        // Prompt user
        const { dialog, BrowserWindow } = require('electron');
        const focusedWin = BrowserWindow.getFocusedWindow() || (typeof global.splashWin !== 'undefined' && global.splashWin && !global.splashWin.isDestroyed() ? global.splashWin : null);

        const dialogOptions = {
            type: 'info',
            buttons: ['Update Now', 'Close Application'],
            title: 'Update Available',
            message: `A new version (${latest}) of TheEduCode is available and this is mandatory to update.`,
            detail: 'The application will close, update, and restart automatically.'
        };
        const choice = focusedWin ? dialog.showMessageBoxSync(focusedWin, dialogOptions) : dialog.showMessageBoxSync(dialogOptions);

        if (choice === 0) {
            await launchUpdater(updateInfo.new_software_url);
            return true; // signal to stop app startup
        }
        else if (choice === 1) {
            app.isQuitting = true;
            killKillerAndQuit();
            return true; // signal to stop app startup
        }

        return false;

    } catch (err) {
        console.warn('[UPDATE] Update check failed:', err.message);
        return false; // Non-fatal, continue normally
    }
}

function isNewerVersion(latest, current) {
    const latestParts = latest.split('.').map(Number);
    const currentParts = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (latestParts[i] > currentParts[i]) return true;
        if (latestParts[i] < currentParts[i]) return false;
    }
    return false;
}


async function launchUpdater(updateInfo) {
    const updaterSrc = process.env.NODE_ENV === 'development'
        ? path.join(__dirname, 'updater-app', 'updater.exe')
        : path.join(process.resourcesPath, 'theeducode-updater.exe');

    // Patch notes payload — pull from your update endpoint or hardcode
    const patchNotes = {
        version: updateInfo.latest_version,
        title: updateInfo.patch_title || "What's New",
        highlights: updateInfo.patch_highlights || ['Performance improvements', 'Bug fixes'],
        image: updateInfo.banner_image || ''
    };

    const patchB64 = Buffer.from(JSON.stringify(patchNotes)).toString('base64');
    const installDir = 'C:\\Program Files\\theeducode';

    const proc = spawn(updaterSrc, [
        '--url', updateInfo.new_software_url,
        '--installdir', installDir,
        '--appexe', 'TheEduCode.exe',
        '--version', updateInfo.latest_version,
        '--patchnotes', patchB64
    ], { detached: true, stdio: 'ignore' });

    proc.unref();
    app.isQuitting = true;
    setTimeout(() => app.quit(), 1500);
}







function getPsCommand() {
    if (cachedPsCommand) return cachedPsCommand;
    const defaultPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    try {
        // Test if powershell is in PATH
        execSync('powershell.exe /?', { stdio: 'ignore' });
        cachedPsCommand = 'powershell.exe';
    } catch (e) {
        if (fs.existsSync(defaultPath)) {
            cachedPsCommand = `"${defaultPath}"`;
        } else {
            cachedPsCommand = 'powershell.exe'; // Final fallback
        }
    }
    return cachedPsCommand;
}

async function killKillerAndQuit() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    app.isQuitting = true;

    // ✅ SYNC REGISTRY RESTORATION
    // Since we are already elevated from startup, we run these directly and synchronously.
    // This ensures they complete BEFORE the process exits, without triggering a UAC prompt.
    const regRestore = [
        'reg delete "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v HideFastUserSwitching /f',
        'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v NoLogoff /f',
        'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableLockWorkstation /f',
        'reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableTaskMgr /f'
    ];

    console.log('[CLEANUP] Restoring system policies...');
    regRestore.forEach(cmd => {
        try {
            execSync(cmd, { stdio: 'ignore' });
        } catch (error) {
            console.error(`[CLEANUP] Failed to execute: ${cmd}`, error.message);
        }
    });
    console.log('[CLEANUP] System policies restoration attempt finished.');

    try {
        if (killerProcess && !killerProcess.killed) {
            killerProcess.stdin.write('STOP\n');
        }
        setTimeout(() => {
            app.quit();
        }, 3000);
    } catch (err) {
        console.error("Exit error:", err);
        app.quit();
    }
}

// Add these above app.whenReady()
app.commandLine.appendSwitch('enable-webrtc');
app.commandLine.appendSwitch('allow-http-screen-capture');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-features', 'CrossOriginOpenerPolicy');
app.commandLine.appendSwitch('enable-features', 'MediaRecorder,WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('enable-features', 'WebContentsForceEnable');
app.setAppUserModelId('com.educode.browser');


async function checkBluetooth() {
    return new Promise((resolve) => {
        const ps = getPsCommand();

        // Check if Bluetooth radio is actually enabled/transmitting
        const command = `${ps} -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "` +
            `try { ` +
            `Add-Type -AssemblyName System.Runtime.WindowsRuntime; ` +
            `$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]; ` +
            `Function Await($WinRtTask, $ResultType) { ` +
            `$asTask = $asTaskGeneric.MakeGenericMethod($ResultType); ` +
            `$netTask = $asTask.Invoke($null, @($WinRtTask)); ` +
            `$netTask.Wait(-1) | Out-Null; ` +
            `$netTask.Result; ` +
            `}; ` +
            `[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null; ` +
            `$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]); ` +
            `$btRadio = $radios | Where-Object { $_.Kind -eq 'Bluetooth' }; ` +
            `if ($btRadio -and $btRadio.State -eq 'On') { Write-Output 'ENABLED' } else { Write-Output 'DISABLED' } ` +
            `} catch { Write-Output 'DISABLED' }"`;

        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                console.warn('[BLUETOOTH] Check failed:', error.message);
                resolve(false); // Assume disabled if check fails
                return;
            }

            const output = stdout.trim();
            console.log('[BLUETOOTH] Radio state:', output);
            const isEnabled = output === 'ENABLED';
            resolve(isEnabled);
        });
    });
}


// ✅ Function to calculate checksum
function getChecksum(filePath, algorithm = 'sha256') {
    try {
        const content = fs.readFileSync(filePath);
        const hash = crypto.createHash(algorithm).update(content).digest('hex');
        return Promise.resolve(hash);
    } catch (err) {
        return Promise.reject(err);
    }
}



// ✅ File Integrity Verification
async function verifyFileIntegrity() {
    const checksums = {
        'index.html': '16bbb20b9c85de5ba618c1fe5cb6f321589eb5d0aeb94ca54ef53f8b26503ec2',
        'package.json': '2e9f8f9ab19fb787f1a1234996d2fc4386be95ebd0c9a26a33a6e7eeb79e6ae5',
        'webviewPreload.js': '5e460a651c85e39fd025a96ec1554fabf6a9a1acb00c4aad262c1ea9bdab7a4c',
        'main.loader.js': '91f8884e8ec2c815fd08372d8984fbbb9bc94a95629dccbda4aefebb68f89aca',
        'bin/process_killer.exe': 'e5cdd086d22d35836a66f2fd112c8734513e87a387f3701855489ca2eb81d8a4',
        'bin/vm_detection.exe': '180019330e9cb3d11bc869c807650a671c4c8a63fb5e8004bd3e4869456aa300',
        'bin/secure_runner.exe': '94168aee028f917af3d0bc5e5dc6a1bf84d8205da1dfc1550c63cff258adc753',
        'bin/WebView2Loader.dll': '8d6fe8b14529e1d6a02a7f2d5991ee72ace0d7e2f1901c71cfd7df310600f4c1',
        'bin/Microsoft.Web.WebView2.Core.dll': 'c6feb73ec1cb9271f2004d2586fe1833621a0fcd3d04a6fc1dcf08557d634ac0',
        'bin/Microsoft.Web.WebView2.WinForms.dll': 'fe0782a637c76982ca040bea1eb19b590c28b006866b38d70ea39199825b64cf',
        // External compiler binaries
        'compilers/win/python/python.exe': '5f7b89a612c9b8af1d6456cdfcd1dbe5ca630849e79aebced9bee9a6694952ec',
        'compilers/win/mingw64/bin/gcc.exe': 'aebe586bbc45e6b46c8388a55fe5eb00a2314d6f474ca8aedec4176246568935',
        'compilers/win/mingw64/bin/g++.exe': '8ba7fcdce5ebfa12d1fc48ddb5f007dacebe193efb3d524533c1d13eb8f0c85d',
        'compilers/win/java/bin/java.exe': '5e0fab9f07952ceb6e71eb9fd33e1ed69959904ca00cf70869b7baf516a98016',
        'compilers/win/java/bin/javac.exe': '2df52e1bcb1256e09734c12939eec114997082ea4c3e7898d19c7a35fea34281'
    };

    for (const [filename, expectedHash] of Object.entries(checksums)) {
        let fullPath;
        if (filename.startsWith('bin/') && app.isPackaged) {
            fullPath = path.join(process.resourcesPath, 'executables', filename.substring(4));
        } else if (filename.startsWith('compilers/')) {
            const compilersBase = app.isPackaged ? process.resourcesPath : __dirname;
            fullPath = path.join(compilersBase, filename);
            // On very first launch, bootstrapper may not have completed, or they might be missing.
            if (!fs.existsSync(fullPath)) {
                console.log(`[INTEGRITY] Skipping missing compiler: ${filename} (Likely first launch)`);
                continue;
            }
        } else {
            fullPath = path.join(__dirname, filename);
        }

        try {
            const actualHash = await getChecksum(fullPath);
            if (actualHash !== expectedHash) {
                showErrorTop('File Integrity Violation', `File "${filename}" has been modified or is corrupted.\n\nPlease use the official version of the browser.`);
                killKillerAndQuit();
                return false;
            }
        } catch (err) {
            showErrorTop('Checksum Error', `Failed to validate checksum for "${filename}": ${err.message}`);
            killKillerAndQuit();
            return false;
        }
    }

    return true;
}

function _xorCipher(input, password) {
    const inputBuf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const passBuf = Buffer.from(password, 'utf8');
    const out = Buffer.alloc(inputBuf.length);
    for (let i = 0; i < inputBuf.length; i++) {
        out[i] = inputBuf[i] ^ passBuf[i % passBuf.length];
    }
    return out;
}

async function getMasterKey() {
    const enData = await robustFetch("https://9ebrg3s7tuzj40ahkipn2m5oflxd16cq.theeducode.com/getKey");
    const data = await enData.json();

    // Use the new master key for decryption as requested
    const masterKey = '8db7f0bbec1f3de3221190ade7adacf7f1d5148ce578557ea4f30a0d284c98e2';
    const decryptedSessionKey = decryptWithMasterKey(data.data, masterKey);

    if (!decryptedSessionKey) {
        showErrorTop('Please Use Authorized Browser');
        killKillerAndQuit();
        return;
    }

    sessionKey = decryptedSessionKey;
    return sessionKey;
}

function encryptIPC(text, password) {
    try {
        if (!text || !password) return text;
        return _xorCipher(text, password).toString('base64');
    } catch (error) {
        console.error('IPC Encryption failed:', error.message);
        return null;
    }
}

function decryptIPC(rawInput, password) {
    try {
        if (!rawInput) return rawInput;
        const inputBuf = Buffer.isBuffer(rawInput)
            ? rawInput
            : Buffer.from(rawInput, 'binary');
        return _xorCipher(inputBuf, password).toString('utf8');
    } catch (error) {
        console.error('IPC Decryption failed:', error.message);
        return null;
    }
}

function decryptWithMasterKey(encryptedBase64, password) {
    try {
        const cipherBuf = Buffer.from(encryptedBase64, 'base64');
        const plain = _xorCipher(cipherBuf, password).toString('utf8');
        if (!plain) return null;
        return plain;
    } catch (error) {
        console.error('Decryption with master key failed:', error.message);
        throw new Error('FAILED_KEY_DECRYPTION');
    }
}

async function getKey(retries = 3, delayMs = 2000) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`[GETKEY] Attempt ${attempt}/${retries}...`);
            const enData = await robustFetch("https://9ebrg3s7tuzj40ahkipn2m5oflxd16cq.theeducode.com/getkey");
            const data = await enData.json();
            const bytes = CryptoJS.AES.decrypt(data.data, secretKey2);
            if (!bytes || bytes.sigBytes <= 0) {
                showErrorTop('Please Use Authorized Browser', 'Key decryption failed. Please use the official version.');
                app.quit();
                return;
            }
            const keyJSON = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
            console.log(`[GETKEY] Success on attempt ${attempt}.`);
            return keyJSON.s_key;
        } catch (err) {
            lastErr = err;
            console.warn(`[GETKEY] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw new Error(`getKey() failed after ${retries} attempts: ${lastErr.message}`);
}


// ✅ Enable SeDebugPrivilege (and related) on this Electron process's token so that
// process_killer.exe inherits them as ENABLED when spawned as a child.
async function enableDebugPrivilegeForSelf() {
    const tempScript = path.join(app.getPath('userData'), '_priv_enable.ps1');
    const pid = process.pid;

    // PowerShell script: uses C# P/Invoke to open our own token and enable SeDebugPrivilege.
    // A same-user admin process can open another same-user admin process without SeDebugPrivilege;
    // SeDebugPrivilege is only required for cross-session / PPL / SYSTEM-owned processes.
    const script = `
param([int]$Pid)
$src = @"
using System;
using System.Runtime.InteropServices;
public class PrivHelper {
    [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)]
    public static extern bool AdjustTokenPrivileges(IntPtr hTok, bool disAll, ref TokPriv ns, int len, IntPtr prev, IntPtr ret);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Auto)]
    public static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
    [DllImport("advapi32.dll", ExactSpelling=true, SetLastError=true)]
    public static extern bool OpenProcessToken(IntPtr hProc, int acc, out IntPtr hTok);
    [DllImport("kernel32.dll", ExactSpelling=true)]
    public static extern IntPtr OpenProcess(int acc, bool inh, int pid);
    [DllImport("kernel32.dll", ExactSpelling=true)]
    public static extern bool CloseHandle(IntPtr h);
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, Pack=1)]
    public struct TokPriv { public int Count; public long Luid; public int Attr; }
    public static string Enable(int pid, string priv) {
        // 0x400 = PROCESS_QUERY_INFORMATION
        IntPtr hProc = OpenProcess(0x400, false, pid);
        if (hProc == IntPtr.Zero) return "ERR_OPEN_PROC:" + System.Runtime.InteropServices.Marshal.GetLastWin32Error();
        IntPtr hTok = IntPtr.Zero;
        // 0x20 = TOKEN_ADJUST_PRIVILEGES, 0x08 = TOKEN_QUERY
        if (!OpenProcessToken(hProc, 0x28, out hTok)) { CloseHandle(hProc); return "ERR_OPEN_TOKEN:" + System.Runtime.InteropServices.Marshal.GetLastWin32Error(); }
        TokPriv tp; tp.Count = 1; tp.Luid = 0; tp.Attr = 2; // SE_PRIVILEGE_ENABLED = 2
        if (!LookupPrivilegeValue(null, priv, out tp.Luid)) { CloseHandle(hTok); CloseHandle(hProc); return "ERR_LOOKUP:"+priv; }
        bool ok = AdjustTokenPrivileges(hTok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
        CloseHandle(hTok); CloseHandle(hProc);
        return ok ? "OK:" + priv : "ERR_ADJUST:" + System.Runtime.InteropServices.Marshal.GetLastWin32Error();
    }
}
"@
Add-Type -TypeDefinition $src -ErrorAction Stop
Write-Output ([PrivHelper]::Enable($Pid, "SeDebugPrivilege"))
Write-Output ([PrivHelper]::Enable($Pid, "SeRestorePrivilege"))
Write-Output ([PrivHelper]::Enable($Pid, "SeBackupPrivilege"))
`;

    try {
        fs.writeFileSync(tempScript, script, 'utf8');
    } catch (e) {
        console.warn('[PRIV] Could not write temp script:', e.message);
        return;
    }

    return new Promise((resolve) => {
        exec(
            `${getPsCommand()} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tempScript}" -Pid ${pid}`,
            { timeout: 15000 },
            (error, stdout, stderr) => {
                // Clean up temp script
                try { fs.unlinkSync(tempScript); } catch (_) { }

                if (error) {
                    console.warn('[PRIV] SeDebugPrivilege enable failed:', error.message);
                } else {
                    const results = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
                    console.log('[PRIV] Privilege adjustment results:', results.join(', '));
                }
                resolve(); // Non-fatal — don't block app startup
            }
        );
    });
}



function createWindow() {
    // ✅ Clear clipboard upon launching
    // clipboard.clear();
    clipboard.write({
        text: '',
        html: '',
        rtf: '',
        bookmark: '',
        image: null
    });
    console.log("Clipboard cleared");

    // ✅ Check for multiple displays
    const displays = screen.getAllDisplays();
    if (displays.length > 1) {
        showErrorTop('Multiple Monitors Detected', 'This application supports only a single monitor setup. Please disconnect additional displays and try again.');
        killKillerAndQuit();
        return;
    }

    screen.on('display-added', () => {
        showErrorTop('Multiple Monitors Detected', 'An external monitor was connected. The app will now close.');
        killKillerAndQuit();
    });

    const preloadPath = path.join(app.getPath('userData'), 'preload-temp.js');
    const preloadContent = `
                const { contextBridge, ipcRenderer } = require('electron');
        
        
                contextBridge.exposeInMainWorld('electronAPI', {
                shutdown: () => ipcRenderer.send('shutdown'),
                onHashCode: (callback) => ipcRenderer.on('hash-code', (event, hash) => callback(hash)),
                onFocusChange: (callback) => ipcRenderer.on('focus-change', (event, data) => callback(data)),
                onConfig: (callback) => ipcRenderer.on('config-details', (event, config) => callback(config)),
                onKillerStopped: (callback) => ipcRenderer.on('killer-stopped', (event, d) => callback()),
        
                });
        
            `;

    fs.writeFileSync(preloadPath, preloadContent);

    // Get details of the primary display
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;

    const win = new BrowserWindow({
        show: false, // 👈 start hidden until loaded
        width,       // 👈 width of primary display
        height,      // 👈 height of primary display
        icon: path.join(__dirname, 'icon.ico'),
        kiosk: true,
        type: 'toolbar',
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: true,
        fullscreen: true,
        frame: false,
        resizable: false,
        movable: false,
        titleBarOverlay: false,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: false,
            preload: preloadPath,
            webviewTag: true,
            enableBlinkFeatures: 'GetDisplayMedia',
            webSecurity: false, // Important for media streams
            allowRunningInsecureContent: true,
            experimentalFeatures: true,
        },
    });

    mainWin = win;

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setFullScreenable(true);
    win.setMenuBarVisibility(false);
    win.loadFile('index.html');

    // win.webContents.openDevTools();
    win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {

        callback(true);
    });


    win.webContents.session.setPermissionCheckHandler((wc, permission, origin, details) => {

        console.log('Permission requested:', permission, 'from', origin);

        return true; // deny all else
    });





    win.webContents.once('did-finish-load', async () => {
        win.show();
        if (global.splashWin && !global.splashWin.isDestroyed()) {
            global.splashWin.close();
        }
        const now = new Date();
        const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
        const hashRaw = days[now.getDay()] + '-' + now.getFullYear() + (now.getMonth() + 1).toString().padStart(2, '0') + now.getDate().toString().padStart(2, '0');
        const hashCode = Buffer.from(hashRaw).toString('base64');

        try {
            let selfChecksum;// = "2b2a765bd50811e22e7e51f1c9007049c45d419b8451e22a128c55e27ebfffb0";
            try {
                selfChecksum = await getChecksum(__filename); // ✅ calculate checksum of main.js
            } catch (checksumErr) {
                console.warn('[SELF-CHECKSUM] Failed to compute actual self-checksum:', checksumErr.message);
            }

            const payload = {
                hashCode,
                mainChecksum: selfChecksum, //selfChecksum, // ✅ include main.js checksum
                key: cachedSKey, // ← use pre-fetched key (getKey() was called before killer spawned)
                isLabMachine: false
            };



            // ✅ Send both to renderer via IPC
            setTimeout(() => {
                if (win && !win.isDestroyed()) {
                    win.webContents.send('hash-code', payload);
                }
            }, 2000);

        } catch (err) {
            console.error('[STARTUP] Startup payload error:', err.message);
            showErrorTop('Startup Error', `Unable to complete startup verification: ${err.message}\n\nPlease check your internet connection and try again.`);
            killKillerAndQuit();
        }

        // Set up webview src and communication
        win.webContents.executeJavaScript(`
        const webview = document.getElementById('main-webview');
        if (webview) {
            webview.src = ${JSON.stringify(URL_TO_OPEN)};
            window.electronAPI.onHashCode((data) => {
                console.log('Received hash code:', data);
                // Send immediately
                webview.executeJavaScript(\`window.postMessage({ type: 'hash-code', data: \${JSON.stringify(data)} }, '*');\`).catch(e => console.log(e));
                
                // Retry sending every 1 second for 15 seconds to guarantee React receives it
                let attempts = 0;
                let interval = setInterval(() => {
                    attempts++;
                    if (attempts > 15) {
                        clearInterval(interval);
                        return;
                    }
                    try {
                        webview.executeJavaScript(\`window.postMessage({ type: 'hash-code', data: \${JSON.stringify(data)} }, '*');\`).catch(e => {});
                    } catch(e) {}
                }, 1000);
            });
            window.electronAPI.onFocusChange((data) => {
                console.log('Received focus change:', data);
                webview.executeJavaScript('console.log("hello");');
                webview.executeJavaScript(\`window.postMessage({ type: 'focus-change', data: \${JSON.stringify(data)} }, '*');\`);
            });
        } else {
            console.warn('Webview not found!');
        }
    `);
    });


    win.focus();

    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('new-window', (e) => e.preventDefault());
    win.webContents.on('context-menu', (e) => e.preventDefault());

    win.webContents.on('before-input-event', (event, input) => {
        // Block all Super (Meta) key combinations immediately
        if (input.meta) {
            event.preventDefault();
        }

        if ((input.control || input.meta) && input.key.toLowerCase() === 'i') event.preventDefault();
        if (
            (input.alt && (input.key.toLowerCase() === 'tab' || input.key.toLowerCase() === 'f4')) ||
            (input.control && (input.key.toLowerCase() === 'w' || input.key.toLowerCase() === 'tab'))
        ) {
            event.preventDefault();
        }
        if (input.alt && input.key.toLowerCase() === ' ') { // ' ' represents Space
            event.preventDefault();
        }
        if (input.alt && input.key.toLowerCase() === 'space') { // ' ' represents Space
            event.preventDefault();
        }
    });

    win.on('minimize', (e) => {
        e.preventDefault();
        win.restore();
        win.focus();
    });
    win.on('maximize', (e) => {
        e.preventDefault();
        win.unmaximize();
        win.focus();
    });

    win.on('leave-full-screen', (e) => {
        // Prevent leaving full screen
        e.preventDefault();
        win.setFullScreen(true);
        win.setKiosk(true);
    });

    // ✅ STRICT FULLSCREEN ENFORCEMENT
    const initialBounds = { x: 0, y: 0, width, height };

    // Helper to force reset
    const forceReset = () => {
        try {
            if (!win || win.isDestroyed()) return;

            // 1. Force Visibility & Focus (Super+D / Minimized protection)
            if (!win.isVisible() || win.isMinimized()) {
                console.log('Window hidden/minimized, forcing restore...');
                win.show();
                win.restore();
            }
            if (!win.isFocused()) {
                console.log('Window lost focus, forcing focus...');
                // win.focus();
                win.moveTop();
            }

            // 2. Force Bounds
            const current = win.getBounds();
            // Allow 1px tolerance although exact match is better
            if (current.width !== width || current.height !== height || current.x !== 0 || current.y !== 0) {
                console.log('Detected size/pos change, resetting...', current);
                win.setBounds(initialBounds);
            }

            // 3. Force Kiosk/Fullscreen
            if (!win.isFullScreen()) win.setFullScreen(true);
            if (!win.isKiosk()) win.setKiosk(true);

            // 4. Force Always On Top
            win.setAlwaysOnTop(true, 'screen-saver');

        } catch (e) {
            console.error('Error enforcing bounds:', e);
        }
    };

    // win.on('resize', forceReset);
    // win.on('move', forceReset);
    // win.on('restore', forceReset);

    // Aggressive blur handling - try to regain focus immediately
    win.on('blur', () => {
        // Short timeout to allow OS to process the blur but then immediately reclaim specific
        setTimeout(forceReset, 100);
        win.webContents.send('focus-change', { focused: true });
    });

    // Failsafe: Check every 500ms (more aggressive than before)
    // const enforcementInterval = setInterval(forceReset, 500);

    // Ensure we clear interval on close
    win.on('closed', () => {
        // clearInterval(enforcementInterval);
    });
    win.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            win.focus();
        }
    });



    win.on('blur', () => {
        win.webContents.send('focus-change', { focused: true });
        console.log('Window blurred from here');
    });

    win.on('focus', () => {
        win.webContents.send('focus-change', { focused: true });
        console.log('Window focused from here');
    });
}

async function isVM() {
    return new Promise((resolve) => {
        const basePath = app.isPackaged ? process.resourcesPath : __dirname;
        const vmDetPath = app.isPackaged
            ? path.join(basePath, 'executables', 'vm_detection.exe')
            : path.join(basePath, 'bin', 'vm_detection.exe');

        if (!fs.existsSync(vmDetPath)) {
            console.warn('[VM] vm_detection.exe not found at:', vmDetPath);
            resolve(false);
            return;
        }

        exec(`"${vmDetPath}"`, (error, stdout, stderr) => {
            if (error) {
                // If exit code is 1, a VM was detected
                if (error.code === 1) {
                    console.log('[VM] Virtual machine detected by external binary.');
                    resolve(true);
                } else {
                    console.warn('[VM] vm_detection.exe exited with error code:', error.code);
                    resolve(false);
                }
            } else {
                console.log('[VM] Bare metal environment confirmed (exit code 0).');
                resolve(false);
            }
        });
    });
}

function blockAllCombos() {
    const modifiers = [
        'Control',
        'Alt',
        'Super' // maps to Windows/Command key
    ];

    // Common keys to block
    const keys = [
        // Function keys
        ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),


        // Special keys
        'Escape', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'
    ];

    // Register single keys
    keys.forEach((key) => {
        globalShortcut.register(key, () => { });
    });

    // Register modifier + key
    modifiers.forEach((mod) => {
        keys.forEach((key) => {
            globalShortcut.register(`${mod}+${key}`, () => { });
        });
    });

    // Register 2-modifier combos
    for (let i = 0; i < modifiers.length; i++) {
        for (let j = i + 1; j < modifiers.length; j++) {
            const combo = `${modifiers[i]}+${modifiers[j]}`;
            keys.forEach((key) => {
                globalShortcut.register(`${combo}+${key}`, () => { });
            });
        }
    }

    // Register 3-modifier combos
    for (let i = 0; i < modifiers.length; i++) {
        for (let j = i + 1; j < modifiers.length; j++) {
            for (let k = j + 1; k < modifiers.length; k++) {
                const combo = `${modifiers[i]}+${modifiers[j]}+${modifiers[k]}`;
                keys.forEach((key) => {
                    globalShortcut.register(`${combo}+${key}`, () => { });
                });
            }
        }
    }
}




async function getSystemDetails() {
    const interfaces = os.networkInterfaces();

    const selectedInterfaces = [];

    for (const name in interfaces) {
        for (const net of interfaces[name]) {
            if (
                !net.internal &&
                net.family === "IPv4" &&
                (name.toLowerCase().includes("ethernet") || name.toLowerCase().includes("wi-fi"))
            ) {
                selectedInterfaces.push({
                    interface: name,
                    ip: net.address,
                    mac: net.mac
                });
            }
        }
    }

    // Proxy settings
    const proxy = await session.defaultSession.resolveProxy("http://example.com");

    // Build JSON config
    const config = {
        os: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            version: os.version()
        },
        network: {
            interfaces: selectedInterfaces
        },
        proxy: {
            settings: proxy
        },
        timestamp: new Date().toISOString()
    };

    return config;
}



app.whenReady().then(async () => {

    if (process.platform === 'win32' && !(process.env.SKIP_PROCESS_KILLER === 'true' || process.argv.includes('--skip-killer'))) {
        try {
            execSync('net session', { stdio: 'ignore' });
        } catch (e) {
            console.log('[ELEVATION] Not running as admin. Requesting elevation...');

            // Detect if we are in development mode (running via 'electron .')
            const isDev = !app.isPackaged;
            let args = process.argv.slice(1);

            if (isDev && args.length > 0 && (args[0] === '.' || args[0].includes('main.js'))) {
                // In dev mode, we need to preserve the entry point path
            } else if (isDev) {
                args.unshift('.');
            }

            // Properly escape arguments for PowerShell Start-Process
            const argsList = args.map(arg => `\\"${arg.replace(/"/g, '`\"')}\\"`).join(',');
            const elevateCmd = `Start-Process -FilePath \\"${process.execPath}\\" ${args.length > 0 ? `-ArgumentList ${argsList}` : ''} -Verb RunAs`;

            console.log('[ELEVATION] Executing:', elevateCmd);
            const ps = getPsCommand();
            exec(`${ps} -NoProfile -ExecutionPolicy Bypass -Command "${elevateCmd}"`, (err) => {
                if (err) {
                    console.error('[ELEVATION] Failed to relaunch as admin:', err);
                    showErrorTop('Elevation Failed', 'This app requires Administrator privileges to function. Please right-click and "Run as administrator".');
                }
                app.quit();
            });
            return;
        }
    }

    // ✅ ADD SPLASH SCREEN
    const splashHTML = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body {
                margin: 0; padding: 0;
                background-color: #0d1117;
                color: #c9d1d9;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                display: flex; flex-direction: column;
                justify-content: center; align-items: center;
                height: 100vh; overflow: hidden;
            }
            .container {
                display: flex; flex-direction: column; align-items: center;
                background: rgba(22, 27, 34, 0.7);
                border: 1px solid #30363d; border-radius: 12px;
                padding: 40px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            }
            .spinner {
                width: 50px; height: 50px;
                border: 4px solid rgba(88, 166, 255, 0.2);
                border-top: 4px solid #58a6ff; border-radius: 50%;
                animation: spin 1s linear infinite; margin-bottom: 20px;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            h1 { font-size: 1.2rem; font-weight: 500; margin: 0; letter-spacing: 0.5px; }
            p { font-size: 0.9rem; color: #8b949e; margin-top: 8px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="spinner"></div>
            <h1>Starting TheEduCode</h1>
            <p>Please wait while we set things up...</p>
        </div>
    </body>
    </html>
    `;

    global.splashWin = new BrowserWindow({
        width: 450, height: 350,
        transparent: true, frame: false,
        alwaysOnTop: true, center: true, resizable: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    global.splashWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHTML));

    // ✅ ADD THIS BLOCK — check updates before anything else
    const updateTriggered = await checkForUpdates();
    if (updateTriggered) return; // Updater launched, stop here

    // ✅ WHITELIST APP DIRECTORY IN WINDOWS DEFENDER
    // Must run BEFORE bootstrapper downloads process_killer.exe to prevent quarantine.
    if (!(process.env.SKIP_PROCESS_KILLER === 'true' || process.argv.includes('--skip-killer'))) {
        try {
            const appDir = app.isPackaged ? path.dirname(process.execPath) : __dirname;
            execSync(`powershell.exe -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionPath '${appDir.replace(/'/g, "''")}';"`, { stdio: 'ignore', timeout: 10000, windowsHide: true });
            console.log('[DEFENDER] Exclusion added for:', appDir);
        } catch (e) {
            console.warn('[DEFENDER] Failed to add exclusion (non-fatal):', e.message);
        }
    }

    // ✅ FIRST-LAUNCH BOOTSTRAP — Download process_killer + assets from GitHub
    const bootstrapOk = await runBootstrap();
    if (!bootstrapOk) {
        console.error('[BOOTSTRAP] Setup failed. Cannot proceed.');
        app.quit();
        return;
    }

    if (process.platform === 'win32' && !(process.env.SKIP_PROCESS_KILLER === 'true' || process.argv.includes('--skip-killer'))) {
        // ✅ SYSTEM HARDENING (Registry Adjustments)
        // Now that we are confirmed Admin, we can run these directly.
        const registryCommands = [
            'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v HideFastUserSwitching /t REG_DWORD /d 1 /f',
            'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v NoLogoff /t REG_DWORD /d 1 /f',
            'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableLockWorkstation /t REG_DWORD /d 1 /f',
            'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableTaskMgr /t REG_DWORD /d 1 /f'
        ].join('; ');

        try {
            execSync(`${getPsCommand()} -Command "${registryCommands}"`, { stdio: 'inherit' });
            console.log('System policies applied successfully.');
        } catch (error) {
            console.error('Failed to apply system policies:', error.message);
        }

        exec(`${getPsCommand()} Set-Clipboard -Value ""`, (error, stdout, stderr) => {
            if (error) {
                console.error('Clipboard clear error:', error);
            } else {
                console.log('Clipboard cleared via PowerShell.');
            }
        });
    }

    if (!(await verifyFileIntegrity())) return;

    // Internet Connectivity Check
    const checkConnectivity = async () => {
        try {
            await robustFetch('https://example.com', { method: 'HEAD', cache: 'no-store' });
            return true;
        } catch (error) {
            return false;
        }
    };

    if (!(await checkConnectivity())) {
        const response = dialog.showMessageBoxSync({
            type: 'error',
            buttons: ['OK'],
            title: 'Connection Error',
            message: 'No internet connection detected.',
            detail: 'Please check your internet connection and try again.'
        });
        if (response === 0) {
            killKillerAndQuit();
            return;
        }
    }


    // Proxy settings
    const proxy = await session.defaultSession.resolveProxy("http://example.com");
    if (proxy && proxy != 'DIRECT') {
        showErrorTop('Proxy Detected', 'Please disable any proxy settings and try again.');
        killKillerAndQuit();
        return;
    }

    // Bluetooth Check
    const bluetoothOn = await checkBluetooth();
    if (bluetoothOn) {
        showErrorTop(
            'Bluetooth Detected',
            'Bluetooth is currently enabled on your system.\n\nPlease turn off Bluetooth and restart the application to continue.'
        );
        killKillerAndQuit();
        return;
    }

    // VM Check
    const vmDetected = await isVM();
    if (vmDetected) {
        showErrorTop('Virtual Machine Detected', 'This application cannot run inside a virtual machine.');
        killKillerAndQuit();
        return;
    }

    // ✅ Initialize session key + pre-fetch s_key BEFORE spawning process_killer.
    // Both network calls must complete here — once the killer is running its
    // scan loop (every 3s), any new network activity risks being disrupted.
    try {
        await getMasterKey();
    } catch (err) {
        showErrorTop('Initialization Error', 'Failed to initialize security session: ' + err.message);
        killKillerAndQuit();
        return;
    }

    try {
        cachedSKey = await getKey();
        console.log('[GETKEY] Pre-fetched s_key successfully (before killer spawn).');
    } catch (err) {
        showErrorTop('Initialization Error', 'Failed to pre-fetch security key: ' + err.message);
        killKillerAndQuit();
        return;
    }

    const basePath = app.isPackaged ? process.resourcesPath : __dirname;
    const killerPath = app.isPackaged ? path.join(basePath, 'executables', 'process_killer.exe') : path.join(basePath, 'bin', 'process_killer.exe');

    // ✅ Enable SeDebugPrivilege in our own token BEFORE spawning process_killer.exe,
    // so the child process inherits it as already-enabled (not just present-but-disabled).
    await enableDebugPrivilegeForSelf();

    try {
        if (process.env.SKIP_PROCESS_KILLER === 'true' || process.argv.includes('--skip-killer')) {
            console.log('[DEBUG] Skipping process killer execution as requested (--skip-killer / SKIP_PROCESS_KILLER).');
        } else {
            console.log('[DEBUG] Process killer execution ENGAGED.');

            const { dialog, BrowserWindow } = require('electron');
            const focusedWin = BrowserWindow.getFocusedWindow() || (typeof global.splashWin !== 'undefined' && global.splashWin && !global.splashWin.isDestroyed() ? global.splashWin : null);
            const dialogOpts = {
                type: 'warning',
                buttons: ['Accept & Continue', 'Exit'],
                defaultId: 0,
                title: 'System Verification Required',
                message: 'To ensure a secure testing environment, this application must verify your system processes.',
                detail: 'Please accept to allow background verification. Declining will exit the application.'
            };
            const response = focusedWin ? dialog.showMessageBoxSync(focusedWin, dialogOpts) : dialog.showMessageBoxSync(dialogOpts);
            if (response === 1) { // User clicked 'Exit'
                app.quit();
                return;
            }

            killerProcess = spawn(killerPath, ['--key', Buffer.from(sessionKey, 'utf8').toString('hex')], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let killerReady = false;

            killerProcess.stdout.on('data', (data) => {
                const rawData = data.toString('binary');

                // Handle both prefixed and raw XOR messages
                let payload = rawData;
                if (rawData.startsWith('[CRYPT] ')) {
                    payload = rawData.slice(8).replace(/\n$/, '');
                } else {
                    payload = rawData.replace(/\n$/, '');
                }

                const decryptedData = decryptIPC(payload, sessionKey);

                console.log(`[KILLER stdout]: ${decryptedData || rawData}`);

                if (
                    (decryptedData && (decryptedData.includes('Monitoring') || decryptedData.includes('Baselined') || decryptedData.includes('SeDebugPrivilege'))) ||
                    (rawData && (rawData.includes('WATCHER') || rawData.includes('Baselined') || rawData.includes('SeDebugPrivilege') || rawData.includes('RESTRICTIVE MODE ENGAGED')))
                ) {
                    killerReady = true;
                }

            });

            killerProcess.stderr.on('data', (data) => {
                console.error(`[KILLER stderr]: ${data}`);
            });

            killerProcess.on('exit', (code) => {
                console.log(`[KILLER exited with code]: ${code}`);
                if (!app.isQuitting) {
                    app.isQuitting = true;
                    if (mainWin) mainWin.destroy();
                    showErrorTop('Unauthorized Activity Detected', 'Your Detailes are sent to our system and strict actions might be taken against you.');
                    killKillerAndQuit();
                }
            });

            await new Promise((resolve, reject) => {
                let attempts = 0;
                const checkReady = setInterval(() => {
                    attempts++;
                    if (killerReady) {
                        clearInterval(checkReady);
                        resolve();
                    } else if (attempts > 30) {
                        clearInterval(checkReady);
                        reject(new Error('Process killer failed to initialize.'));
                    }
                }, 500);
            });

            // Check process status every 5 seconds
            const monitorInterval = setInterval(() => {
                if (!app.isQuitting && killerProcess && (killerProcess.killed || killerProcess.exitCode !== null)) {
                    console.log('Process killer is not active. Initiating shutdown.');
                    app.isQuitting = true;
                    clearInterval(monitorInterval); // Stop monitoring
                    if (mainWin) { // Check if window exists
                        mainWin.destroy();
                    }
                    showErrorTop('Unauthorized Activity Detected', 'Your Detailes are sent to our system and strict actions might be taken against you.');
                    killKillerAndQuit();
                }
            }, 5000);

            // Ensure interval is cleared on app quit
            app.on('before-quit', () => {
                clearInterval(monitorInterval);
            });
        }



        // start express server inside electron
        const server = express();
        const modelsPath = app.isPackaged ? path.join(process.resourcesPath, 'assests/models') : path.join(__dirname, 'assests/models');
        server.use('/models', express.static(modelsPath));
        server.listen(6969, () => console.log('Model server running on http://localhost:3000/models'));


        createWindow();

        // globalShortcut.register('CommandOrControl+Shift+I', () => { });
        globalShortcut.register('F11', () => { });
        globalShortcut.register('Alt+Tab', () => { });
        globalShortcut.register('Alt+F4', () => { });
        globalShortcut.register('Control+W', () => { });
        globalShortcut.register('Control+Tab', () => { });
        globalShortcut.register('Control+Alt+Delete', () => { });
        blockAllCombos();



    } catch (err) {
        console.error(`[KILLER ERROR]: ${err.message}`);
        showErrorTop('Startup Failed', 'Could not launch or verify process_killer.exe:\n\n' + err.message);
        killKillerAndQuit();
        // createWindow();
    }
});







ipcMain.on('shutdown', () => {
    app.isQuitting = true;
    killKillerAndQuit();
});

app.on('window-all-closed', (e) => {
    if (e) e.preventDefault();
});

ipcMain.on('permission', (event) => {
    permissionG = true;
    if (cancelDelay) cancelDelay();
});

function sendConfig(data) {
    // Set up webview src and communication
    setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('config-details', data);
        }
    }, 2000);
    if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.executeJavaScript(`
        
        if (document.getElementById('main-webview')) {
            document.getElementById('main-webview').executeJavaScript("console.log('h1');");
            window.electronAPI.onConfig((data) => {
                console.log('Received config details:', data);
                document.getElementById('main-webview').executeJavaScript(\`window.postMessage({ type: 'config-details', data: \${JSON.stringify(data)} }, '*');\`);
            });

        } else {
            console.warn('Webview not found!');
        }
    `);
    }


}

ipcMain.on('configRequest', async () => {
    console.log("got request");
    const config = await getSystemDetails();
    sendConfig(config);

});

// Local Execution Router
const { runJS } = require('./execution/jsHandler');
const { runCpp } = require('./execution/cppHandler.js');
const { runJava } = require('./execution/javaHandler.js');
const { runPython } = require('./execution/pythonHandler.js');

let engineWin = null;

app.whenReady().then(() => {
    engineWin = new BrowserWindow({
        show: false,
        frame: false,
        skipTaskbar: true,
        title: 'System Execution Engine',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            offscreen: true
        }
    });
    const engineHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>TheEduCode Execution Engine</title>
</head>
<body style="background: #0d1117; color: #c9d1d9; font-family: monospace; padding: 20px;">
    <h2>Execution Engine Service</h2>
    <div id="status">Initializing Context...</div>
    <script>
        const { ipcRenderer } = require('electron');
    </script>
</body>
</html>`;
    engineWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(engineHTML));
});

ipcMain.handle('get-compiler-status', (event) => {
    const os = require('os');
    const totalMemBytes = os.totalmem();
    const totalMemGB = totalMemBytes / (1024 * 1024 * 1024);
    const hasEnoughRam = totalMemGB > 4.0;

    return {
        isAvailable: hasEnoughRam,
        supportedLanguages: [50, 54, 62, 63, 71, 93],
        totalRamGB: parseFloat(totalMemGB.toFixed(2))
    };
});

ipcMain.handle('run-code', async (event, payload) => {
    const os = require('os');
    if (os.totalmem() / (1024 ** 3) <= 4.0) {
        return {
            compile_success: false,
            compile_error: "System does not meet minimum RAM requirements (4GB) for offline compilation.",
            run_success: false,
            run_error: "",
            stdout: "",
            stderr: "",
            results: []
        };
    }

    const { userWrittenCode, languageId, sampleInputOutput, files } = payload;

    try {
        if (languageId === 63 || languageId === 93) {
            // JavaScript
            const results = await runJS(userWrittenCode, sampleInputOutput);
            return results;
        } else if (languageId === 50 || languageId === 54) {
            // C / C++
            const results = await runCpp(userWrittenCode, languageId, sampleInputOutput);
            return results;
        } else if (languageId === 71) {
            // Python
            const results = await runPython(userWrittenCode, sampleInputOutput);
            return results;
        } else if (languageId === 62) {
            // Java (Modular custom JDK 21)
            const results = await runJava(userWrittenCode, sampleInputOutput, files);
            return results;
        }
    } catch (err) {
        console.error('Execution Error:', err);
        const errResults = sampleInputOutput.map((io, i) => ({
            [`testCase${i + 1}`]: {
                input: io[0],
                testCasePassed: false,
                expectedOutput: io[1],
                userOutput: "",
                compilerMessage: err.toString(),
                time: "0.000",
                memory: 0,
                statusId: 12,
                statusDescription: "Runtime Error (NZEC)"
            }
        }));
        return errResults;
    }
});
