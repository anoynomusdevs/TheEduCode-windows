// =============================================================================
//
//  VM DETECTION — STANDALONE SCANNER
//  Extracted from detection.cpp (v5.0 Hardened) — VMAware library only.
//  No process killing. No key blocking. Pure VM environment detection.
//
//  BUILD (cross-compile on Linux with MinGW-w64):
//    x86_64-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
//      -municode -fexceptions -s -ffunction-sections -fdata-sections \
//      vm_detection.cpp -o vm_detection.exe \
//      -Wl,--gc-sections \
//      -lsetupapi -lwintrust -lcrypt32 -lshlwapi -lbcrypt -lversion -lgdi32 \
//      -ladvapi32
//
//  NOTE on libraries: vmaware.hpp uses the Win32 Registry API
//  (RegGetValueW / RegEnumKeyExW / RegOpenKeyExW / RegQueryValueExA) which
//  lives in advapi32 — required on MinGW. The header also declares
//  #pragma comment(lib, powrprof.lib / wevtapi.lib), but powrprof is only
//  loaded via LoadLibraryA() at runtime and wevtapi is never called —
//  neither needs to be linked explicitly.
//
//  OUTPUT (STDOUT, IPC-friendly):
//    [VM] DETECTED | brand=QEMU | score=87% | conclusion=...
//    [VM] NOT DETECTED | brand=BareMetal | score=3% | conclusion=...
//
//  EXIT CODE: 0 = bare metal, 1 = VM detected (script-friendly)
//
// =============================================================================

#define WINVER 0x0602
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#define VC_EXTRALEAN

#include <windows.h>
#include <iostream>
#include <string>
#include <cstdint>

#include "vmaware.hpp"

