# EdoCode Browser

This is an Electron.js-based browser that opens only one URL in kiosk mode. It disables navigation, context menu, and dev tools, and prevents new windows or tabs. The app stays always on top and restricts user access to other apps as much as possible.

## How to Use

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Start the browser:
   ```powershell
   npm start
   ```
3. To change the URL, edit the `URL_TO_OPEN` variable in `main.js`.

## Features
- Kiosk mode (full screen, no window controls)
- Only one URL allowed
- Navigation, context menu, and dev tools are disabled
- Always on top
- Attempts to block common shortcuts (F11, Alt+Tab, Ctrl+Shift+I)

## Limitations
- Electron cannot fully block all background apps on Windows, but kiosk mode and always-on-top help restrict user access.
