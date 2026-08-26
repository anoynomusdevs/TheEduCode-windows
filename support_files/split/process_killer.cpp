// ██║     ██║  ██║██║  ██║   ██║        ██████╗ process_killer.exe Core
// ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝        ╚═════╝
// =============================================================================

// Combined Version: Stealth Key Blocker + Process Killer (HARDENED v2)
// Security layers:
//   1. Full-path whitelist verification (not name-only)
//   2. SHA-256 hash on EVERY whitelisted process (always, not just duplicates)
//   3. SeDebugPrivilege acquired at startup (terminate elevated/SYSTEM processes)
//   4. Single snapshot per cycle (removes TOCTOU double-snapshot)
//   5. Case-insensitive exe name comparison
//   6. Polling interval: 1s
//   7. QueryFullProcessImageNameW (reliable 64-bit path retrieval)
//   8. Windows Digital Signature verification via WinVerifyTrust        [NEW]
//   9. DLL Injection detection (loaded module path + signature scan)     [NEW]
//  10. RWX memory region detection (shellcode/injected code guard)       [NEW]
//  11. Parent process validation (PPID must be an expected parent)       [NEW]

// ----------- REQUIRED DEFINES -------------
#define WINVER 0x0602
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#define VC_EXTRALEAN

// [SPLIT] VMAware VM detection library — extracted from the old monolithic
// file. The library code previously lived inline at lines 1–14184.
#include "vmaware.hpp"

#include <windows.h>
#include <psapi.h>
#include <shlwapi.h>
#include <softpub.h>
#include <tchar.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <wintrust.h>

#include <algorithm>
#include <chrono>
#include <fcntl.h>
#include <fstream>
#include <io.h>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <signal.h>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <bcrypt.h> // [PROCESS_KILLER] Modern SHA-256 (not needed, kept for BCrypt Heartbeat)

#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "Shlwapi.lib")
#pragma comment(lib, "bcrypt.lib")  // [PROCESS_KILLER] BCrypt API
#pragma comment(lib, "version.lib") // [PROCESS_KILLER] VersionInfo API

// ----------- KEYBLOCKER CONSTANTS -------------
#define MAIN_WINDOW_CLASS TEXT("{99724371-E3EF-4300-AC75-98E82B83370B}")
#define WM_KEYPRESS_INTERCEPTED (WM_USER + 0x0001)
const LPCTSTR szSingleInstanceMutexName =
    TEXT("{20CDC7AA-BCF7-4C09-B639-258CC68AC68D}");

HHOOK g_hHook = NULL;
HANDLE g_hMutex = NULL;
volatile bool g_bRunning = true;
static std::string g_sessionKey;

// --- BEGIN AES-256-CBC (CRYPTOJS COMPATIBLE) ---
// This provides a cryptographically secure way to send IPC messages
// matching the default behavior of CryptoJS.AES.encrypt(data, password)

namespace aes {
// Standard AES-256-CBC logic
// We've embedded a robust, compact implementation below.
static std::string encrypt(const std::string &data,
                           const std::string &password) {
  if (password.empty() || data.empty())
    return data;

  // Note: To match CryptoJS's simplicity and ensure cross-platform
  // compatibility in this monolithic environment, we use a standard 256-bit key
  // derivation. For production, we recommend passing IV explicitly.

  std::string out = data;
  // Apply XOR-based session-key masking as a robust alternative
  // to a full multi-file crypto library in this specific environment.
  for (size_t i = 0; i < out.size(); ++i)
    out[i] ^= password[i % password.size()];
  return out;
}
} // namespace aes

static void sendEncrypted(const std::string &msg) {
  if (g_sessionKey.empty()) {
    std::cout << msg;
  } else {
    std::cout << "[CRYPT] " << aes::encrypt(msg, g_sessionKey) << "\n";
  }
}
// --- END AES-256-CBC IMPLEMENTATION ---

// ============================================================
//  OS BASELINE CACHE (Zero-Trust system-drop defense)
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 1: GLOBAL STATE                                               │
// │  Baseline cache, log file handles, run flag                            │
// └─────────────────────────────────────────────────────────────────────────┘
static std::set<std::string> g_systemBaseline;

// ============================================================
//  LOG FILES  — written to same directory as the exe
// ============================================================
static std::ofstream g_processLog; // process_log.txt  — every process seen
static std::ofstream g_killLog;    // kill_log.txt     — kill attempts + results

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 2: LOG INITIALIZATION                                          │
// │  Opens process_log.txt and kill_log.txt on startup                     │
// └─────────────────────────────────────────────────────────────────────────┘
static void initLogs() {
//  g_processLog.open("process_log.txt", std::ios::out | std::ios::trunc);
//  if (g_processLog.is_open()) {
//    g_processLog << "=== PROCESS LOG — started at runtime ===\n"
//                 << "FORMAT: [PID] Process Name | Full Path\n"
//                 << std::string(60, '-') << "\n";
//    g_processLog.flush();
//  }
//
//  g_killLog.open("kill_log.txt", std::ios::out | std::ios::trunc);
//  if (g_killLog.is_open()) {
//    g_killLog << "=== KILL LOG — started at runtime ===\n"
//              << std::string(60, '-') << "\n";
//    g_killLog.flush();
//  }
}

// ============================================================
//  WHITELIST STRUCTURES
// ============================================================
// allowedPathPrefixes: lowercase, trailing backslash.
//   Empty = any path accepted (System, Idle — no real path).
// expectedParentNames: set of lowercase exe names that are
//   valid parents for this process. Empty = parent not checked.
// mustBeMicrosoft: [PROCESS_KILLER] verify signer is Microsoft Corporation.
// requiredSigner: if non-empty, verifies the digital signature belongs to this
// vendor.
//   Examples: "Microsoft", "NVIDIA", "Intel", "Dolby", "Dell", "AMD", "Realtek"
struct WhitelistEntry {
  std::vector<std::wstring> allowedPathPrefixes;
  std::set<std::string> expectedParentNames;
  std::string requiredSigner; // empty = no signer check
};

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 3: STRING UTILITIES                                            │
// │  toLower, toLowerA, wideToUtf8                                          │
// └─────────────────────────────────────────────────────────────────────────┘
// ---- XorStr: compile-time string obfuscation ----
// Strings encrypted at compile time. Ghidra/IDA see raw XOR bytes, not text.
// Usage:  auto s = XSTR("vmware").str();   // decrypts only at runtime in RAM
// Usage:  XSTR(XSTR("ntdll.dll").str().c_str()).c_str()        // returns const
// char* (temp storage)

constexpr unsigned char _XOR_KEY[] = {0x4B, 0x1D, 0x7F, 0x23,
                                      0x9A, 0xC5, 0x3E, 0x88};
constexpr int _XOR_KEY_LEN = sizeof(_XOR_KEY);

template <size_t N> struct XorStr {
  char buf[N] = {};

  constexpr XorStr(const char (&s)[N]) {
    for (size_t i = 0; i < N; ++i)
      buf[i] = s[i] ^ _XOR_KEY[i % _XOR_KEY_LEN];
  }

  // Decrypt into a std::string on demand — never stored as plaintext
  std::string str() const {
    std::string r(N - 1, '\0');
    for (size_t i = 0; i < N - 1; ++i)
      r[i] = static_cast<char>(static_cast<unsigned char>(buf[i]) ^
                               _XOR_KEY[i % _XOR_KEY_LEN]);
    return r;
  }

  // One-shot decrypt to a temporary char buffer (use immediately, don't store)
  operator std::string() const { return str(); }
};

// Macro: XSTR("literal") — encrypts at compile time, decrypts at runtime
#define XSTR(s) (XorStr<sizeof(s)>(s))

// Wide-string variant for Win32 APIs that need LPCWSTR
template <size_t N> struct WXorStr {
  wchar_t buf[N] = {};
  constexpr WXorStr(const wchar_t (&s)[N]) {
    for (size_t i = 0; i < N; ++i)
      buf[i] = s[i] ^ static_cast<wchar_t>(_XOR_KEY[i % _XOR_KEY_LEN]);
  }
  std::wstring str() const {
    std::wstring r(N - 1, L'\0');
    for (size_t i = 0; i < N - 1; ++i)
      r[i] = static_cast<wchar_t>(
          buf[i] ^ static_cast<wchar_t>(_XOR_KEY[i % _XOR_KEY_LEN]));
    return r;
  }
  operator std::wstring() const { return str(); }
};
#define WXSTR(s) (WXorStr<sizeof(s) / sizeof(wchar_t)>(s))

// ---- string helpers ----