// Convert a VM technique enum flag to its human-readable name.
// Mirrors the enum order in vmaware.hpp (VM::enum_flags).
static std::string flagName(VM::enum_flags f) {
  switch (f) {
    case VM::GPU_CAPABILITIES:    return "GPU_CAPABILITIES";
    case VM::ACPI_SIGNATURE:      return "ACPI_SIGNATURE";
    case VM::POWER_CAPABILITIES:  return "POWER_CAPABILITIES";
    case VM::DISK_SERIAL:         return "DISK_SERIAL";
    case VM::IVSHMEM:             return "IVSHMEM";
    case VM::DRIVERS:             return "DRIVERS";
    case VM::DEVICE_HANDLES:      return "DEVICE_HANDLES";
    case VM::VIRTUAL_PROCESSORS:  return "VIRTUAL_PROCESSORS";
    case VM::HYPERVISOR_QUERY:    return "HYPERVISOR_QUERY";
    case VM::AUDIO:               return "AUDIO";
    case VM::DISPLAY:             return "DISPLAY";
    case VM::DLL:                 return "DLL";
    case VM::VMWARE_BACKDOOR:     return "VMWARE_BACKDOOR";
    case VM::WINE:                return "WINE";
    case VM::VIRTUAL_REGISTRY:    return "VIRTUAL_REGISTRY";
    case VM::MUTEX:               return "MUTEX";
    case VM::DEVICE_STRING:       return "DEVICE_STRING";
    case VM::VPC_INVALID:         return "VPC_INVALID";
    case VM::VMWARE_STR:          return "VMWARE_STR";
    case VM::GAMARUE:             return "GAMARUE";
    case VM::CUCKOO_DIR:          return "CUCKOO_DIR";
    case VM::CUCKOO_PIPE:         return "CUCKOO_PIPE";
    case VM::BOOT_LOGO:           return "BOOT_LOGO";
    case VM::TRAP:                return "TRAP";
    case VM::UD:                  return "UD";
    case VM::BLOCKSTEP:           return "BLOCKSTEP";
    case VM::DBVM:                return "DBVM";
    case VM::KERNEL_OBJECTS:      return "KERNEL_OBJECTS";
    case VM::NVRAM:               return "NVRAM";
    case VM::SMBIOS_INTEGRITY:    return "SMBIOS_INTEGRITY";
    case VM::EDID:                return "EDID";
    case VM::CPU_HEURISTIC:       return "CPU_HEURISTIC";
    case VM::CLOCK:               return "CLOCK";
    case VM::MSR:                 return "MSR";
    case VM::SYSTEM_REGISTERS:    return "SYSTEM_REGISTERS";
    case VM::FIRMWARE:            return "FIRMWARE";
    case VM::PCI_DEVICES:         return "PCI_DEVICES";
    case VM::AZURE:               return "AZURE";
    case VM::SMBIOS_VM_BIT:       return "SMBIOS_VM_BIT";
    case VM::KMSG:                return "KMSG";
    case VM::CVENDOR:             return "CVENDOR";
    case VM::QEMU_FW_CFG:         return "QEMU_FW_CFG";
    case VM::SYSTEMD:             return "SYSTEMD";
    case VM::CTYPE:               return "CTYPE";
    case VM::DOCKERENV:           return "DOCKERENV";
    case VM::DMIDECODE:           return "DMIDECODE";
    case VM::DMESG:               return "DMESG";
    case VM::HWMON:               return "HWMON";
    case VM::LINUX_USER_HOST:     return "LINUX_USER_HOST";
    case VM::VMWARE_IOMEM:        return "VMWARE_IOMEM";
    case VM::VMWARE_IOPORTS:      return "VMWARE_IOPORTS";
    case VM::VMWARE_SCSI:         return "VMWARE_SCSI";
    case VM::VMWARE_DMESG:        return "VMWARE_DMESG";
    case VM::QEMU_VIRTUAL_DMI:    return "QEMU_VIRTUAL_DMI";
    case VM::QEMU_USB:            return "QEMU_USB";
    case VM::HYPERVISOR_DIR:      return "HYPERVISOR_DIR";
    case VM::UML_CPU:             return "UML_CPU";
    case VM::VBOX_MODULE:         return "VBOX_MODULE";
    case VM::SYSINFO_PROC:        return "SYSINFO_PROC";
    case VM::DMI_SCAN:            return "DMI_SCAN";
    case VM::PODMAN_FILE:         return "PODMAN_FILE";
    case VM::WSL_PROC:            return "WSL_PROC";
    case VM::FILE_ACCESS_HISTORY: return "FILE_ACCESS_HISTORY";
    case VM::MAC:                 return "MAC";
    case VM::NSJAIL_PID:          return "NSJAIL_PID";
    case VM::BLUESTACKS_FOLDERS:  return "BLUESTACKS_FOLDERS";
    case VM::AMD_SEV:             return "AMD_SEV";
    case VM::TEMPERATURE:         return "TEMPERATURE";
    case VM::PROCESSES:           return "PROCESSES";
    case VM::THREAD_COUNT:        return "THREAD_COUNT";
    case VM::MAC_MEMSIZE:         return "MAC_MEMSIZE";
    case VM::MAC_IOKIT:           return "MAC_IOKIT";
    case VM::MAC_SIP:             return "MAC_SIP";
    case VM::IOREG_GREP:          return "IOREG_GREP";
    case VM::HWMODEL:             return "HWMODEL";
    case VM::MAC_SYS:             return "MAC_SYS";
    case VM::HYPERVISOR_BIT:      return "HYPERVISOR_BIT";
    case VM::VMID:                return "VMID";
    case VM::THREAD_MISMATCH:     return "THREAD_MISMATCH";
    case VM::TIMER:               return "TIMER";
    case VM::CPU_BRAND:           return "CPU_BRAND";
    case VM::HYPERVISOR_STR:      return "HYPERVISOR_STR";
    case VM::CPUID_SIGNATURE:     return "CPUID_SIGNATURE";
    case VM::BOCHS_CPU:           return "BOCHS_CPU";
    case VM::KGT_SIGNATURE:       return "KGT_SIGNATURE";
    default:                      return "FLAG_" + std::to_string(static_cast<int>(f));
  }
}

int wmain() {
  // Full VMAware scan
  const bool isVM   = VM::detect();
  const std::string brand  = VM::brand();
  const uint8_t  score = VM::percentage();
  const std::string concl = VM::conclusion();

  // Brand name
  std::string brandName = brand;
  if (brand.empty() || brand == "Unknown") {
    brandName = "BareMetal";
  }

  if (isVM) {
    std::cout << "[VM] DETECTED | brand=" << brandName
              << " | score=" << static_cast<int>(score) << "%"
              << " | conclusion=" << concl << "\n";
  } else {
    std::cout << "[VM] NOT DETECTED | brand=" << brandName
              << " | score=" << static_cast<int>(score) << "%"
              << " | conclusion=" << concl << "\n";
  }

  // Extended detail — run with --verbose for per-technique breakdown
  if (wcsstr(GetCommandLineW(), L"--verbose")) {
    const auto enums = VM::detected_enums();
    std::cout << "[VM] TRIGGERED TECHNIQUES: " << enums.size() << "\n";
    for (const auto e : enums) {
      std::cout << "  - " << flagName(e) << "\n";
    }
  }

  // Exit code: 0 = bare metal, 1 = VM detected (script-friendly)
  return isVM ? 1 : 0;
}
