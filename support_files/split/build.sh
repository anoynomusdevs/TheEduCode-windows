#!/bin/bash
# =============================================================================
#  BUILD SCRIPT — split process_killer project
#  Builds both Windows targets from the split sources using MinGW-w64.
#
#  USAGE:
#    ./build.sh              # build both
#    ./build.sh vm           # vm_detection.exe only
#    ./build.sh killer       # process_killer.exe only
#
#  OUTPUT (in this directory):
#    vm_detection.exe        — standalone VM detector (no killing)
#    process_killer.exe      — proctoring agent w/ VMAware (active kill)
#
#  NOTE: process_killer.exe is the ACTIVE build — it terminates processes.
#  For a non-destructive test build, compile with -DDRYRUN behavior instead
#  (see detection_dryrun.cpp in the parent dir) or run in a throwaway VM.
#
# =============================================================================
#  PROJECT STRUCTURE (what each file is)
# =============================================================================
#
#  vmaware.hpp               — VMAware VM-detection library (14,184 lines).
#                              Extracted VERBATIM from lines 1–14,184 of the
#                              original detection.cpp. Header-only: it carries
#                              its own #includes, the full VM:: namespace with
#                              100+ detection techniques (CPUID, ACPI, SMBIOS,
#                              MAC, DLL, registry, timing...), brand scoring
#                              and memoization. Include guard closes at the
#                              end — no edits, no changes.
#
#  vm_detection.cpp          — NEW standalone VM scanner (161 lines). The
#                              "training wheels" build: includes vmaware.hpp,
#                              runs VM::detect() / brand() / percentage() /
#                              conclusion() / detected_enums(), prints one
#                              IPC-friendly line, exits 0 (bare metal) or
#                              1 (VM detected). --verbose adds per-technique
#                              breakdown. It does NOT kill anything.
#
#  process_killer.cpp        — the original core engine (1,629 lines), i.e.
#                              lines 14,191–15,816 of the old detection.cpp:
#                              key blocker, blacklist + whitelist kill engine,
#                              SHA-256 + digital-signature checks, DLL-injection
#                              and RWX-memory guards, anti-suspension heartbeat,
#                              anti-RE self-termination. The ONLY edit: the
#                              inline VMAware copy was removed and replaced with
#                              #include "vmaware.hpp" (line ~27). Logic is
#                              byte-for-byte identical to the original.
#
#  build.sh                  — this script.
#
#  HOW THE PIECES FIT:
#    process_killer.cpp ──┐
#                         ├──► vmaware.hpp  (shared library, included twice)
#    vm_detection.cpp ────┘
#
#    process_killer.exe calls VM::detect() etc. inside RunVMAwareScan(),
#    which is triggered on demand when the Electron frontend writes
#    "detectVM" to STDIN. vm_detection.exe calls the same library directly.
#    Both link the same 7 Windows libs — see LIBS_* below.
#
# =============================================================================
#  MANUAL COMPILE (if you don't want the script)
# =============================================================================
#
#  PREREQUISITE (Ubuntu):
#    sudo apt-get install gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64
#
#  COMMON FLAGS (why each):
#    -O2                  optimize
#    -static              bundle libs into the exe (no DLL deps at runtime)
#    -static-libgcc/-stdc++ same, for the C/C++ runtimes
#    -municode            _wmain / wWinMain unicode entry point
#    -fexceptions         C++ exceptions + MinGW SEH support
#    -s                   strip symbols (anti-RE, hides names in Ghidra/IDA)
#    -ffunction-sections / -fdata-sections / -Wl,--gc-sections
#                         dead-code elimination, scrambles layout (anti-RE)
#
#  LIBRARIES (why each):
#    -lwintrust   WinVerifyTrust  — Authenticode signature verification
#    -lcrypt32    CryptQueryObject — cert chain, CryptBinaryToStringA (AES)
#    -lshlwapi    PathFileExistsW  — shell path utilities
#    -lbcrypt     BCrypt           — AES-256-CBC telemetry + heartbeat timer
#    -lversion    GetFileVersionInfoW — VS_VERSION_INFO provenance checks
#    -lsetupapi   SetupDiGetDeviceRegistryPropertyW — VMAware device enum
#    -lgdi32      GetDeviceCaps    — VMAware display detection
#    -ladvapi32   Registry APIs    — RegGetValueW / RegEnumKeyExW /
#                                    RegOpenKeyExW / RegQueryValueExA used by
#                                    the VMAware library. REQUIRED on MinGW
#                                    (msvcrt does not auto-link it; MSVC links
#                                    it implicitly via windows.h defaults).
#                                    NOTE: the header also declares
#                                    #pragma comment(lib, powrprof.lib / 
#                                    wevtapi.lib) but both are ONLY used via
#                                    LoadLibrary at runtime (powrprof) or not
#                                    called at all (wevtapi) — no link needed.
#
#  TARGET 1 — vm_detection.exe:
#    x86_64-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
#      -municode -fexceptions -s -ffunction-sections -fdata-sections \
#      vm_detection.cpp -o vm_detection.exe -Wl,--gc-sections \
#      -lsetupapi -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lgdi32 \
#      -ladvapi32
#
#  TARGET 2 — process_killer.exe:
#    x86_64-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
#      -municode -fexceptions -s -ffunction-sections -fdata-sections \
#      process_killer.cpp -o process_killer.exe -Wl,--gc-sections \
#      -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lsetupapi -lgdi32 \
#      -ladvapi32
#
#  STEP 2 (production only) — UPX pack the killer:
#    ./upx --ultra-brute process_killer.exe -o process_killer_protected.exe
#
# =============================================================================
set -e
cd "$(dirname "$0")"

MINGW=x86_64-w64-mingw32-g++
if ! command -v $MINGW >/dev/null 2>&1 && command -v ${MINGW}-posix >/dev/null 2>&1; then
  MINGW=${MINGW}-posix
fi
COMMON="-O2 -static -static-libgcc -static-libstdc++ -municode -fexceptions -s -ffunction-sections -fdata-sections -Wl,--gc-sections"
LIBS_VM="-lsetupapi -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lgdi32 -ladvapi32"
LIBS_KILLER="-lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lsetupapi -lgdi32 -ladvapi32"

if [ ! -x "$(command -v $MINGW)" ]; then
  echo "[!] MinGW-w64 not found. Install:"
  echo "    sudo apt-get install gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64"
  exit 1
fi

TARGET="${1:-both}"

if [ "$TARGET" = "vm" ] || [ "$TARGET" = "both" ]; then
  echo "[*] Building vm_detection.exe ..."
  $MINGW $COMMON vm_detection.cpp -o vm_detection.exe $LIBS_VM
  echo "[+] vm_detection.exe OK"
fi

if [ "$TARGET" = "killer" ] || [ "$TARGET" = "both" ]; then
  echo "[*] Building process_killer.exe ..."
  $MINGW $COMMON process_killer.cpp -o process_killer.exe $LIBS_KILLER
  echo "[+] process_killer.exe OK"
fi

echo "[*] Done."
