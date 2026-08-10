/**
 * bootstrapper.js — First-Launch Asset Downloader
 * 
 * Downloads all external security and model assets from GitHub Releases on first launch.
 * Shows a premium progress dialog with real-time download tracking.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ════════════════════════════════════════════════════════════════
// Configuration — Update these URLs when you create a GitHub Release
// ════════════════════════════════════════════════════════════════
const GITHUB_RELEASE_BASE = 'https://github.com/MOHITRAJDEO12345/browser-assets/releases/download/v1.6.0';

const ASSETS = [
    {
        name: 'models.zip',
        url: `${GITHUB_RELEASE_BASE}/models.zip`,
        destDir: () => path.join(getAppDir(), 'assests'),
        destName: 'models',
        isZip: true,
        label: 'AI Face Detection Models',
        sizeMB: 23,
        validationFile: 'blazeface.json'
    },
    {
        name: 'pyodide.zip',
        url: `${GITHUB_RELEASE_BASE}/pyodide.zip`,
        destDir: () => path.join(getAppDir(), 'execution'),
        destName: 'lib',
        isZip: true,
        label: 'Python Engine (Pyodide)',
        sizeMB: 5,
        validationFile: 'pyodide.asm.wasm'
    },
    {
        name: 'compilers-gcc-14.1.0.zip',
        url: `${GITHUB_RELEASE_BASE}/compilers-gcc-14.1.0.zip`,
        destDir: () => path.join(getCompilersDir(), 'win'),
        destName: 'mingw64',
        isZip: true,
        label: 'C/C++ Compiler (GCC 14.1.0)',
        sizeMB: 154,
        validationFile: 'bin'
    },
    {
        name: 'compilers-java-21.zip',
        url: `${GITHUB_RELEASE_BASE}/compilers-java-21.zip`,
        destDir: () => path.join(getCompilersDir(), 'win'),
        destName: 'java',
        isZip: true,
        label: 'Java Compiler (OpenJDK 21)',
        sizeMB: 42,
        validationFile: 'bin'
    }
];

// ════════════════════════════════════════════════════════════════
// Path Helpers
// ════════════════════════════════════════════════════════════════
function getAppRoot() {
    return __dirname;
}

function getResourcesDir() {
    return app.isPackaged ? process.resourcesPath : getAppRoot();
}

function getAppDir() {
    return app.isPackaged ? process.resourcesPath : getAppRoot();
}

function getCompilersDir() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'compilers')
        : path.join(getAppRoot(), 'compilers');
}

// ════════════════════════════════════════════════════════════════
// Check which assets are missing
// ════════════════════════════════════════════════════════════════
function getMissingAssets() {
    const missing = [];
    for (const asset of ASSETS) {
        let checkPath;
        if (asset.isZip) {
            // Check if the extracted folder exists
            checkPath = path.join(asset.destDir(), asset.destName);
        } else {
            checkPath = path.join(asset.destDir(), asset.destName);
        }

        if (!fs.existsSync(checkPath)) {
            missing.push(asset);
        } else if (!asset.isZip) {
            // For exe files, also check if file is not empty / corrupted
            const stat = fs.statSync(checkPath);
            if (stat.size < 1000) {
                missing.push(asset);
            }
        } else if (asset.validationFile) {
            // For zip-extracted folders, check that the validation file/folder exists
            const validPath = path.join(checkPath, asset.validationFile);
            if (!fs.existsSync(validPath)) {
                missing.push(asset);
            }
        }
    }
    return missing;
}

// ════════════════════════════════════════════════════════════════
// Download with redirect support (GitHub releases use 302 redirects)
// ════════════════════════════════════════════════════════════════
function downloadFile(url, destPath, onProgress, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            return reject(new Error('Too many redirects'));
        }

        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
            headers: { 'User-Agent': 'TheEduCode-Browser/1.5.0' }
        }, (response) => {
            // Handle redirects (301, 302, 303, 307, 308)
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const redirectUrl = response.headers.location;
                if (!redirectUrl) {
                    return reject(new Error('Redirect with no location header'));
                }
                return downloadFile(redirectUrl, destPath, onProgress, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
            }

            if (response.statusCode !== 200) {
                return reject(new Error(`HTTP ${response.statusCode}: Failed to download`));
            }

            const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedBytes = 0;

            // Ensure destination directory exists
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            const fileStream = fs.createWriteStream(destPath);

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0 && onProgress) {
                    onProgress(downloadedBytes, totalBytes);
                }
            });

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (err) => {
                fs.unlink(destPath, () => {}); // Clean up partial file
                reject(err);
            });
        });

        request.on('error', (err) => {
            reject(err);
        });

        request.setTimeout(60000, () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

// ════════════════════════════════════════════════════════════════
// Extract ZIP using PowerShell / Tar (no 7-zip dependency needed)
// ════════════════════════════════════════════════════════════════
function extractZip(zipPath, destDir, expectedFolderName) {
    // Create a temp extraction directory
    const tempExtractDir = path.join(destDir, '_temp_extract_' + Date.now());
    
    // Ensure the temp directory exists (tar requires this)
    if (!fs.existsSync(tempExtractDir)) {
        fs.mkdirSync(tempExtractDir, { recursive: true });
    }
    
    try {
        // Use Windows built-in tar.exe for extraction (up to 10x faster than PowerShell Expand-Archive)
        const cmd = `tar.exe -xf "${zipPath}" -C "${tempExtractDir}"`;
        execSync(cmd, { stdio: 'ignore', timeout: 300000, windowsHide: true }); // 5-minute timeout for large ZIPs

        // The ZIP contains a folder
        const extractedItems = fs.readdirSync(tempExtractDir);
        
        let sourceDir;
        if (extractedItems.length === 1 && fs.statSync(path.join(tempExtractDir, extractedItems[0])).isDirectory()) {
            // ZIP contained a single folder — move it
            sourceDir = path.join(tempExtractDir, extractedItems[0]);
        } else {
            // ZIP contained files directly — the temp dir IS the source
            sourceDir = tempExtractDir;
        }

        const finalDest = path.join(destDir, expectedFolderName);

        // Remove existing destination if it exists (corrupted previous attempt)
        if (fs.existsSync(finalDest)) {
            fs.rmSync(finalDest, { recursive: true, force: true });
        }

        // Move (rename) the extracted folder to the final name
        fs.renameSync(sourceDir, finalDest);

        // Clean up temp directory if it still exists
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }

        // Delete the ZIP file to free space
        fs.unlinkSync(zipPath);

        return true;
    } catch (err) {
        // Clean up on failure
        try { if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch(_) {}
        try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch(_) {}
        throw err;
    }
}

// ════════════════════════════════════════════════════════════════
// Progress Window (Checklist-based UI)
// ════════════════════════════════════════════════════════════════
function createProgressWindow(allAssets, missingAssets) {
    const win = new BrowserWindow({
        width: 580,
        height: 420,
        icon: path.join(getAppDir(), 'icon.ico'),
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        frame: false,
        alwaysOnTop: true,
        center: true,
        backgroundColor: '#0a0a0f',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const missingNames = missingAssets.map(a => a.name);
    
    const assetHtml = allAssets.map(a => {
        const isMissing = missingNames.includes(a.name);
        const icon = isMissing ? '⏳' : '✅';
        const detail = isMissing ? 'Pending' : 'Already installed';
        const color = isMissing ? '#7a8ba8' : '#4caf50';
        return `
        <div class="asset-item" id="asset-${a.name.replace(/[^a-zA-Z0-9]/g, '')}">
            <div class="asset-header">
                <span class="icon" style="color: ${color}">${icon}</span>
                <span class="label">${a.label}</span>
                <span class="detail">${detail}</span>
            </div>
            <div class="progress-container" style="display: none;">
                <div class="progress-bar"></div>
            </div>
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
        font-family: 'Segoe UI', system-ui, sans-serif;
        background: linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 50%, #16213e 100%);
        color: #e0e0e0;
        display: flex;
        flex-direction: column;
        height: 100vh;
        padding: 30px;
        -webkit-app-region: drag;
        user-select: none;
    }
    .logo { font-size: 22px; font-weight: 700; color: #00d4ff; margin-bottom: 4px; letter-spacing: 1px; }
    .subtitle { font-size: 12px; color: #7a8ba8; margin-bottom: 20px; }
    
    .asset-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        flex: 1;
        overflow-y: auto;
    }
    .asset-item {
        background: rgba(255,255,255,0.05);
        border-radius: 8px;
        padding: 12px 16px;
        border: 1px solid rgba(255,255,255,0.05);
    }
    .asset-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .icon { font-size: 16px; margin-right: 12px; width: 20px; text-align: center; }
    .label { flex: 1; font-size: 14px; font-weight: 500; }
    .detail { font-size: 12px; color: #7a8ba8; }
    
    .progress-container {
        width: 100%;
        background: rgba(0,0,0,0.3);
        border-radius: 6px;
        overflow: hidden;
        height: 6px;
        margin-top: 10px;
    }
    .progress-bar {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #00d4ff, #7b2ff7);
        border-radius: 6px;
        transition: width 0.2s ease;
    }
</style>
</head>
<body>
    <div class="logo">TheEduCode</div>
    <div class="subtitle">First-time setup — downloading required components</div>
    
    <div class="asset-list">
        ${assetHtml}
    </div>

    <script>
        const { ipcRenderer } = require('electron');
        ipcRenderer.on('progress-update', (e, data) => {
            const id = 'asset-' + data.assetId;
            const el = document.getElementById(id);
            if (!el) return;

            const iconEl = el.querySelector('.icon');
            const detailEl = el.querySelector('.detail');
            const progCont = el.querySelector('.progress-container');
            const progBar = el.querySelector('.progress-bar');

            if (data.status === 'downloading') {
                iconEl.textContent = '⬇️';
                iconEl.style.color = '#00d4ff';
                detailEl.textContent = data.text;
                progCont.style.display = 'block';
                progBar.style.width = data.percent + '%';
            } else if (data.status === 'extracting') {
                iconEl.textContent = '📦';
                iconEl.style.color = '#7b2ff7';
                detailEl.textContent = data.text;
                progCont.style.display = 'block';
                progBar.style.width = '100%';
            } else if (data.status === 'done') {
                iconEl.textContent = '✅';
                iconEl.style.color = '#4caf50';
                detailEl.textContent = 'Complete';
                progCont.style.display = 'none';
            }
        });
    </script>
</body>
</html>`;

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return win;
}

// ════════════════════════════════════════════════════════════════
// Main Bootstrap Entry Point
// ════════════════════════════════════════════════════════════════
async function runBootstrap() {
    const missing = getMissingAssets();

    if (missing.length === 0) {
        console.log('[BOOTSTRAP] All assets present. Skipping download.');
        return true; // Everything is already set up
    }

    console.log('[BOOTSTRAP] Missing assets:', missing.map(a => a.name).join(', '));

    // Show the progress window
    const progressWin = createProgressWindow(ASSETS, missing);

    // Wait for the window to load
    await new Promise(resolve => {
        progressWin.webContents.once('did-finish-load', resolve);
    });

    try {
        for (const asset of missing) {
            const assetId = asset.name.replace(/[^a-zA-Z0-9]/g, '');

            // Update status: Downloading
            progressWin.webContents.send('progress-update', {
                assetId,
                status: 'downloading',
                text: `Starting download...`,
                percent: 0
            });

            const tempPath = asset.isZip
                ? path.join(asset.destDir(), asset.name)
                : path.join(asset.destDir(), asset.destName);

            // Ensure destination directory exists
            const destDir = path.dirname(tempPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            // Download
            await downloadFile(asset.url, tempPath, (downloaded, total) => {
                const pct = Math.min(99, Math.round((downloaded / total) * 100));
                const dlMB = (downloaded / 1048576).toFixed(1);
                const totalMB = (total / 1048576).toFixed(1);
                progressWin.webContents.send('progress-update', {
                    assetId,
                    status: 'downloading',
                    text: `${dlMB} / ${totalMB} MB (${pct}%)`,
                    percent: pct
                });
            });

            // Extract if ZIP
            if (asset.isZip) {
                progressWin.webContents.send('progress-update', {
                    assetId,
                    status: 'extracting',
                    text: `Extracting files...`,
                    percent: 100
                });

                extractZip(tempPath, asset.destDir(), asset.destName);
            }

            // Done with this step
            progressWin.webContents.send('progress-update', {
                assetId,
                status: 'done'
            });

            // Brief pause so user sees the checkmark
            await new Promise(r => setTimeout(r, 600));
        }

        await new Promise(r => setTimeout(r, 1200));
        progressWin.destroy();
        return true;

    } catch (err) {
        console.error('[BOOTSTRAP] Download failed:', err);
        progressWin.destroy();

        const { dialog, BrowserWindow } = require('electron');
        const focusedWin = BrowserWindow.getFocusedWindow() || (typeof global.splashWin !== 'undefined' && global.splashWin && !global.splashWin.isDestroyed() ? global.splashWin : null);
        const dialogOpts = {
            type: 'error',
            title: 'Setup Failed',
            message: `Failed to download required components:\n\n${err.message}\n\nPlease check your internet connection and restart the application.`
        };
        if (focusedWin) {
            dialog.showMessageBoxSync(focusedWin, dialogOpts);
        } else {
            dialog.showErrorBox(dialogOpts.title, dialogOpts.message);
        }
        return false;
    }
}

module.exports = { runBootstrap, getMissingAssets };
