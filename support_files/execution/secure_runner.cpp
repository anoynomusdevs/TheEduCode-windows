#include <windows.h>
#include <iostream>
#include <string>
#include <vector>

void printUsage() {
    std::cerr << "Usage: secure_runner.exe --timeout <ms> --memory <bytes> --cmd <command> [args...]" << std::endl;
}

int main(int argc, char* argv[]) {
    if (argc < 7) {
        printUsage();
        return 1;
    }

    DWORD timeoutMs = 5000;
    SIZE_T memoryLimit = 256 * 1024 * 1024;
    std::string commandLine = "";

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--timeout" && i + 1 < argc) {
            timeoutMs = std::stoul(argv[++i]);
        } else if (arg == "--memory" && i + 1 < argc) {
            memoryLimit = std::stoull(argv[++i]);
        } else if (arg == "--cmd" && i + 1 < argc) {
            // Reconstruct the rest of the command line
            for (int j = i + 1; j < argc; j++) {
                if (j > i + 1) commandLine += " ";
                // Add quotes if argument contains spaces
                std::string part = argv[j];
                if (part.find(' ') != std::string::npos) {
                    commandLine += "\"" + part + "\"";
                } else {
                    commandLine += part;
                }
            }
            break;
        }
    }

    if (commandLine.empty()) {
        std::cerr << "Error: No command provided." << std::endl;
        return 1;
    }

    // 1. Create Job Object
    HANDLE hJob = CreateJobObject(NULL, NULL);
    if (hJob == NULL) {
        std::cerr << "Error: Failed to create job object." << std::endl;
        return 1;
    }

    // 2. Set Extended Limits (Kill on close, Memory limit, Process limit)
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = { 0 };
    jeli.BasicLimitInformation.LimitFlags = 
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | 
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
        JOB_OBJECT_LIMIT_PROCESS_MEMORY |
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        
    jeli.ProcessMemoryLimit = memoryLimit;
    jeli.BasicLimitInformation.ActiveProcessLimit = 5; // Fork bomb protection

    if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli))) {
        std::cerr << "Error: Failed to set job limits." << std::endl;
        CloseHandle(hJob);
        return 1;
    }

    // 3. Set UI Restrictions (Prevent clipboard access, window creation)
    JOBOBJECT_BASIC_UI_RESTRICTIONS uiRes = { 0 };
    uiRes.UIRestrictionsClass =
        JOB_OBJECT_UILIMIT_DESKTOP |
        JOB_OBJECT_UILIMIT_DISPLAYSETTINGS |
        JOB_OBJECT_UILIMIT_EXITWINDOWS |
        JOB_OBJECT_UILIMIT_GLOBALATOMS |
        JOB_OBJECT_UILIMIT_HANDLES |
        JOB_OBJECT_UILIMIT_READCLIPBOARD |
        JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS;

    if (!SetInformationJobObject(hJob, JobObjectBasicUIRestrictions, &uiRes, sizeof(uiRes))) {
        // Non-fatal, just log
    }

    // 4. Create Process (Suspended)
    // Need to set bInheritHandles to TRUE so stdout/stderr piping works
    STARTUPINFOA si = { sizeof(si) };
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    
    PROCESS_INFORMATION pi = { 0 };
    
    // We need a mutable string for CreateProcessA
    std::vector<char> cmdBuffer(commandLine.begin(), commandLine.end());
    cmdBuffer.push_back('\0');

    if (!CreateProcessA(NULL, cmdBuffer.data(), NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
        std::cerr << "Error: Failed to create process. Error Code: " << GetLastError() << std::endl;
        CloseHandle(hJob);
        return 1;
    }

    // 5. Assign to Job Object
    if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
        std::cerr << "Error: Failed to assign process to job. Error Code: " << GetLastError() << std::endl;
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(hJob);
        return 1;
    }

    // 6. Resume Process
    ResumeThread(pi.hThread);

    // 7. Wait with timeout
    DWORD waitResult = WaitForSingleObject(pi.hProcess, timeoutMs);
    
    DWORD exitCode = 1;
    if (waitResult == WAIT_TIMEOUT) {
        std::cerr << "Time Limit Exceeded (" << timeoutMs << "ms)" << std::endl;
        TerminateProcess(pi.hProcess, 121);
        exitCode = 121;
    } else if (waitResult == WAIT_OBJECT_0) {
        GetExitCodeProcess(pi.hProcess, &exitCode);
    } else {
        std::cerr << "Error: Wait failed." << std::endl;
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(hJob);

    return exitCode;
}
