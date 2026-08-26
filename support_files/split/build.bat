@echo off
setlocal enabledelayedexpansion
REM =============================================================================
REM  BUILD SCRIPT — split process_killer project (WINDOWS .BAT)
REM  Builds both Windows targets. Works with MinGW-w64 OR MSVC on Windows.
REM
REM  USAGE:
REM    build.bat              build both
REM    build.bat vm           vm_detection.exe only
REM    build.bat killer       process_killer.exe only
REM    build.bat clean        delete the .exe outputs
REM
REM  OUTPUT (in this directory):
REM    vm_detection.exe        - standalone VM detector (no killing)
REM    process_killer.exe      - proctoring agent w/ VMAware (active kill)
REM
REM  NOTE: process_killer.exe is the ACTIVE build - it terminates processes.
REM  For a non-destructive test build, see detection_dryrun.cpp in the parent
REM  directory or run in a throwaway VM.
REM
REM =============================================================================
REM  PROJECT STRUCTURE (what each file is)
REM =============================================================================
REM
REM  vmaware.hpp               - VMAware VM-detection library (14,184 lines).
REM                              Extracted VERBATIM from lines 1-14184 of the
REM                              original detection.cpp. Header-only: it carries
REM                              its own #includes, the full VM:: namespace with
REM                              100+ detection techniques (CPUID, ACPI, SMBIOS,
REM                              MAC, DLL, registry, timing...), brand scoring
REM                              and memoization. Include guard closes at the
REM                              end - no edits, no changes.
REM
REM  vm_detection.cpp          - NEW standalone VM scanner (161 lines). The
REM                              "training wheels" build: includes vmaware.hpp,
REM                              runs VM::detect() / brand() / percentage() /
REM                              conclusion() / detected_enums(), prints one
REM                              IPC-friendly line, exits 0 (bare metal) or
REM                              1 (VM detected). --verbose adds per-technique
REM                              breakdown. It does NOT kill anything.
REM
REM  process_killer.cpp        - the original core engine (1,629 lines), i.e.
REM                              lines 14,191-15,816 of the old detection.cpp:
REM                              key blocker, blacklist + whitelist kill engine,
REM                              SHA-256 + digital-signature checks, DLL-injection
REM                              and RWX-memory guards, anti-suspension heartbeat,
REM                              anti-RE self-termination. The ONLY edit: the
REM                              inline VMAware copy was removed and replaced with
REM                              #include "vmaware.hpp". Logic is byte-for-byte
REM                              identical to the original.
REM
REM  build.bat                 - this script.
REM
REM  HOW THE PIECES FIT:
REM    process_killer.cpp -+
REM                        +--> vmaware.hpp  (shared library, included twice)
REM    vm_detection.cpp ---+
REM
REM    process_killer.exe calls VM::detect() etc. inside RunVMAwareScan(),
REM    which is triggered on demand when the Electron frontend writes
REM    "detectVM" to STDIN. vm_detection.exe calls the same library directly.
REM    Both link the same 7 Windows libs - see LIBS below.
REM
REM =============================================================================
REM  PREREQUISITES (pick one toolchain)
REM =============================================================================
REM
REM  OPTION A - MinGW-w64 (GCC), recommended:
REM    Install via:  winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT
REM    or download from: https://winlibs.com  (x86_64, UCRT, POSIX threads)
REM    Make sure x86_64-w64-mingw32-g++.exe is on your PATH.
REM
REM  OPTION B - MSVC (Visual Studio / Build Tools):
REM    Install "Desktop development with C++" workload, then run this from a
REM    "x64 Native Tools Command Prompt for VS" so cl.exe and link.exe are on
REM    the PATH. Build will auto-detect cl.exe and use it instead of MinGW.
REM
REM =============================================================================
REM  MANUAL COMPILE (MinGW-w64, same as build.sh)
REM =============================================================================
REM
REM  TARGET 1 - vm_detection.exe:
REM    x86_64-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ ^
REM      -municode -fexceptions -s -ffunction-sections -fdata-sections ^
REM      vm_detection.cpp -o vm_detection.exe -Wl,--gc-sections ^
REM      -lsetupapi -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lgdi32
REM
REM  TARGET 2 - process_killer.exe:
REM    x86_64-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ ^
REM      -municode -fexceptions -s -ffunction-sections -fdata-sections ^
REM      process_killer.cpp -o process_killer.exe -Wl,--gc-sections ^
REM      -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lsetupapi -lgdi32
REM
REM  FLAGS:  -O2 optimize | -static bundle runtimes (no DLL deps) |
REM          -municode unicode entry point | -fexceptions C++ exceptions/SEH |
REM          -s strip symbols (anti-RE) |
REM          -ffunction-sections -fdata-sections -Wl,--gc-sections
REM          dead-code elimination, scrambles layout (anti-RE)
REM
REM  LIBS:   -lwintrust WinVerifyTrust (signatures) | -lcrypt32 cert chain/AES |
REM          -lshlwapi PathFileExistsW | -lbcrypt AES-CBC + heartbeat |
REM          -lversion VersionInfo provenance | -lsetupapi VMAware device enum |
REM          -lgdi32 GetDeviceCaps (VMAware display) |
REM          -ladvapi32 registry APIs (RegGetValueW etc.) - REQUIRED on MinGW
REM
REM  NOTE: header declares #pragma comment(lib, powrprof.lib / wevtapi.lib)
REM  but powrprof is only loaded via LoadLibrary at runtime and wevtapi is
REM  never called - neither needs to be linked.
REM
REM  STEP 2 (production only) - UPX pack the killer:
REM    upx --ultra-brute process_killer.exe -o process_killer_protected.exe
REM
REM =============================================================================

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=both"