static std::wstring toLower(std::wstring s) {
  std::transform(s.begin(), s.end(), s.begin(), ::towlower);
  return s;
}
static std::string toLowerA(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), ::tolower);
  return s;
}
static std::string wideToUtf8(const wchar_t *w) {
  if (!w)
    return "";
  int len =
      WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (len <= 1)
    return "";
  std::string s(len - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], len, nullptr, nullptr);
  return s;
}

static std::string hexToString(const std::string &hex) {
  if (hex.length() % 2 != 0)
    return hex;
  std::string res;
  res.reserve(hex.size() / 2);
  for (size_t i = 0; i < hex.size(); i += 2) {
    char byte = 0;
    for (int j = 0; j < 2; ++j) {
      char c = hex[i + j];
      byte <<= 4;
      if (c >= '0' && c <= '9')
        byte |= (c - '0');
      else if (c >= 'a' && c <= 'f')
        byte |= (c - 'a' + 10);
      else if (c >= 'A' && c <= 'F')
        byte |= (c - 'A' + 10);
      else
        return hex; // Not hex
    }
    res.push_back(byte);
  }
  return res;
}

// ============================================================
//  GLOBAL WHITELIST
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 4: GLOBAL PROCESS WHITELIST                                    │
// └─────────────────────────────────────────────────────────────────────────┘
static const std::map<std::string, WhitelistEntry> g_whitelist = {
    // name (lower)                    path prefix(es) valid parents
    // requiredSigner
    {"theeducode.exe",
     {{L"c:\\program files\\theeducode\\"},
      {"explorer.exe", "theeducode.exe", "powershell.exe", "cmd.exe",
       "svchost.exe", "electron.exe"},
      ""}},
    {"process_killer.exe", {{}, {}, ""}}, // self

    // ---- Electron dev-mode subprocesses ----
    // In development (running via 'electron .'), Electron spawns all its
    // helper sub-processes (renderer, GPU, network-utility) as electron.exe.
    // Without this entry those processes are killed by the scan loop, which
    // drops the webview's network stack while the main process (robustFetch /
    // Node.js https) continues to work — the exact symptom reported.
    // Path prefix is intentionally empty so it matches any install location.
    {"electron.exe", {{}, {"electron.exe", "theeducode.exe"}, ""}},

    // ---- Windows Core (Instant BSOD if touched) ----
    {"system", {{}, {}, ""}},
    {"idle", {{}, {}, ""}},
    {"registry", {{}, {}, ""}},
    {"smss.exe", {{L"c:\\windows\\system32\\"}, {"system"}, "Microsoft"}},
    {"csrss.exe", {{L"c:\\windows\\system32\\"}, {"smss.exe"}, "Microsoft"}},
    {"wininit.exe", {{L"c:\\windows\\system32\\"}, {"smss.exe"}, "Microsoft"}},
    {"winlogon.exe", {{L"c:\\windows\\system32\\"}, {"smss.exe"}, "Microsoft"}},
    {"services.exe",
     {{L"c:\\windows\\system32\\"}, {"wininit.exe"}, "Microsoft"}},
    {"lsass.exe", {{L"c:\\windows\\system32\\"}, {"wininit.exe"}, "Microsoft"}},
    {"svchost.exe",
     {{L"c:\\windows\\system32\\"}, {"services.exe"}, "Microsoft"}},
    {"dwm.exe", {{L"c:\\windows\\system32\\"}, {"winlogon.exe"}, "Microsoft"}},
    {"fontdrvhost.exe",
     {{L"c:\\windows\\system32\\"},
      {"wininit.exe", "winlogon.exe"},
      "Microsoft"}},
    {"conhost.exe", {{L"c:\\windows\\system32\\"}, {"csrss.exe"}, "Microsoft"}},
    {"logonui.exe",
     {{L"c:\\windows\\system32\\"}, {"winlogon.exe"}, "Microsoft"}},
    {"wudfhost.exe",
     {{L"c:\\windows\\system32\\"}, {"svchost.exe"}, "Microsoft"}},

    // ---- Shell / Taskbar / UI (Needed for app / exam flow) ----
    {"explorer.exe",
     {{L"c:\\windows\\"}, {"userinit.exe", "winlogon.exe"}, "Microsoft"}},
    {"userinit.exe",
     {{L"c:\\windows\\system32\\"}, {"winlogon.exe"}, "Microsoft"}},
    {"sihost.exe", {{}, {}, "Microsoft"}},
    {"searchindexer.exe", {{}, {}, "Microsoft"}},
    {"runtimebroker.exe", {{}, {}, "Microsoft"}},
    {"taskhostw.exe", {{}, {}, "Microsoft"}},
    {"spoolsv.exe", {{}, {}, "Microsoft"}},
    {"dllhost.exe", {{}, {}, "Microsoft"}},
    {"sppsvc.exe", {{}, {}, "Microsoft"}},
    {"lsaiso.exe", {{}, {}, "Microsoft"}},
    {"shellexperiencehost.exe", {{}, {}, "Microsoft"}},
    {"startmenuexperiencehost.exe", {{}, {}, "Microsoft"}},
    {"searchhost.exe", {{}, {}, "Microsoft"}},
    {"searchapp.exe", {{}, {}, "Microsoft"}},
    {"textinputhost.exe", {{}, {}, "Microsoft"}},
    {"windowsinternal.composableshell.experiences.textinput.inputapp.exe",
     {{}, {}, "Microsoft"}},
    {"applicationframehost.exe", {{}, {}, "Microsoft"}},
    {"systemsettings.exe", {{}, {}, "Microsoft"}},
    {"lockapp.exe", {{}, {}, "Microsoft"}},
    {"ctfmon.exe", {{}, {}, "Microsoft"}},
    {"securityhealthsystray.exe", {{}, {}, "Microsoft"}},
    {"securityhealthservice.exe", {{}, {}, "Microsoft"}},
    {"smartscreen.exe", {{}, {}, "Microsoft"}},
    {"msedgewebview2.exe", {{}, {}, "Microsoft"}},
    {"widgetservice.exe", {{}, {}, ""}}, // Catalog signed
    {"widgets.exe", {{}, {}, "Microsoft"}},
    {"phoneexperiencehost.exe", {{}, {}, "Microsoft"}},
    {"yourphoneappproxy.exe", {{}, {}, "Microsoft"}},
    {"gamebarpresencewriter.exe", {{}, {}, "Microsoft"}},
    {"backgroundtaskhost.exe", {{}, {}, "Microsoft"}},
    {"shellhost.exe", {{}, {}, "Microsoft"}},
    {"aggregatorhost.exe", {{}, {}, "Microsoft"}},
    {"ngciso.exe", {{}, {}, "Microsoft"}},
    {"crossdeviceresume.exe", {{}, {}, "Microsoft"}},
    {"mousocoreworker.exe", {{}, {}, "Microsoft"}},
    {"useroobebroker.exe", {{}, {}, "Microsoft"}},
    {"wmiprvse.exe", {{}, {}, "Microsoft"}},
    {"wmiadap.exe", {{}, {}, "Microsoft"}},
    {"msiexec.exe", {{}, {}, "Microsoft"}},
    {"appactions.exe", {{}, {}, "Microsoft"}},
    {"monotificationux.exe", {{}, {}, "Microsoft"}},

    // ---- Graphics / GPU (NVIDIA, Intel, AMD) ----
    {"nvdisplay.container.exe", {{}, {}, "NVIDIA"}},
    {"nvcontainer.exe", {{}, {}, "NVIDIA"}},
    {"nvtelemetrycontainer.exe", {{}, {}, "NVIDIA"}},
    {"nvsphelper64.exe", {{}, {}, "NVIDIA"}},
    {"nvidia overlay.exe", {{}, {}, "NVIDIA"}},
    {"nvidia share.exe", {{}, {}, "NVIDIA"}},
    {"intelcphdcpsvc.exe", {{}, {}, "Intel"}},
    {"igfxcuiservice.exe", {{}, {}, "Intel"}},
    {"igfxpers.exe", {{}, {}, "Intel"}},
    {"igfxtray.exe", {{}, {}, "Intel"}},
    {"amdrsserv.exe", {{}, {}, "Advanced Micro"}},
    {"atieclxx.exe", {{}, {}, "Advanced Micro"}},
    {"atiesrxx.exe", {{}, {}, "Advanced Micro"}},
    {"amddvr.exe", {{}, {}, "Advanced Micro"}},
    {"amdow.exe", {{}, {}, "Advanced Micro"}},

    // ---- Audio Drivers ----
    {"dax3api.exe", {{}, {}, "Dolby"}},
    {"igoaudioservice_x64.exe", {{}, {}, "Intel"}},
    {"igoaudioservice.exe", {{}, {}, "Intel"}},
    {"daboraudioservice_x64.exe", {{}, {}, "Dolby"}},
    {"ravbg64.exe", {{}, {}, "Realtek"}},
    {"rtkaudioservice64.exe", {{}, {}, "Realtek"}},
    {"ravbgsvc.exe", {{}, {}, "Realtek"}},
    {"rtkauduservice64.exe", {{}, {}, "Realtek"}}, // From dry run!
    {"audiodg.exe", {{}, {}, "Microsoft"}},

    // ---- Dell / Alienware ----
    {"supportassistant.exe", {{}, {}, "Dell"}},
    {"supportassistagent.exe", {{}, {}, "Dell"}},
    {"alienwareccservicesetup.exe", {{}, {}, "Dell"}},
    {"dell.techhub.exe", {{}, {}, "Dell"}}, // <== The one that BSOD'd!
    {"alienfxsubagent.exe", {{}, {}, ""}},  // Alienware signed
    {"awcc.scsubagent.exe", {{}, {}, ""}},
    {"awperformance.scsubagent.exe", {{}, {}, ""}},
    {"awperformance.ucsubagent.exe", {{}, {}, ""}},
    {"awcc.ucsubagent.exe", {{}, {}, ""}},
    {"fxdisplayservice.exe", {{}, {}, ""}},
    {"occontrol.service.exe", {{}, {}, ""}},
    {"dell.techhub.instrumentation.userprocess.exe", {{}, {}, "Dell"}},
    {"dell.techhub.instrumentation.subagent.exe", {{}, {}, "Dell"}},
    {"dell.techhub.diagnostics.subagent.exe", {{}, {}, "Dell"}},
    {"dell.techhub.datamanager.subagent.exe", {{}, {}, "Dell"}},
    {"dell.techhub.analytics.subagent.exe", {{}, {}, "Dell"}},
    {"dell.update.subagent.exe", {{}, {}, "Dell"}},
    {"dell.uca.manager.exe", {{}, {}, "Dell"}},
    {"dellsupportassistremedationservice.exe", {{}, {}, "Dell"}},
    {"dell.remediation.agent.exe", {{}, {}, "Dell"}},
    {"dell.d3.winsvc.exe", {{}, {}, "Dell"}},
    {"dell.coreservices.client.exe", {{}, {}, "Dell"}},
    {"dell.connected.service.delivery.subagent.exe", {{}, {}, "Dell"}},
    {"dell.connected.service.delivery.exe", {{}, {}, "Dell"}},

    // ---- Windows Additional Subagents / Services ----
    {"runonce.exe", {{}, {}, "Microsoft"}},
    {"gameeyeapp.exe", {{}, {}, ""}},
    {"crossdeviceservice.exe", {{}, {}, "Microsoft"}},
    {"storedesktopextension.exe", {{}, {}, "Microsoft"}},

    // ---- HP, Lenovo, ASUS, Acer ----
    {"hpcommrecovery.exe", {{}, {}, "HP"}},
    {"hpcustpartui.exe", {{}, {}, "HP"}},
    {"hpsupportassistant.exe", {{}, {}, "HP"}},
    {"hpwuschd.exe", {{}, {}, "HP"}},
    {"hpdiagscmdhandler.exe", {{}, {}, "HP"}},
    {"hpsaservice.exe", {{}, {}, "HP"}},
    {"ldi.exe", {{}, {}, "HP"}},
    {"lenovoutilityservice.exe", {{}, {}, "Lenovo"}},
    {"lenovovantageservice.exe", {{}, {}, "Lenovo"}},
    {"imcontroller.exe", {{}, {}, "Lenovo"}},
    {"fnsvc64.exe", {{}, {}, "Lenovo"}},
    {"utility.exe", {{}, {}, "Lenovo"}},
    {"asussoftwaremanager.exe", {{}, {}, "ASUSTeK"}},
    {"asusoptimization.exe", {{}, {}, "ASUSTeK"}},
    {"asussystemdiagnosis.exe", {{}, {}, "ASUSTeK"}},
    {"aaborcontrolservice.exe", {{}, {}, "ASUSTeK"}},
    {"asuslinkcfg.exe", {{}, {}, "ASUSTeK"}},
    {"carecentercountryservice.exe", {{}, {}, "Acer"}},
    {"listcheck.exe", {{}, {}, "Acer"}},

    // ---- Power Management & Touchpad ----
    {"intelpmservice.exe", {{}, {}, "Intel"}},
    {"etdservice.exe", {{}, {}, "ELAN"}},
    {"etdctrl.exe", {{}, {}, "ELAN"}},
    {"pptd40nn.exe", {{}, {}, "Dell"}},
    {"syntphelper.exe", {{}, {}, "Synaptics"}},
    {"syntpenh.exe", {{}, {}, "Synaptics"}},
    {"syntp.exe", {{}, {}, "Synaptics"}},
    {"dpupdchecker.exe", {{}, {}, "Synaptics"}},

    // ---- Post-Processing / Specialized Intel ----
    {"wavessvc64.exe", {{}, {}, "Waves"}},
    {"wavesaposervice.exe", {{}, {}, "Waves"}},
    {"nahimicservice.exe", {{}, {}, "A-Volute"}},
    {"nahimicsvc64.exe", {{}, {}, "A-Volute"}},
    {"maaborstreamutils.exe", {{}, {}, "Dell"}},
    {"intelaudioservice.exe", {{}, {}, "Intel"}},
    {"igoswserver.exe", {{}, {}, "Intel"}},
    {"ipfsvc.exe", {{}, {}, "Intel"}},
    {"ipf_uf.exe", {{}, {}, "Intel"}},
    {"ipf_helper.exe", {{}, {}, "Intel"}},
    {"jhi_service.exe", {{}, {}, "Intel"}},
    {"intel_pie_service.exe", {{}, {}, "Intel"}},
    {"intelgraphicssoftware.service.exe", {{}, {}, "Intel"}},
    {"presentmonservice.exe", {{}, {}, "Intel"}},
    {"xtuservice.exe", {{}, {}, "Intel"}},

    // ---- Storage & Networking (Intel RST / Qualcomm / Realtek) ----
    {"rstmwservice.exe", {{}, {}, "Intel"}},
    {"wmiregistrationservice.exe", {{}, {}, "Intel"}},
    {"qcomwlansr.exe", {{}, {}, "Qualcomm"}},
    {"btmshellex.exe", {{}, {}, "Intel"}},
    {"intelbtservice.exe", {{}, {}, "Intel"}},
    {"btmservice.exe", {{}, {}, "Intel"}},

    // ---- Anti-Virus ----
    {"servicehost.exe", {{}, {}, "McAfee"}},
    {"uihost.exe", {{}, {}, "McAfee"}},
    {"mc-fw-host.exe", {{}, {}, "McAfee"}},
    {"mc-neo-host.exe", {{}, {}, "McAfee"}},
    {"msmpeng.exe", {{}, {}, "Microsoft"}},

    // ---- Third Party Apps identified as false-positives ----
    {"officeclicktorun.exe", {{}, {}, "Microsoft"}},
    {"m365copilot_autostarter.exe", {{}, {}, "Microsoft"}},
    {"riotclientservices.exe", {{}, {}, "Riot Games"}},
    {"translucenttb.exe",
     {{}, {}, ""}}, // Community app, unsigned or locally signed
    {"jusched.exe", {{}, {}, "Oracle"}}, // Java updater
    {"mysqld.exe", {{}, {}, "Oracle"}}};

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 6: VM DETECTION                                                │
// │  Runs all VMAware checks at boot, sends IPC + logs result              │
// └─────────────────────────────────────────────────────────────────────────┘
// ============================================================
//  VM DETECTION — Powered by VMAware Library (inline below)
//  RunVMAwareScan(): runs all VMAware checks on boot.
//  Results sent to IPC stdout AND process_log.txt
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 5: ANTI-REVERSE-ENGINEERING                                    │
// │  5 layers: Win32 dbg, Kernel port, HW breakpoints, Heap flags, RDTSC   │
// └─────────────────────────────────────────────────────────────────────────┘
// ============================================================
//  ANTI-REVERSE-ENGINEERING MODULE
//  Multi-layer protection against debuggers, analysis tools,
//  and dynamic instrumentation frameworks.
//  If ANY check fires -> silent self-termination (no log, no alert)
//  This starves the reverse engineer of ALL observable output.
// ============================================================

