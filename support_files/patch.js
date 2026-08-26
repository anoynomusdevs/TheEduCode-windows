const fs = require('fs');
let code = fs.readFileSync('main.js', 'utf8');

// Replace all existing dialog.showErrorBox BEFORE injecting the wrapper
code = code.replace(/dialog\.showErrorBox\(/g, 'showErrorTop(');

const wrapper = `
function showErrorTop(title, msg) {
    const { dialog } = require('electron');
    if (typeof mainWin !== 'undefined' && mainWin && !mainWin.isDestroyed()) {
        dialog.showMessageBoxSync(mainWin, { type: 'error', title: title, message: msg });
    } else {
        dialog.showErrorBox(title, msg);
    }
}
`;

if (!code.includes('function showErrorTop')) {
    code = code.replace('const { app, ', wrapper + '\nconst { app, ');
}

fs.writeFileSync('main.js', code);