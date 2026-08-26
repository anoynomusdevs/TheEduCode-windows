# EduCode Browser: Stability, Reliability & Accessibility Enhancement Plan

## Overview
This document outlines changes to make the EduCode Browser (Tauri/Edge WebView2-based) more reliably stable, easily usable, and accessible for students. It combines insights from both the EduCode Browser repository and the process-killer-rust lockdown engine.

---

## Immediate Changes (Implementable Within 1 Day)

### 1. Improve Startup Error Handling & Reporting
- **Current**: Pre-flight checks in `preflight.html` have generic failure messages
- **Fix**: Add specific error codes and user-friendly explanations for each check failure
- **Files**: `preflight.html`, `src/main.js`
- **Impact**: Students understand what went wrong and can report accurately

### 2. Add Accessible Browser Controls
- **Current**: Keyboard hooks block Alt+Tab, Windows Key, but no visual indication
- **Fix**: Add accessible overlay showing blocked keys status, with configurable toggle for assistive needs
- **Impact**: Better accessibility for students who need accommodation

### 3. Fix Memory Leak in Loading Screen
- **Current**: `loading.html` battery/WiFi status polling may leak handles
- **Fix**: Ensure all `navigator.getBattery()` and `navigator.connection` listeners are properly cleared on exit
- **Files**: `loading.html`, `webviewPreload.js`
- **Impact**: Prevents gradual slowdown over long exam sessions

### 4. Add Graceful Shutdown Path
- **Current**: Shutdown via IPC has limited fallback paths
- **Fix**: Add explicit `window.close()` → Tauri `invoke('shutdown')` → process kill chain with 3-second timeout
- **Files**: `index.html`, `src/main.js`
- **Impact**: Prevents hung processes after exam completion

### 5. Stabilize Registry Lockdown Re-application
- **Current**: Registry modifications (DisableTaskMgr, etc.) re-applied every 3 seconds via watchdog
- **Fix**: Add change-detection so registry values are only re-applied if they've been modified/removed
- **Impact**: Reduces unnecessary CPU cycles, prevents flicker/flashing from repeated writes



## Warning Message Differentiation

### Current Warning Categories (from preflight.html architecture)

| Code | Message Type | Cause | Action |
|------|-------------|-------|--------|
| `ERR_NET_NO_INTERNET` | Critical | No network connectivity | Cannot start exam; check cable/WiFi |
| `ERR_VM_DETECTED` | Critical | VM/hypervisor detected | Exam cannot run in virtualized environment |
| `ERR_RESOURCES_LOW` | Warning | Memory/disk below threshold | Exam may perform poorly; free space recommended |
| `ERR_MONITOR_COUNT` | Critical | >1 display monitor detected | Detach extra monitors; exam requires single display |
| `ERR_PROXY_DETECTED` | Warning | Network proxy detected | May indicate man-in-the-middle; proceed at own risk |
| `ERR_EULA_NOT_ACCEPTED` | Critical | EULA not accepted | Must accept End User License Agreement |
| `ERR_SECURITY_VIOLATION` | Critical | Security feature triggered | Contact proctor; exam terminated |

### Recommended Additional Warning Types

| Code | Message Type | Cause | Action |
|------|-------------|-------|--------|
| `ERR_DEBUGGER_DETECTED` | Critical | Debugger attached | Close debugger; exam will restart |
| `ERR_PROCESS_BLACKLISTED` | Critical | Prohibited process running | Close blacklisted process; re-launch exam |
| `ERR_CSP_VIOLATION` | High | Content Security Policy breach | Report to support; may indicate tampering |
| `ERR_WINDOW_OVERLAY` | High | Window overlay detected | Remove overlay; exam paused |
| `ERR_INPUT_HOOK_ACTIVE` | Info | Keyboard/mouse hooks active | Some shortcuts disabled for exam integrity |
| `ERR_UPDATE_AVAILABLE` | Info | New version available | Update recommended after exam |

### Warning Message Prioritization

```
CRITICAL (Exam cannot proceed):
- ERR_NO_INTERNET
- ERR_VM_DETECTED
- ERR_MONITOR_COUNT
- ERR_EULA_NOT_ACCEPTED
- DEBUGGER_DETECTED
- PROCESS_BLACKLISTED

WARNING (Proceed with caution):
- ERR_RESOURCES_LOW
- ERR_PROXY_DETECTED
- CSP_VIOLATION

INFO (Observational):
- INPUT_HOOK_ACTIVE
- UPDATE_AVAILABLE
```