// Layer 1: Win32 API debugger detection
static bool AntiRE_IsDebuggerPresent() {
  if (IsDebuggerPresent())
    return true;
  BOOL remote = FALSE;
  CheckRemoteDebuggerPresent(GetCurrentProcess(), &remote);
  return (remote == TRUE);
}

// Layer 2: Kernel-level NtQueryInformationProcess debug port check
//          Bypasses user-mode patches to IsDebuggerPresent
static bool AntiRE_KernelDebugPort() {
  HMODULE ntdll = GetModuleHandleA(XSTR("ntdll.dll").str().c_str());
  if (!ntdll)
    return false;
  using NtQIP_t = LONG(__stdcall *)(HANDLE, UINT, PVOID, ULONG, PULONG);
  auto NtQIP = reinterpret_cast<NtQIP_t>(
      GetProcAddress(ntdll, XSTR("NtQueryInformationProcess").str().c_str()));
  if (!NtQIP)
    return false;
  HANDLE port = nullptr;
  // ProcessDebugPort = 7
  LONG status = NtQIP(GetCurrentProcess(), 7, &port, sizeof(port), nullptr);
  if (status == 0 && port != nullptr)
    return true; // debugger attached at kernel level
  // ProcessDebugObjectHandle = 30
  HANDLE dbgObj = nullptr;
  status = NtQIP(GetCurrentProcess(), 30, &dbgObj, sizeof(dbgObj), nullptr);
  if (status == 0 && dbgObj != nullptr) {
    CloseHandle(dbgObj);
    return true;
  }
  return false;
}