REM ---------------- CLEAN ----------------
if /i "%TARGET%"=="clean" (
    if exist vm_detection.exe     del /q vm_detection.exe
    if exist process_killer.exe   del /q process_killer.exe
    echo [*] Cleaned.
    exit /b 0
)

REM ---------------- TOOLCHAIN DETECT ----------------
set "COMPILER="
where x86_64-w64-mingw32-g++ >nul 2>nul && set "COMPILER=mingw"
where cl.exe >nul 2>nul && set "COMPILER=msvc"

if not defined COMPILER (
    echo [!] No compiler found on PATH.
    echo     MinGW: install WinLibs from https://winlibs.com and add bin\ to PATH.
    echo     MSVC : run this from "x64 Native Tools Command Prompt for VS".
    exit /b 1
)
echo [*] Toolchain: %COMPILER%

REM ---------------- BUILD ----------------
set "COMMON_MINGW=-O2 -static -static-libgcc -static-libstdc++ -municode -fexceptions -s -ffunction-sections -fdata-sections -Wl,--gc-sections"
set "LIBS_MINGW=-lsetupapi -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lgdi32 -ladvapi32"

if "%TARGET%"=="both"   call :build_vm %COMPILER%
if "%TARGET%"=="vm"     call :build_vm %COMPILER%
if "%TARGET%"=="killer" call :build_killer %COMPILER%
if "%TARGET%"=="both"   call :build_killer %COMPILER%

echo [*] Done.
exit /b 0

REM ================= SUBROUTINE: vm_detection.exe =================
:build_vm
echo [*] Building vm_detection.exe ...
if "%~1"=="mingw" (
    x86_64-w64-mingw32-g++ %COMMON_MINGW% vm_detection.cpp -o vm_detection.exe %LIBS_MINGW%
) else (
    cl /nologo /O2 /EHsc /MT /utf-8 /DUNICODE /D_UNICODE ^
       vm_detection.cpp /Fe:vm_detection.exe ^
       setupapi.lib wintrust.lib crypt32.lib shlwapi.lib bcrypt.lib version.lib gdi32.lib advapi32.lib
)
if errorlevel 1 ( echo [x] vm_detection.exe FAILED & exit /b 1 )
echo [+] vm_detection.exe OK
exit /b 0

REM ================= SUBROUTINE: process_killer.exe =================
:build_killer
echo [*] Building process_killer.exe ...
if "%~1"=="mingw" (
    x86_64-w64-mingw32-g++ %COMMON_MINGW% process_killer.cpp -o process_killer.exe %LIBS_MINGW%
) else (
    cl /nologo /O2 /EHsc /MT /utf-8 /DUNICODE /D_UNICODE ^
       process_killer.cpp /Fe:process_killer.exe ^
       setupapi.lib wintrust.lib crypt32.lib shlwapi.lib bcrypt.lib version.lib gdi32.lib advapi32.lib
)
if errorlevel 1 ( echo [x] process_killer.exe FAILED & exit /b 1 )
echo [+] process_killer.exe OK
exit /b 0