---

## Later Implementations (Roadmap)

### 1. GStreamer Hardware Streaming Pipeline
- **Reference**: `dependency.md` (39 required DLLs)
- **Plan**: Add hardware-accelerated video streaming for remote proctoring
- **Effort**: 2-3 days (DLL dependency resolution + pipeline setup)

### 2. Advanced Error Code System
- **Reference**: Existing `ERR_*` codes in docs
- **Plan**: Standardize all error codes across frontend/backend with machine-readable format
- **Effort**: 1 day

### 3. Themed Accessibility Toggle
- **Reference**: `preflight.html` has theme toggle (dark/light)
- **Plan**: Add high-contrast mode, font size scaling, screen reader compatibility
- **Effort**: 1 day

### 4. OTA Update with Rollback
- **Reference**: `@tauri-apps/plugin-updater` config
- **Plan**: Add update checksum verification; automatic rollback on failed update
- **Effort**: 2 days

### 5. Multi-Language Support
- **Reference**: i18n not currently implemented
- **Plan**: Add English/Spanish/French localization for error messages and UI
- **Effort**: 3-5 days

### 6. Telemetry/Opt-Out Mechanism
- **Reference**: Update system endpoints
- **Plan**: Add user consent for crash reports/telemetry; opt-out toggle in settings
- **Effort**: 2 days

### 7. Crash Recovery & Restart
- **Reference**: Current shutdown IPC paths
- **Plan**: Add automatic restart with last-chance diagnostics on unexpected exit
- **Effort**: 2-3 days

### 8. Parental/Teacher Override Mode
- **Reference**: Existing `restore_student.cjs`, `send_ota*.js`
- **Plan**: Add secure override mode for teachers with authentication
- **Effort**: 3-4 days

### 9. Docker/Containerized Deployment
- **Reference**: Build scripts, `build_windows.bat`
- **Plan**: Containerize the Tauri app for easier school IT deployment
- **Effort**: 5+ days

### 10. Full Audit Log System
- **Reference**: `digital-twin/` directory, `commit_c4e1740.diff` audit_logger
- **Plan**: Comprehensive audit logging of exam sessions with privacy-compliant data retention
- **Effort**: 3-5 days

---

## Implementation Priority Matrix

| Priority | Feature | Effort | Impact | Dependencies |
|----------|---------|--------|--------|-------------|
| P0 (1 day) | Improved error messages | 0.5 day | High | None |
| P0 (1 day) | Graceful shutdown | 0.5 day | High | None |
| P1 (2-3 days) | VM detection integration | 2 days | Medium | vm_detect.rs port |
| P1 (2-3 days) | Win32 Job Object | 2 days | High | Tauri Win32 API |
| P1 (2-3 days) | Anti-debugger hooks | 1 day | Medium | anti_debug.rs port |
| P2 (3-5 days) | GStreamer pipeline | 3 days | Medium | 39 DLL dependencies |
| P2 (3-5 days) | Themed accessibility | 1 day | High | CSS/HTML changes |
| P3 (5+ days) | Docker deployment | 5+ days | Medium | CI/CD setup |
| P3 (5+ days) | Full audit logging | 3-5 days | Medium | Database/storage |

---

## Key Stability Guarantees from process-killer-rust

The process-killer-rust repository documents these critical stability principles that should guide EduCode Browser changes:

1. **"1000% BSOD Immunity"**: The watchdog never terminates critical OS processes (csrss.exe, smss.exe, etc.)
2. **Empty DACL Tradeoff**: Blocks Task Manager but prevents legitimate debuggers - document this clearly
3. **ACG/CIG Tradeoff**: Blocks injection but may break JIT compilers - feature toggle recommended
4. **Hash Gate Dual-Gate**: Parent PID + SHA-256 hash authorization for any child processes
5. **Phased Enforcement**: Stage 1=warnings only, Stage 2=monitor, Stage 3=enforce - implement graduated response

These principles should underpin all stability changes to the EduCode Browser.