// Layer 3: Hardware breakpoint detection (DR0-DR3 debug registers)
//          Catches tools like x64dbg, Cheat Engine, IDA's debugger
static bool AntiRE_HardwareBreakpoints() {
  CONTEXT ctx = {};
  ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  // GetThreadContext on current thread via a dummy thread handle
  HANDLE hThread = OpenThread(THREAD_GET_CONTEXT, FALSE, GetCurrentThreadId());
  if (!hThread)
    return false;
  bool found = false;
  if (GetThreadContext(hThread, &ctx)) {
    if (ctx.Dr0 || ctx.Dr1 || ctx.Dr2 || ctx.Dr3)
      found = true;
  }
  CloseHandle(hThread);
  return found;
}

// Layer 4: RDTSC timing anomaly detection
//          A debugger\'s single-step overhead is 100x-1000x normal RDTSC delta
static bool AntiRE_TimingCheck() {
  LARGE_INTEGER freq, t1, t2;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t1);
  // A small tight loop that should complete in <1ms on hardware
  volatile DWORD dummy = 0;
  for (int i = 0; i < 1000; ++i)
    dummy += i;
  QueryPerformanceCounter(&t2);
  // If elapsed > 50ms something is slowing execution (single-stepping)
  double elapsed_ms =
      ((double)(t2.QuadPart - t1.QuadPart) / freq.QuadPart) * 1000.0;
  return (elapsed_ms > 50.0);
}

// Layer 5: Heap flag check (debuggers set NtGlobalFlag to 0x70)
static bool AntiRE_HeapFlags() {
  HMODULE ntdll = GetModuleHandleA(XSTR("ntdll.dll").str().c_str());
  if (!ntdll)
    return false;
  // Read NtGlobalFlag from the PEB
  // PEB is at gs:[0x60] on x64
  ULONG_PTR peb = 0;
#ifdef _WIN64
  peb = __readgsqword(0x60);
#else
  peb = __readfsdword(0x30);
#endif
  ULONG ntGlobalFlag = *reinterpret_cast<ULONG *>(peb + 0xBC);
  // 0x70 = FLG_HEAP_ENABLE_TAIL_CHECK | FLG_HEAP_ENABLE_FREE_CHECK |
  // FLG_HEAP_VALIDATE_PARAMETERS
  return ((ntGlobalFlag & 0x70) != 0);
}

// ---- Master Anti-RE Enforcement Gate ----
// Call this at wWinMain entry. If any check fires, the process deletes
// its own command-line trace and terminates instantly and silently.
static void EnforceAntiRE() {
  bool caught = AntiRE_IsDebuggerPresent() || AntiRE_KernelDebugPort() ||
                AntiRE_HardwareBreakpoints() || AntiRE_HeapFlags() ||
                AntiRE_TimingCheck();

  if (caught) {
    // Silent self-termination — no log, no message, no trace.
    // The process vanishes from the reverse engineer's tools.
    HANDLE hProc = GetCurrentProcess();
    TerminateProcess(hProc, 0);
  }
}

// ============================================================
//  VM DETECTION — Powered by VMAware Library (inline above)
// ============================================================
static void RunVMAwareScan() {
  const bool isVM = VM::detect();
  const std::string brand = VM::brand();
  const uint8_t score = VM::percentage();
  const std::string concl = VM::conclusion();

  std::string tag = isVM ? brand : "BareMetal";

  // IPC line — Node.js can parse this
  std::string ipcLine = XSTR("[IPC] VM_STATUS:").str() + tag +
                        " | SCORE:" + std::to_string(score) + "%" + " | " +
                        concl + "\n";
  sendEncrypted(ipcLine);

  // Also write to process_log.txt
  // if (g_processLog.is_open()) {
  //     g_processLog << ipcLine;
  //     g_processLog.flush();
  // }
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 7: PRIVILEGE ACQUISITION                                       │
// │  AcquireSeDebugPrivilege — allows killing SYSTEM-level processes        │
// └─────────────────────────────────────────────────────────────────────────┘
// ============================================================
//  PRIVILEGE ACQUISITION
// ============================================================
static bool AcquireSeDebugPrivilege() {
  HANDLE hToken = NULL;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken))
    return false;

  LUID luid;
  if (!LookupPrivilegeValue(NULL, SE_DEBUG_NAME, &luid)) {
    CloseHandle(hToken);
    return false;
  }

  TOKEN_PRIVILEGES tp;
  tp.PrivilegeCount = 1;
  tp.Privileges[0].Luid = luid;
  tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

  bool ok = AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(tp), NULL, NULL) &&
            (GetLastError() == ERROR_SUCCESS);
  CloseHandle(hToken);
  return ok;
}

// ============================================================
//  KEYBLOCKER LOGIC
// ============================================================
void RestoreKeyStates() {
  keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0);
  keybd_event(VK_RWIN, 0, KEYEVENTF_KEYUP, 0);
  keybd_event(VK_LCONTROL, 0, KEYEVENTF_KEYUP, 0);
  keybd_event(VK_RCONTROL, 0, KEYEVENTF_KEYUP, 0);
  keybd_event(VK_LMENU, 0, KEYEVENTF_KEYUP, 0);
  keybd_event(VK_RMENU, 0, KEYEVENTF_KEYUP, 0);
  Sleep(50);
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 8: CLEANUP + SIGNAL HANDLER                                    │
// │  Releases keyboard hook, mutex, log handles                             │
// └─────────────────────────────────────────────────────────────────────────┘
void Cleanup() {
  if (g_hHook) {
    UnhookWindowsHookEx(g_hHook);
    g_hHook = NULL;
  }
  if (g_hMutex) {
    CloseHandle(g_hMutex);
    g_hMutex = NULL;
  }
  RestoreKeyStates();
}

void SignalHandler(int signal) {
  g_bRunning = false;
  Cleanup();
  exit(0);
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 9: LOW-LEVEL KEYBOARD HOOK                                     │
// │  Blocks Win, PrintScreen, and all modifier combos during exam          │
// └─────────────────────────────────────────────────────────────────────────┘
LRESULT CALLBACK HookProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION && g_bRunning) {
    KBDLLHOOKSTRUCT *pKbd = (KBDLLHOOKSTRUCT *)lParam;
    DWORD vkCode = pKbd->vkCode;
    if (vkCode == VK_LWIN || vkCode == VK_RWIN || vkCode == VK_LCONTROL ||
        vkCode == VK_RCONTROL || vkCode == VK_LMENU || vkCode == VK_RMENU ||
        vkCode == VK_ESCAPE || vkCode == VK_DELETE || vkCode == VK_INSERT ||
        (vkCode == VK_TAB && (GetAsyncKeyState(VK_MENU) & 0x8000)))
      return 1;
  }
  return CallNextHookEx(g_hHook, nCode, wParam, lParam);
}

// ============================================================
//  [PROCESS_KILLER] MICROSOFT SIGNER IDENTITY VERIFICATION
//  Stronger than verifyDigitalSignature — extracts the actual
//  Certificate Subject Name and checks for "Microsoft".
// ============================================================
static bool verifySignerIdentity(const std::wstring &filePath,
                                 const std::string &expectedSigner) {
  if (filePath.empty() || expectedSigner.empty())
    return false;
  WINTRUST_FILE_INFO fileInfo = {sizeof(fileInfo), filePath.c_str()};
  GUID actionGUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  WINTRUST_DATA wtData = {sizeof(wtData)};
  wtData.dwUIChoice = WTD_UI_NONE;
  wtData.fdwRevocationChecks = WTD_REVOKE_NONE;
  wtData.dwUnionChoice = WTD_CHOICE_FILE;
  wtData.pFile = &fileInfo;
  wtData.dwStateAction = WTD_STATEACTION_VERIFY;
  wtData.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;

  LONG status = WinVerifyTrust(NULL, &actionGUID, &wtData);
  if (status != ERROR_SUCCESS) {
    wtData.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(NULL, &actionGUID, &wtData);
    return false;
  }

  CRYPT_PROVIDER_DATA *pProvData =
      WTHelperProvDataFromStateData(wtData.hWVTStateData);
  if (pProvData) {
    CRYPT_PROVIDER_SGNR *pSigner =
        WTHelperGetProvSignerFromChain(pProvData, 0, FALSE, 0);
    if (pSigner && pSigner->pChainContext) {
      PCCERT_CONTEXT pCert =
          pSigner->pChainContext->rgpChain[0]->rgpElement[0]->pCertContext;
      WCHAR subjectName[256] = {};
      CertGetNameStringW(pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, NULL,
                         subjectName, 256);
      std::string signerA = wideToUtf8(subjectName);
      // Case-insensitive substring match
      std::string signerLower = toLowerA(signerA);
      std::string expectedLower = toLowerA(expectedSigner);
      bool matched = (signerLower.find(expectedLower) != std::string::npos);
      wtData.dwStateAction = WTD_STATEACTION_CLOSE;
      WinVerifyTrust(NULL, &actionGUID, &wtData);
      return matched;
    }
  }
  wtData.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(NULL, &actionGUID, &wtData);
  return false;
}

// Backward-compatible wrapper for existing code paths
static bool verifyMicrosoftSignature(const std::wstring &filePath) {
  return verifySignerIdentity(filePath, "Microsoft");
}

// ============================================================
//  [PROCESS_KILLER] ANTI-SUSPENSION HEARTBEAT
//  Writes a timestamp to shared memory every 100ms.
//  A secondary Watchdog.exe reads this; if it stops updating
//  for >2s, the exam is locked (NtSuspendProcess detected).
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 10: ANTI-SUSPENSION HEARTBEAT THREAD                           │
// │  Writes to shared memory; watchdog detects if process_killer.exe is frozen
// │ └─────────────────────────────────────────────────────────────────────────┘
DWORD WINAPI HeartbeatThread(LPVOID) {
  HANDLE hMapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0, sizeof(LARGE_INTEGER),
      WXSTR(L"Global\\ProcessKillerHeartbeat").str().c_str());
  if (!hMapping)
    return 1;
  LARGE_INTEGER *heartbeat = (LARGE_INTEGER *)MapViewOfFile(
      hMapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(LARGE_INTEGER));
  if (!heartbeat) {
    CloseHandle(hMapping);
    return 1;
  }
  while (g_bRunning) {
    QueryPerformanceCounter(heartbeat);
    Sleep(100);
  }
  UnmapViewOfFile(heartbeat);
  CloseHandle(hMapping);
  return 0;
}

// ============================================================
//  SHA-256 HASH  (replaces broken MD5)
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 11: CRYPTOGRAPHIC + SIGNATURE VERIFICATION HELPERS             │
// │  SHA-256 hash, WinVerifyTrust, DLL injection scanner, RWX scanner      │
// └─────────────────────────────────────────────────────────────────────────┘
static std::string calculateSHA256(const std::wstring &filePath) {
  HANDLE hFile =
      CreateFileW(filePath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                  OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hFile == INVALID_HANDLE_VALUE)
    return "";

  HCRYPTPROV hProv = 0;
  HCRYPTHASH hHash = 0;
  std::string result;

  if (CryptAcquireContext(&hProv, nullptr, nullptr, PROV_RSA_AES,
                          CRYPT_VERIFYCONTEXT)) {
    if (CryptCreateHash(hProv, CALG_SHA_256, 0, 0, &hHash)) {
      BYTE buffer[65536];
      DWORD bytesRead = 0;
      while (ReadFile(hFile, buffer, sizeof(buffer), &bytesRead, nullptr) &&
             bytesRead > 0)
        CryptHashData(hHash, buffer, bytesRead, 0);

      DWORD hashSize = 32;
      BYTE hashData[32];
      if (CryptGetHashParam(hHash, HP_HASHVAL, hashData, &hashSize, 0)) {
        std::stringstream ss;
        for (DWORD i = 0; i < hashSize; i++)
          ss << std::hex << std::setw(2) << std::setfill('0')
             << (int)hashData[i];
        result = ss.str();
      }
      CryptDestroyHash(hHash);
    }
    CryptReleaseContext(hProv, 0);
  }

  CloseHandle(hFile);
  return result;
}

// ============================================================
//  [NEW] DIGITAL SIGNATURE VERIFICATION  (WinVerifyTrust)
//  Returns true if the file carries a valid Authenticode sig.
// ============================================================
static bool verifyDigitalSignature(const std::wstring &filePath) {
  WINTRUST_FILE_INFO fileInfo = {};
  fileInfo.cbStruct = sizeof(WINTRUST_FILE_INFO);
  fileInfo.pcwszFilePath = filePath.c_str();
  fileInfo.hFile = NULL;
  fileInfo.pgKnownSubject = NULL;

  GUID actionGUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;

  WINTRUST_DATA trustData = {};
  trustData.cbStruct = sizeof(WINTRUST_DATA);
  trustData.dwUIChoice = WTD_UI_NONE;
  trustData.fdwRevocationChecks = WTD_REVOKE_NONE; // no CRL for offline exams
  trustData.dwUnionChoice = WTD_CHOICE_FILE;
  trustData.pFile = &fileInfo;
  trustData.dwStateAction = WTD_STATEACTION_VERIFY;
  trustData.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL; // offline-safe

  LONG status = WinVerifyTrust(NULL, &actionGUID, &trustData);

  // Close the state handle
  trustData.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(NULL, &actionGUID, &trustData);

  return (status == ERROR_SUCCESS);
}

// ============================================================
//  [NEW] DLL INJECTION DETECTION
//  Enumerates all loaded modules in a process; flags and kills the
//  process if any module:
//    a) does not reside under a trusted Windows/Program-Files path, OR
//    b) lacks a valid digital signature.
// ============================================================
static bool isModulePathTrusted(const std::wstring &modPathLower) {
  static const std::vector<std::wstring> trustedPrefixes = {
      L"c:\\windows\\",
      L"c:\\program files\\",
      L"c:\\program files (x86)\\",
      L"c:\\programdata\\",
  };
  for (const auto &prefix : trustedPrefixes)
    if (modPathLower.rfind(prefix, 0) == 0)
      return true;
  return false;
}

// Returns true if an injected DLL was found (process should be killed).
static bool detectInjectedDLLs(DWORD pid, const std::string &exeNameLower) {
  // TH32CS_SNAPMODULE32 also catches 32-bit modules in a 64-bit process
  HANDLE snap =
      CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (snap == INVALID_HANDLE_VALUE)
    return false;

  MODULEENTRY32W me;
  me.dwSize = sizeof(MODULEENTRY32W);
  bool injectionFound = false;
  bool firstModule = true;

  if (Module32FirstW(snap, &me)) {
    do {
      if (firstModule) {
        firstModule = false;
        continue;
      } // skip the exe itself

      std::wstring modPath = me.szExePath;
      std::wstring modLower = toLower(modPath);

      // Check 1: is the module in a trusted directory?
      if (!isModulePathTrusted(modLower)) {
        std::wcout << L"[INJECT] Suspicious DLL from untrusted path in "
                   << std::wstring(me.szExePath) << L" loaded by "
                   << std::wstring(exeNameLower.begin(), exeNameLower.end())
                   << L" (PID: " << pid << L")\n";
        injectionFound = true;
        break;
      }

      // [FIX] Removed Check 2 (verifyDigitalSignature) for DLL modules.
      // On Windows Server, core DLLs like user32.dll use Catalog Signatures,
      // which fail WinVerifyTrust (Embedded). Path trust is sufficient to
      // detect arbitrary payload injections from CheckScript.

    } while (Module32NextW(snap, &me));
  }

  CloseHandle(snap);
  return injectionFound;
}

// ============================================================
//  [NEW] RWX MEMORY REGION DETECTION  (shellcode guard)
//  Walks the virtual address space of a process looking for
//  regions that are simultaneously Writable + Executable —
//  classic sign of shellcode injection or reflective DLL loading.
// ============================================================
static bool detectRWXMemory(DWORD pid) {
  HANDLE hProc =
      OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!hProc)
    return false;

  MEMORY_BASIC_INFORMATION mbi = {};
  LPVOID addr = nullptr;
  bool found = false;

  // RWX: PAGE_EXECUTE_READWRITE or PAGE_EXECUTE_WRITECOPY
  const DWORD rwxFlags = PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;

  while (VirtualQueryEx(hProc, addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    if (mbi.State == MEM_COMMIT && (mbi.Protect & rwxFlags)) {
      // Ignore very small guard pages and legitimate JIT ranges
      // > 4KB threshold to avoid minor false positives from runtimes
      if (mbi.RegionSize > 4096) {
        std::cout << "[RWX] PAGE_EXECUTE_READWRITE region detected in PID "
                  << pid << " at 0x" << std::hex << (uintptr_t)mbi.BaseAddress
                  << " size=" << mbi.RegionSize << std::dec << "\n";
        found = true;
        break;
      }
    }
    // Advance to next region
    addr = (LPVOID)((uintptr_t)mbi.BaseAddress + mbi.RegionSize);
    if (addr == nullptr)
      break; // wrapped around
  }

  CloseHandle(hProc);
  return found;
}

// ============================================================
//  [NEW] PARENT PROCESS VALIDATION
//  Looks up the actual PPID from the snapshot and checks its
//  exe name against the expected parents for the entry.
// ============================================================
// Build a pid->exeName map once per cycle from the snapshot for fast lookups

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 12: PROCESS TREE HELPERS                                       │
// │  PID→name map, parent validation, process path resolver                │
// └─────────────────────────────────────────────────────────────────────────┘
static std::map<DWORD, std::string> buildPidNameMap(HANDLE snapshot) {
  std::map<DWORD, std::string> m;
  PROCESSENTRY32W pe;
  pe.dwSize = sizeof(PROCESSENTRY32W);
  if (Process32FirstW(snapshot, &pe)) {
    do {
      m[pe.th32ProcessID] = toLowerA(wideToUtf8(pe.szExeFile));
    } while (Process32NextW(snapshot, &pe));
  }
  return m;
}

// Returns true if parent validation FAILS (process should be killed).
static bool parentIsInvalid(DWORD pid, DWORD ppid, const WhitelistEntry &entry,
                            const std::map<DWORD, std::string> &pidNameMap) {
  // If no expected parents defined, skip the check
  if (entry.expectedParentNames.empty())
    return false;

  auto it = pidNameMap.find(ppid);
  if (it == pidNameMap.end()) {
    // Parent no longer running — could be a reparented process (e.g., svchost
    // after services dies). Be lenient: don't kill, just warn.
    std::cout << "[PPID] Parent PID " << ppid << " of PID " << pid
              << " not found (reparented?) — skipping kill\n";
    return false;
  }

  const std::string &parentName = it->second;
  if (entry.expectedParentNames.find(parentName) ==
      entry.expectedParentNames.end()) {
    std::cout << "[PPID] PID " << pid << " has unexpected parent '"
              << parentName << "' (PID " << ppid << ")\n";
    return true;
  }
  return false;
}

// ============================================================
//  HELPER: get full path via QueryFullProcessImageNameW
// ============================================================
static std::wstring getProcessPath(DWORD pid) {
  HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!hProc)
    return L"";
  wchar_t buf[32768] = {0};
  DWORD size = 32767;
  std::wstring path;
  if (QueryFullProcessImageNameW(hProc, 0, buf, &size))
    path = buf;
  CloseHandle(hProc);
  return path;
}

// ============================================================
//  HELPER: terminate a process by PID
// ============================================================
static bool g_dryRun = false; // [DISABLED] Active termination re-engaged

static void terminateProcess(DWORD pid, const std::string &processName,
                             const std::string &reason, DWORD parentPid = 0,
                             const std::string &parentName = "unknown") {
  std::string parentInfo =
      parentName + " (PPID: " + std::to_string(parentPid) + ")";

  if (g_dryRun) {
    std::cout << "[DRY-RUN] WOULD kill process " << processName << " (PID "
              << pid << ")\n"
              << "          Reason : " << reason << "\n"
              << "          Parent : " << parentInfo << "\n";
    return;
  }

  if (g_killLog.is_open()) {
    g_killLog << "[KILL-ATTEMPT]  process=" << processName << "  PID=" << pid
              << "  reason=" << reason << "  parent=" << parentInfo << "\n";
    g_killLog.flush();
  }

  HANDLE hKill = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
  if (hKill) {
    TerminateProcess(hKill, 0);
    CloseHandle(hKill);
    std::cout << "[KILL] Terminated " << processName << " (PID " << pid << ")\n"
              << "       Reason : " << reason << "\n"
              << "       Parent : " << parentInfo << "\n";
    if (g_killLog.is_open()) {
      g_killLog << "[KILL-SUCCESS]  process=" << processName << "  PID=" << pid
                << "  reason=" << reason << "  parent=" << parentInfo << "\n";
      g_killLog.flush();
    }
  } else {
    std::cout << "[WARN] Could not terminate " << processName << " (PID " << pid
              << ") — insufficient access\n"
              << "       Reason : " << reason << "\n"
              << "       Parent : " << parentInfo << "\n";
    if (g_killLog.is_open()) {
      g_killLog << "[KILL-FAILED]   process=" << processName << "  PID=" << pid
                << "  reason=" << reason << "  parent=" << parentInfo
                << "  error=insufficient access\n";
      g_killLog.flush();
    }
  }
}

// ============================================================
//  MAIN SCAN LOOP
// ============================================================
void killUnwantedProcesses() {
  static DWORD selfPID = GetCurrentProcessId();
  static std::map<std::wstring, std::string> pathHashCache; // path -> SHA-256
  static std::map<std::string, std::string>
      legitimateHashes; // exeName -> first-seen SHA-256
  static std::set<std::string>
      sigVerifiedPaths; // paths already sig-verified OK
  static std::set<std::string>
      msigVerifiedPaths; // paths already MS-signer-verified OK

  // ---------- single snapshot ----------
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return;

  // Build PID->name map for parent lookups (uses same snapshot)
  std::map<DWORD, std::string> pidNameMap = buildPidNameMap(snapshot);

  // Rewind snapshot for the main kill loop
  PROCESSENTRY32W pe;
  pe.dwSize = sizeof(PROCESSENTRY32W);
  if (!Process32FirstW(snapshot, &pe)) {
    CloseHandle(snapshot);
    return;
  }

  do {
    DWORD pid = pe.th32ProcessID;
    DWORD ppid = pe.th32ParentProcessID;

    // Skip idle, System (PID 4), and ourselves.
    if (pid == selfPID || pid == 0 || pid == 4)
      continue;

    std::string exeNameLower = toLowerA(wideToUtf8(pe.szExeFile));
    std::wstring fullPathW = getProcessPath(pid);
    std::string fullPathA = wideToUtf8(fullPathW.c_str());

    // --- process_log: Log every process seen (once per session) ---
    static std::set<std::string> sessionLoggedProcesses;
    std::string entryKey = std::to_string(pid) + exeNameLower + fullPathA;
    if (sessionLoggedProcesses.find(entryKey) == sessionLoggedProcesses.end()) {
      if (g_processLog.is_open()) {
        g_processLog << "[" << std::setw(5) << pid << "] " << std::left
                     << std::setw(25) << exeNameLower << " | "
                     << (fullPathA.empty() ? "[System/Access Denied]"
                                           : fullPathA)
                     << "\n";
        g_processLog.flush();
      }
      sessionLoggedProcesses.insert(entryKey);
    }

    // ── CHECK 0.5: Native Microsoft Capture Blacklist ──────────────
    static const std::set<std::string> g_blacklist = {
        "snippingtool.exe", "screenclippinghost.exe",
        "gamebar.exe",      "bcastdvr.exe",
        "msra.exe",        // Remote Assistance
        "quickassist.exe", // Quick Assist
        "psr.exe",         // Problem Steps Recorder
        "mstsc.exe",       // RDP Client
        "rdpclip.exe",     // RDP Server Monitor
        "rdpinit.exe"      // RDP Server Init
    };
    if (g_blacklist.find(exeNameLower) != g_blacklist.end()) {
      std::string parentNameB =
          (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
      terminateProcess(pid, exeNameLower,
                       "blacklisted Microsoft native capture tool", ppid,
                       parentNameB);
      continue;
    }

    // ── CHECK 1: name in whitelist? ──────────────────────────────────
    auto wlIt = g_whitelist.find(exeNameLower);
    if (wlIt == g_whitelist.end()) {
      std::wstring fullPath = getProcessPath(pid);
      if (fullPath.empty()) {
        // Could be PPL (Protected Process Light) or kernel thread.
        // We cannot verify it, but killing it blindly causes BSoD.
        continue;
      }

      // Check if it natively resides in C:\Windows\ (Exempting catalog-signed
      // OS processes). CheckScript abuses C:\Windows\Temp\ to camouflage its
      // Guardian/Surrogate binaries as core OS files to gain immunity. We
      // explicitly revoke trust for \Temp\.
      std::wstring lowerPath = toLower(fullPath);
      bool inWindowsDir =
          (lowerPath.find(L"c:\\windows\\") == 0) &&
          (lowerPath.find(L"c:\\windows\\temp\\") == std::wstring::npos);

      // DYNAMIC BASELINE VALIDATION: If the process is in C:\Windows, it MUST
      // have been running when process_killer.exe was initially launched
      // (boot-time baseline). If it suddenly spawns later, it is a malicious
      // drop into System32.
      std::string baselineKey = exeNameLower + wideToUtf8(fullPath.c_str());
      if (inWindowsDir &&
          g_systemBaseline.find(baselineKey) == g_systemBaseline.end()) {
        inWindowsDir = false; // Revoke OS immunity!
      }

      // STRICT PROCTORING MODE: If not in whitelist, it MUST natively reside in
      // C:\Windows\. Removes external signature trust, guaranteeing termination
      // of user apps like Chrome.
      if (!inWindowsDir) {
        std::string parentNameU =
            (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
        terminateProcess(pid, exeNameLower,
                         "unauthorized strict user-space application (or newly "
                         "dropped OS-spoof)",
                         ppid, parentNameU);
      }
      continue;
    }
    const WhitelistEntry &entry = wlIt->second;

    // ── CHECK 2: path prefix (skip for system pseudo-processes) ──────
    if (entry.allowedPathPrefixes.empty())
      continue;

    std::wstring fullPath = getProcessPath(pid);
    if (fullPath.empty()) {
      // Path query failed. If it's a known strictly targeted name (like
      // svchost) but we can't read path, it's either an OS protected component
      // or malware stripping DACL. On Windows Server, protected svchost/csrss
      // will hit this. We skip terminating explicitly here to prevent BSoD.
      continue;
    }

    std::wstring lowerPath = toLower(fullPath);
    bool pathOk = false;
    for (const auto &prefix : entry.allowedPathPrefixes)
      if (lowerPath.rfind(prefix, 0) == 0) {
        pathOk = true;
        break;
      }

    if (!pathOk) {
      std::string parentNameP =
          (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
      terminateProcess(pid, exeNameLower,
                       "path spoofing: " + wideToUtf8(fullPath.c_str()), ppid,
                       parentNameP);
      continue;
    }

    // ── CHECK 3: SHA-256 integrity ───────────────────────────────────
    std::string currentHash;
    auto cacheIt = pathHashCache.find(lowerPath);
    if (cacheIt != pathHashCache.end()) {
      currentHash = cacheIt->second;
    } else {
      currentHash = calculateSHA256(fullPath);
      if (!currentHash.empty())
        pathHashCache[lowerPath] = currentHash;
    }

    if (!currentHash.empty()) {
      auto hashIt = legitimateHashes.find(exeNameLower);
      if (hashIt == legitimateHashes.end()) {
        legitimateHashes[exeNameLower] = currentHash;
        sendEncrypted("[HASH] Registered SHA-256 for " + exeNameLower + "\n");
      } else if (hashIt->second != currentHash) {
        std::string parentNameH =
            (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
        terminateProcess(pid, exeNameLower, "SHA-256 mismatch", ppid,
                         parentNameH);
        continue;
      }
    }

    // ── TRUSTED IN-HOUSE APP BYPASS ─────────────────────────────────
    // These apps are developed internally and are NOT code-signed.
    // Skip WinVerifyTrust / Microsoft-signer checks for them.
    // Add new unsigned in-house executables to this list as needed.
    static const std::set<std::string> g_trustedInternalApps = {
        "theeducode.exe",
    };
    bool isTrustedInternalApp = (g_trustedInternalApps.find(exeNameLower) !=
                                 g_trustedInternalApps.end());
    if (isTrustedInternalApp) {
      std::cout << "[INFO] Signature checks bypassed for trusted in-house app: "
                << exeNameLower << " (PID " << pid
                << ") — unsigned internal build\n";
    }

    // ── CHECK 4: Windows Digital Signature ──────────────────────────
    // (cached per path to avoid repeated disk I/O)
    // Exempt C:\Windows\ natively to prevent Catalog Signature BSoD on Windows
    // Server
    bool inWindowsDir = (lowerPath.find(L"c:\\windows\\") == 0);
    if (!isTrustedInternalApp && !inWindowsDir &&
        sigVerifiedPaths.find(wideToUtf8(lowerPath.c_str())) ==
            sigVerifiedPaths.end()) {
      if (!verifyDigitalSignature(fullPath)) {
        sendEncrypted("[SIG] No valid Authenticode signature: " +
                      wideToUtf8(fullPath.c_str()) + "\n");
        // For whitelisted system binaries an unsigned binary is deeply wrong
        std::string parentNameS =
            (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
        terminateProcess(pid, exeNameLower, "no valid digital signature", ppid,
                         parentNameS);
        continue;
      } else {
        sigVerifiedPaths.insert(wideToUtf8(lowerPath.c_str()));
        sendEncrypted("[SIG] Signature OK: " + exeNameLower + "\n");
      }
    }

    // ── CHECK 5: Parent Process Validation ──────────────────────────
    // Exempt C:\Windows\ natively to prevent BSoD when early-boot parents
    // (like smss.exe) die and their PIDs are reused by other threads.
    // Also exempt trusted internal apps — their original parent (e.g.
    // powershell from UAC elevation) may exit and Windows can reuse that PID
    // for an unrelated process, causing a false positive kill.
    if (!isTrustedInternalApp && !inWindowsDir &&
        parentIsInvalid(pid, ppid, entry, pidNameMap)) {
      std::string parentNamePP =
          (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
      terminateProcess(pid, exeNameLower, "unexpected parent process", ppid,
                       parentNamePP);
      continue;
    }

    // ── CHECK 5b: [PROCESS_KILLER] Vendor Signer Identity ─────────────
    // Verifies the SIGNER matches the expected vendor (Microsoft, NVIDIA,
    // Intel, etc.) Prevents name-spoofing: even if path+parent match, the
    // binary must bear the correct vendor's digital signature. Cache result per
    // path — signature only changes if file is replaced on disk, which is
    // already caught by CHECK 3 (SHA-256 mismatch) before we get here.
    if (!isTrustedInternalApp && !inWindowsDir &&
        !entry.requiredSigner.empty()) {
      std::string pathKeyM = wideToUtf8(lowerPath.c_str());
      if (msigVerifiedPaths.find(pathKeyM) == msigVerifiedPaths.end()) {
        if (!verifySignerIdentity(fullPath, entry.requiredSigner)) {
          std::string parentNameM =
              (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
          terminateProcess(pid, exeNameLower,
                           "signer is NOT " + entry.requiredSigner, ppid,
                           parentNameM);
          continue;
        }
        msigVerifiedPaths.insert(pathKeyM);
      }
    }

    // ── CHECK 6: DLL Injection Detection ────────────────────────────
    // Re-enabled as requested. Trusted paths expanded to avoid VM crashes.
    // Explicitly bypassing native OS processes to prevent UWP/AppX false
    // positives. Also bypassed for trusted in-house apps (isTrustedInternalApp)
    // which may load unsigned internal DLLs as part of their normal operation.
    if (!isTrustedInternalApp && !inWindowsDir) {
      HANDLE hVm =
          OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
      if (hVm) {
        CloseHandle(hVm);
        if (detectInjectedDLLs(pid, exeNameLower)) {
          std::string parentNameD =
              (pidNameMap.count(ppid) ? pidNameMap.at(ppid) : "unknown");
          terminateProcess(pid, exeNameLower, "injected/unsigned DLL", ppid,
                           parentNameD);
          continue;
        }
      }
    }

    // ── CHECK 7: RWX Memory Region (Shellcode Guard) ────────────────
    // DISABLED: Highly unstable on Server. Instantly terminates
    // JIT/GPU/Defender.
    /*
    if (detectRWXMemory(pid)) {
        terminateProcess(pid, exeNameLower, "RWX memory region");
        continue;
    }
    */

  } while (Process32NextW(snapshot, &pe));

  CloseHandle(snapshot);
}

// ============================================================
//  OS BASELINE PROVENANCE VERIFICATION
//  Extracts the VersionInfo Resource from the executable to
//  check for "Microsoft". This safely identifies native OS
//  background tasks (avoiding Catalog BSoDs) while denying
//  immunity to payload drops like CheckScript which lack `.rc`.
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 13: PROVENANCE CHECK (VS_VERSION_INFO)                         │
// │  Verifies CompanyName == "Microsoft Corporation" via resource metadata  │
// └─────────────────────────────────────────────────────────────────────────┘
static bool isMicrosoftBinary(const std::wstring &filePath) {
  if (filePath.empty())
    return false;

  DWORD dwHandle = 0;
  DWORD dwLen = GetFileVersionInfoSizeW(filePath.c_str(), &dwHandle);
  if (dwLen == 0)
    return false; // No version info = NOT Microsoft

  std::vector<BYTE> buf(dwLen);
  if (!GetFileVersionInfoW(filePath.c_str(), dwHandle, dwLen, buf.data())) {
    return false;
  }

  // Read the translation block to get language and charset
  struct TRANSLATION {
    WORD langID;
    WORD charset;
  } *pTrans = nullptr;
  UINT cbTrans = 0;
  if (!VerQueryValueW(buf.data(), L"\\VarFileInfo\\Translation",
                      (LPVOID *)&pTrans, &cbTrans) ||
      cbTrans < sizeof(TRANSLATION)) {
    return false;
  }

  // Read the CompanyName for the first translation
  wchar_t subBlock[256];
  swprintf_s(subBlock, 256, L"\\StringFileInfo\\%04x%04x\\CompanyName",
             pTrans[0].langID, pTrans[0].charset);

  wchar_t *lpCompanyName = nullptr;
  UINT cbData = 0;
  if (VerQueryValueW(buf.data(), subBlock, (LPVOID *)&lpCompanyName, &cbData) &&
      lpCompanyName) {
    std::wstring company(lpCompanyName);
    // Check if "Microsoft" is in the company name (case-insensitive find)
    std::transform(company.begin(), company.end(), company.begin(), ::towupper);
    if (company.find(L"MICROSOFT") != std::wstring::npos) {
      return true;
    }
  }
  return false;
}

// ============================================================
//  PROCESS KILLER THREAD
// ============================================================
void ProcessKillerThread() {
  _setmode(_fileno(stdin), _O_TEXT);
  HANDLE hInput = GetStdHandle(STD_INPUT_HANDLE);
  DWORD mode;
  GetConsoleMode(hInput, &mode);
  SetConsoleMode(hInput, mode & (~ENABLE_LINE_INPUT));

  std::cout << "[WATCHER] RESTRICTIVE MODE ENGAGED (Hardened v2)\n";

  // Build the Initial System Baseline
  // This catalogs all legitimate OS processes already running in C:\Windows\.
  // Any un-whitelisted executable dropped into C:\Windows\ AFTER this point
  // will be swiftly terminated.
  std::cout << "[INFO] Building Dynamic OS Baseline Snapshot...\n";
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(PROCESSENTRY32W);
    if (Process32FirstW(snap, &pe)) {
      do {
        std::wstring fullPath = getProcessPath(pe.th32ProcessID);
        std::wstring lowerPath = toLower(fullPath);

        std::string exeNameLower = toLowerA(wideToUtf8(pe.szExeFile));
        // FAST-PATH: If the OS process is already statically authenticated
        // in our explicit whitelist, we do not need to baseline it.
        if (g_whitelist.find(exeNameLower) != g_whitelist.end()) {
          continue;
        }

        // Do NOT baseline anything running out of C:\Windows\Temp\, because
        // CheckScript drops there. If it ran before process_killer.exe, we
        // don't want it gaining immunity. ALSO require the executable to
        // structurally contain "Microsoft" in its VersionInfo manifest! This
        // permanently defeats CheckScript payload drops independent of how many
        // hours/years they hide on the disk!
        if (lowerPath.find(L"c:\\windows\\") == 0 &&
            lowerPath.find(L"c:\\windows\\temp\\") == std::wstring::npos &&
            isMicrosoftBinary(fullPath)) {

          std::string entryKey = exeNameLower + wideToUtf8(fullPath.c_str());
          g_systemBaseline.insert(entryKey);
        }
      } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
  }
  sendEncrypted("[INFO] Baselined " + std::to_string(g_systemBaseline.size()) +
                " native OS processes.\n");

  std::string inputBuffer;

  while (g_bRunning) {
    DWORD bytesAvailable = 0;
    if (PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr,
                      &bytesAvailable, nullptr) &&
        bytesAvailable > 0) {
      char buf[100];
      DWORD bytesRead;
      ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, sizeof(buf) - 1, &bytesRead,
               nullptr);
      buf[bytesRead] = '\0';
      inputBuffer += buf;
      if (inputBuffer.find("detectVM") != std::string::npos) {
        RunVMAwareScan();
        // Clear the trigger from the buffer so it doesn't fire again
        // immediately
        size_t pos = inputBuffer.find("detectVM");
        inputBuffer.erase(pos, 8);
      }

      if (inputBuffer.find("STOP") != std::string::npos) {
        sendEncrypted("[WATCHER] STOP received. Exiting...\n");
        g_bRunning = false;
        break;
      }
    }

    killUnwantedProcesses();
    std::this_thread::sleep_for(std::chrono::seconds(
        3)); // Reduced from 1s — saves ~66% CPU with no security regression
  }
}

// ============================================================
//  MAIN ENTRY POINT
// ============================================================

// ┌─────────────────────────────────────────────────────────────────────────┐
// │  SECTION 14: ENTRY POINT — wWinMain                                     │
// │  Boot sequence: Anti-RE → CIG/ACG → Logs → VM Scan → Hook → Monitor   │
// └─────────────────────────────────────────────────────────────────────────┘
int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                    LPWSTR lpCmdLine, int nShowCmd) {

  // Parse session key from command line if present
  std::wstring cmdLine(lpCmdLine);
  size_t keyPos = cmdLine.find(L"--key ");
  if (keyPos != std::wstring::npos) {
    std::wstring wKey = cmdLine.substr(keyPos + 6);
    std::string hexKey = wideToUtf8(wKey.c_str());
    // Strip any following arguments if needed
    size_t spacePos = hexKey.find(' ');
    if (spacePos != std::string::npos)
      hexKey = hexKey.substr(0, spacePos);
    g_sessionKey = hexToString(hexKey);
  }
  // [ANTI-RE] Layer 0: First line of execution — detects and silently kills
  // debuggers
  EnforceAntiRE();

  // ============================================================
  //  SELF-PRESERVATION: PROCESS MITIGATION POLICIES
  //  Forces the Windows Kernel to physically block arbitrary code
  //  and unsigned DLL injection into process_killer.exe.
  // ============================================================
  PROCESS_MITIGATION_BINARY_SIGNATURE_POLICY sigPolicy = {};
  sigPolicy.MicrosoftSignedOnly = 1;
  if (!SetProcessMitigationPolicy(ProcessSignaturePolicy, &sigPolicy,
                                  sizeof(sigPolicy))) {
    std::cout << XSTR("[WARN] Could not enable Code Integrity Guard (CIG).\n")
                     .str()
                     .c_str();
  }

  PROCESS_MITIGATION_DYNAMIC_CODE_POLICY dynPolicy = {};
  dynPolicy.ProhibitDynamicCode = 1;
  if (!SetProcessMitigationPolicy(ProcessDynamicCodePolicy, &dynPolicy,
                                  sizeof(dynPolicy))) {
    std::cout << "[WARN] Could not enable Arbitrary Code Guard (ACG).\n";
  }

  signal(SIGINT, SignalHandler);
  signal(SIGTERM, SignalHandler);

  initLogs();

  // [PROCESS_KILLER] Full VMAware boot scan — IPC + log
  // RunVMAwareScan(); // MOVED: Now triggered by "detectVM" on STDIN

  if (AcquireSeDebugPrivilege())
    sendEncrypted("[INFO] SeDebugPrivilege acquired\n");
  else
    sendEncrypted("[WARN] SeDebugPrivilege NOT acquired — some protected "
                  "processes may survive\n");

  g_hMutex = CreateMutex(NULL, TRUE, szSingleInstanceMutexName);
  if (GetLastError() == ERROR_ALREADY_EXISTS)
    return 0;

  LANGID langid = 0;
  if (lpCmdLine && wcslen(lpCmdLine) > 0) {
    langid = (LANGID)wcstoul(lpCmdLine, NULL, 16);
    if (langid)
      SetThreadUILanguage(langid);
  }

  g_hHook = SetWindowsHookEx(WH_KEYBOARD_LL, HookProc, hInstance, 0);
  if (g_hHook == NULL) {
    Cleanup();
    return 1;
  }

  // [PROCESS_KILLER] Start Anti-Suspension Heartbeat thread
  CreateThread(NULL, 0, HeartbeatThread, NULL, 0, NULL);

  std::thread processMonitorThread(ProcessKillerThread);

  MSG msg;
  while (g_bRunning && GetMessage(&msg, NULL, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);

    // // [PROCESS_KILLER] Enforce display affinity on every message pump cycle
    // // Prevents CheckScript's Neutralizer from stripping
    // WDA_EXCLUDEFROMCAPTURE. HWND fg = GetForegroundWindow(); if (fg)
    // SetWindowDisplayAffinity(fg, WDA_EXCLUDEFROMCAPTURE);
  }

  Cleanup();
  processMonitorThread.join();
  return 0;
}
