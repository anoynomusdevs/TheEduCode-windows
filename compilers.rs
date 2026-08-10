// src-tauri/src/compilers.rs
// Offline Compiler Handlers for C++, Java, Python, and SQLite
// Safe execution in isolated directories, timeout guards, Job Object process trees, and deadlock-free stream limits

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager, Emitter};
use tokio::fs::{create_dir_all, remove_dir_all, write};
use tokio::process::Command;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tokio::time::{sleep, Duration};
use tokio::io::AsyncReadExt;

const TIMEOUT_COMPILE_CPP: u64 = 10;
const TIMEOUT_COMPILE_JAVA: u64 = 20;
const TIMEOUT_COMPILE_PYTHON: u64 = 3;
const TIMEOUT_COMPILE_SQL: u64 = 3;

const TIMEOUT_EXECUTE_CPP: u64 = 2;
const TIMEOUT_EXECUTE_JAVA: u64 = 5;
const TIMEOUT_EXECUTE_PYTHON: u64 = 3;
const TIMEOUT_EXECUTE_SQL: u64 = 2;

pub const MEMORY_LIMIT_BYTES_CPP: usize = 256 * 1024 * 1024;
pub const MEMORY_LIMIT_BYTES_JAVA: usize = 512 * 1024 * 1024;
pub const MEMORY_LIMIT_BYTES_PYTHON: usize = 256 * 1024 * 1024;

pub fn obfuscate_paths(text: &str) -> String {
    let mut obfuscated = text.to_string();
    
    // Mask Local AppData (where extras are stored)
    if let Some(appdata) = dirs::data_local_dir() {
        let appdata_str = appdata.to_string_lossy().to_string();
        obfuscated = obfuscated.replace(&appdata_str, "[SYSTEM_ROOT]");
    }
    
    // Mask Roaming AppData just in case
    if let Some(roaming) = dirs::data_dir() {
        let roaming_str = roaming.to_string_lossy().to_string();
        obfuscated = obfuscated.replace(&roaming_str, "[SYSTEM_ROAMING]");
    }

    // Mask system Temp dir
    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
    obfuscated = obfuscated.replace(&temp_dir, "[SYSTEM_TEMP]");

    obfuscated
}

const MAX_OUTPUT_LIMIT_BYTES: usize = 64 * 1024; // Strict 64KB safety limit

pub static SUPPORTED_COMPILERS: Lazy<Mutex<Vec<u32>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn attempt_self_heal(app_handle: &AppHandle, asset_id: &str) {
    log::info!("[SELF-HEAL] attempt_self_heal started for asset: '{}'", asset_id);
    let extras_dir = crate::bootstrapper::get_extras_dir(app_handle);
    log::info!("[SELF-HEAL] Resolved extras_dir: {:?}", extras_dir);

    if !extras_dir.exists() {
        log::error!("[SELF-HEAL] Extras dir DOES NOT EXIST! Cannot heal asset '{}'.", asset_id);
        return;
    }

    let heal_file = extras_dir.join(format!("healed_{}.txt", asset_id));
    log::info!("[SELF-HEAL] Checking heal tracking file: {:?}", heal_file);
    
    let should_heal = if heal_file.exists() {
        if let Ok(metadata) = std::fs::metadata(&heal_file) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(elapsed) = modified.elapsed() {
                    let over_limit = elapsed.as_secs() > 78 * 3600;
                    log::info!("[SELF-HEAL] Heal file exists. Elapsed time: {} secs. Should heal (over 78h limit)? {}", elapsed.as_secs(), over_limit);
                    over_limit
                } else {
                    log::warn!("[SELF-HEAL] Could not determine elapsed time for heal file. Defaulting to false.");
                    false
                }
            } else {
                log::warn!("[SELF-HEAL] Could not determine modified time for heal file. Defaulting to false.");
                false
            }
        } else {
            log::warn!("[SELF-HEAL] Could not read metadata for heal file. Defaulting to false.");
            false
        }
    } else {
        log::info!("[SELF-HEAL] Heal file does not exist. Healing should proceed.");
        true
    };

    if should_heal {
        log::info!("[SELF-HEAL] Healing triggered for '{}'. Deleting corrupted asset directory to force bootstrap on next launch...", asset_id);
        let asset_dir = extras_dir.join("SystemCache").join("Runtime").join(asset_id);
        if asset_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&asset_dir) {
                log::error!("[SELF-HEAL] Failed to delete asset directory {:?}: {}", asset_dir, e);
            } else {
                log::info!("[SELF-HEAL] Successfully deleted asset directory: {:?}", asset_dir);
                let _ = std::fs::write(&heal_file, "");
            }
        } else {
            log::warn!("[SELF-HEAL] Asset directory {:?} does not exist, nothing to delete.", asset_dir);
        }
    } else {
        log::info!("[SELF-HEAL] Skipping heal for '{}' - recent heal attempt exists.", asset_id);
    }
    log::info!("[SELF-HEAL] attempt_self_heal finished for asset: '{}'", asset_id);
}

pub async fn smoke_test_compilers(app: AppHandle, langs_to_test: Option<Vec<u32>>) {
    log::info!("[SMOKE-TEST] Starting smoke tests. Targets: {:?}", langs_to_test);
    let mut working = Vec::new();
    
    let test_all = langs_to_test.is_none();
    let targets = langs_to_test.unwrap_or_else(|| vec![201, 202, 205, 204]);
    
    // Test C
    if targets.contains(&201) {
        let req_c = CompileRequest {
            language: 201,
            code: "#include <stdio.h>\nint main() { printf(\"1\"); return 0; }".to_string(),
            session_id: "smoke_test_c".to_string(),
            stdin: None,
            test_cases: Some(vec!["".to_string()]),
        };
        let mut c_ok = false;
        if let Ok(res) = execute_offline_compilation(app.clone(), req_c).await {
            if res.compile_success && res.run_success {
                working.push(201);
                log::info!("[SMOKE-TEST] C engine verified.");
                c_ok = true;
            }
        }
        if !c_ok {
            attempt_self_heal(&app, "v8_engine_core");
        }
    }
    
    // Test C++
    if targets.contains(&202) {
        let req_cpp = CompileRequest {
            language: 202,
            code: "#include <iostream>\nint main() { std::cout << \"1\"; return 0; }".to_string(),
            session_id: "smoke_test_cpp".to_string(),
            stdin: None,
            test_cases: Some(vec!["".to_string()]),
        };
        let mut cpp_ok = false;
        if let Ok(res) = execute_offline_compilation(app.clone(), req_cpp).await {
            if res.compile_success && res.run_success {
                working.push(202);
                log::info!("[SMOKE-TEST] C++ engine verified.");
                cpp_ok = true;
            }
        }
        if !cpp_ok {
            attempt_self_heal(&app, "v8_engine_core");
        }
    }
    
    // Slight delay to prevent CPU/IO spiking during bootstrapper
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    
    // Test Java + H2
    if targets.contains(&205) {
        let req_java = CompileRequest {
            language: 205,
            code: "import java.sql.*;\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        Class.forName(\"org.h2.Driver\");\n        Connection conn = DriverManager.getConnection(\"jdbc:h2:mem:test\", \"sa\", \"\");\n        System.out.println(\"1\");\n    }\n}".to_string(),
            session_id: "smoke_test_java".to_string(),
            stdin: None,
            test_cases: Some(vec!["".to_string()]),
        };
        let mut success = false;
        if let Ok(res) = execute_offline_compilation(app.clone(), req_java).await {
            if res.compile_success && res.run_success {
                working.push(205);
                log::info!("[SMOKE-TEST] Java engine verified.");
                success = true;
            }
        }
        if !success {
            attempt_self_heal(&app, "jvm_telemetry");
        }
    }
    
    // Slight delay to prevent CPU/IO spiking during bootstrapper
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    
    // Test Python + SQLite
    if targets.contains(&204) {
        let req_python = CompileRequest {
            language: 204,
            code: "import sqlite3\nprint('1')".to_string(),
            session_id: "smoke_test_python".to_string(),
            stdin: None,
            test_cases: Some(vec!["".to_string()]),
        };
        let mut success = false;
        if let Ok(res) = execute_offline_compilation(app.clone(), req_python).await {
            if res.run_success {
                working.push(204);
                log::info!("[SMOKE-TEST] Python engine verified.");
                success = true;
            }
        }
        if !success {
            attempt_self_heal(&app, "pyscript_bridge");
        }
    }
    
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    

    let mut global_supported = SUPPORTED_COMPILERS.lock().unwrap();
    if test_all {
        *global_supported = working.clone();
    } else {
        // 1. Remove targets that we attempted to test but failed
        for t in &targets {
            if !working.contains(t) {
                global_supported.retain(|&x| x != *t);
            }
        }
        // 2. Add targets that succeeded
        for w in &working {
            if !global_supported.contains(w) {
                global_supported.push(w.clone());
            }
        }
    }
    log::info!("[SMOKE-TEST] Completed. Working offline compilers: {:?}", *global_supported);
    let _ = app.emit("SMOKE_TEST_SUCCESS", global_supported.clone());
}

#[tauri::command]
pub fn get_supported_offline_compilers() -> Vec<u32> {
    crate::trace_scope!("get_supported_offline_compilers");
    SUPPORTED_COMPILERS.lock().unwrap().clone()
}


#[derive(Debug, Clone, Deserialize)]
pub struct CompileRequest {
    pub language: u32,
    pub code: String,
    pub session_id: String,
    pub stdin: Option<String>,
    pub test_cases: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TestCaseResult {
    pub run_success: bool,
    pub run_error: String,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecutionResponse {
    pub compile_success: bool,
    pub compile_error: String,
    pub run_success: bool,
    pub run_error: String,
    pub stdout: String,
    pub stderr: String,
    pub results: Vec<TestCaseResult>,
}

pub struct ProcessOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub killed_by_limit: bool,
    pub exit_code: Option<i32>,
}

pub enum ExitClassification {
    Success,
    TimeLimitExceeded,
    StudentFault,
    SystemFault(String),
}

pub fn classify_exit(output: &ProcessOutput) -> ExitClassification {
    log::info!("[TRACE] Entered function: classify_exit...");
    if output.killed_by_limit {
        return ExitClassification::TimeLimitExceeded;
    }
    if output.success {
        return ExitClassification::Success;
    }

    let code = output.exit_code.unwrap_or(-1);
    
    // Normal compilation or runtime error
    if code == 1 || code == 2 {
        return ExitClassification::StudentFault;
    }

    // Abnormal OS exit but student code threw a stack trace
    if !output.stderr.trim().is_empty() {
        return ExitClassification::StudentFault;
    }

    // Abnormal OS exit with completely empty stderr
    log::error!("[COMPILER-SYSTEM-FAULT] Process crashed at OS level (Exit Code: {}). Partial stdout: '{}'", code, output.stdout);
    ExitClassification::SystemFault(format!("Process crashed at OS level (Exit Code: {})", code))
}

/// Helper to spawn a process with exponential backoff to handle ERROR_SHARING_VIOLATION from Windows Defender
pub async fn spawn_with_backoff(cmd: &mut tokio::process::Command) -> std::io::Result<tokio::process::Child> {
    let mut delay = 50;
    let max_retries = 4;
    for _ in 0..max_retries {
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                log::warn!("[COMPILER] Permission denied (Antivirus lock?), retrying in {}ms...", delay);
                tokio::time::sleep(Duration::from_millis(delay)).await;
                delay *= 2; // 50, 100, 200, 400
            }
            Err(e) => return Err(e),
        }
    }
    // Final attempt
    let final_res = cmd.spawn();
    if let Err(e) = &final_res {
        log::error!("[COMPILER-SPAWN-FAIL] Fatal spawn failure ({}). Command trace: {:?}", e, cmd);
    }
    final_res
}

/// Helper that drains process pipes concurrently using tokio::select! to prevent OS pipe buffer deadlocks.
/// Automatically terminates execution if limits (bytes/time) are breached.
pub async fn execute_with_timeout_and_limit(
    mut child: tokio::process::Child,
    timeout_duration: Duration,
    max_bytes: usize,
) -> Result<ProcessOutput, String> {
    log::info!("[TRACE] Entered function: execute_with_timeout_and_limit...");
    let start_time = std::time::Instant::now();
    let mut result = execute_with_timeout_and_limit_inner(child, timeout_duration, max_bytes).await;
    
    // Obfuscate local paths in stdout and stderr so students don't see system directories
    if let Ok(ref mut output) = result {
        output.stdout = obfuscate_paths(&output.stdout);
        output.stderr = obfuscate_paths(&output.stderr);
    }

    let elapsed = start_time.elapsed();
    if let Ok(ref output) = result {
        log::info!("[COMPILER] Execution finished in {:.3} seconds. Success: {}, Exit Code: {:?}. Stdout size: {} bytes, Stderr size: {} bytes.", 
            elapsed.as_secs_f64(), output.success, output.exit_code, output.stdout.len(), output.stderr.len());
    } else if let Err(ref e) = result {
        log::error!("[COMPILER] Execution failed in {:.3} seconds. Error: {}", elapsed.as_secs_f64(), e);
    }
    result
}

async fn execute_with_timeout_and_limit_inner(
    mut child: tokio::process::Child,
    timeout_duration: Duration,
    max_bytes: usize,
) -> Result<ProcessOutput, String> {
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();

    let mut stdout_finished = stdout.is_none();
    let mut stderr_finished = stderr.is_none();

    let timeout_fut = sleep(timeout_duration);
    tokio::pin!(timeout_fut);

    let mut stdout_stream = stdout.ok_or("Failed to capture stdout stream")?;
    let mut stderr_stream = stderr.ok_or("Failed to capture stderr stream")?;

    let mut stdout_temp = [0u8; 1024];
    let mut stderr_temp = [0u8; 1024];

    let mut killed_by_limit = false;

    loop {
        tokio::select! {
            _ = &mut timeout_fut => {
                let _ = child.kill().await;
                return Ok(ProcessOutput {
                    success: false,
                    stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
                    stderr: format!(
                        "{}\n[CRITICAL ERROR] Execution Timed Out: Safety ceiling of {}s breached.",
                        String::from_utf8_lossy(&stderr_buf),
                        timeout_duration.as_secs()
                    ),
                    killed_by_limit: true,
                    exit_code: None,
                });
            }
            res = stdout_stream.read(&mut stdout_temp), if !stdout_finished => {
                match res {
                    Ok(0) => {
                        stdout_finished = true;
                    }
                    Ok(n) => {
                        if stdout_buf.len() + n > max_bytes {
                            stdout_buf.extend_from_slice(&stdout_temp[..max_bytes - stdout_buf.len()]);
                            killed_by_limit = true;
                            let _ = child.kill().await;
                            break;
                        } else {
                            stdout_buf.extend_from_slice(&stdout_temp[..n]);
                        }
                    }
                    Err(e) => {
                        let _ = child.kill().await;
                        return Err(format!("Stdout read error: {}", e));
                    }
                }
            }
            res = stderr_stream.read(&mut stderr_temp), if !stderr_finished => {
                match res {
                    Ok(0) => {
                        stderr_finished = true;
                    }
                    Ok(n) => {
                        if stderr_buf.len() + n > max_bytes {
                            stderr_buf.extend_from_slice(&stderr_temp[..max_bytes - stderr_buf.len()]);
                            killed_by_limit = true;
                            let _ = child.kill().await;
                            break;
                        } else {
                            stderr_buf.extend_from_slice(&stderr_temp[..n]);
                        }
                    }
                    Err(e) => {
                        let _ = child.kill().await;
                        return Err(format!("Stderr read error: {}", e));
                    }
                }
            }
            status_res = child.wait() => {
                match status_res {
                    Ok(status) => {
                        // Drain remaining streams within remaining limit, but force a strict 50ms timeout.
                        // CRITICAL: If a grandchild process inherited the stdout/stderr pipes, `read_to_end` will block FOREVER
                        // because the grandchild keeps the pipe open even after the immediate child exits.
                        if !stdout_finished {
                            let mut drain_stdout = Vec::new();
                            let _ = tokio::time::timeout(tokio::time::Duration::from_millis(50), stdout_stream.read_to_end(&mut drain_stdout)).await;
                            let cap = max_bytes.saturating_sub(stdout_buf.len());
                            stdout_buf.extend_from_slice(&drain_stdout[..std::cmp::min(drain_stdout.len(), cap)]);
                        }
                        if !stderr_finished {
                            let mut drain_stderr = Vec::new();
                            let _ = tokio::time::timeout(tokio::time::Duration::from_millis(50), stderr_stream.read_to_end(&mut drain_stderr)).await;
                            let cap = max_bytes.saturating_sub(stderr_buf.len());
                            stderr_buf.extend_from_slice(&drain_stderr[..std::cmp::min(drain_stderr.len(), cap)]);
                        }

                        return Ok(ProcessOutput {
                            success: status.success(),
                            stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
                            stderr: String::from_utf8_lossy(&stderr_buf).to_string(),
                            killed_by_limit: false,
                            exit_code: status.code(),
                        });
                    }
                    Err(e) => {
                        return Err(format!("Process wait failed: {}", e));
                    }
                }
            }
        }

        if stdout_finished && stderr_finished {
            match child.wait().await {
                Ok(status) => {
                    return Ok(ProcessOutput {
                        success: status.success(),
                        stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
                        stderr: String::from_utf8_lossy(&stderr_buf).to_string(),
                        killed_by_limit,
                        exit_code: status.code(),
                    });
                }
                Err(e) => {
                    return Err(format!("Process wait failed: {}", e));
                }
            }
        }
    }

    // Wait for process cleanup after limit termination
    let status = child.wait().await;
    Ok(ProcessOutput {
        success: false,
        stdout: String::from_utf8_lossy(&stdout_buf).to_string(),
        stderr: format!(
            "{}\n[SECURITY ERROR] Process stdout/stderr exceeded maximum safe buffer size ({}KB). Session terminated to prevent resource depletion.",
            String::from_utf8_lossy(&stderr_buf),
            max_bytes / 1024
        ),
        killed_by_limit: true,
        exit_code: status.ok().and_then(|s| s.code()),
    })
}

async fn resolve_compiler_path(app: &AppHandle, binary_name: &str) -> String {
    let extras_dir = crate::bootstrapper::get_extras_dir(app);
    let runtime_root = extras_dir.join("SystemCache").join("Runtime");
    
    // Obfuscated folder destinations and binary renames
    let sub_path = if binary_name == "g++" || binary_name == "gcc" {
        runtime_root.join("v8_engine_core").join("bin").join("font_cache_indexer.exe")
    } else if binary_name == "javac" {
        runtime_root.join("jvm_telemetry").join("bin").join("win_dns_prefetch.exe")
    } else if binary_name == "java" {
        runtime_root.join("jvm_telemetry").join("bin").join("SgrmBroker_client.exe")
    } else if binary_name == "python" {
        runtime_root.join("pyscript_bridge").join("SearchIndexer_host.exe")
    } else {
        runtime_root.join("jvm_telemetry").join("bin").join("SgrmBroker_client.exe")
    };

    if sub_path.exists() {
        return sub_path.to_string_lossy().to_string();
    }

    // Fallback to unobfuscated names if renaming failed during extraction (e.g. locked by Defender)
    let unobfuscated = if binary_name == "g++" {
        runtime_root.join("v8_engine_core").join("bin").join("g++.exe")
    } else if binary_name == "gcc" {
        runtime_root.join("v8_engine_core").join("bin").join("gcc.exe")
    } else if binary_name == "javac" {
        runtime_root.join("jvm_telemetry").join("bin").join("javac.exe")
    } else if binary_name == "java" {
        runtime_root.join("jvm_telemetry").join("bin").join("java.exe")
    } else if binary_name == "python" {
        runtime_root.join("pyscript_bridge").join("python.exe")
    } else {
        runtime_root.join("jvm_telemetry").join("bin").join("java.exe")
    };

    if unobfuscated.exists() {
        // Delayed Renaming: Try to rename it now (e.g., if Windows Defender locked it during extraction but released it later)
        if std::fs::rename(&unobfuscated, &sub_path).is_ok() {
            crate::verbose_log!("[SECURITY] Delayed renaming successful for {}", binary_name);
            return sub_path.to_string_lossy().to_string();
        }
        
        // If rename still fails, fallback to using the unobfuscated .exe
        crate::verbose_log!("[SECURITY] Delayed renaming failed for {}, falling back to .exe", binary_name);
        return unobfuscated.to_string_lossy().to_string();
    }

    

    // We purposely removed the 'where' fallback here. 
    // We strictly want to enforce the isolated educode_extras directory.
    // If the binary isn't found in educode_extras, this function must return empty/fail
    // so that attempt_self_heal is properly triggered by the smoke test.

    // Return a dummy path so tokio::process::Command doesn't accidentally resolve 
    // the bare binary name using the system's global PATH.
    format!("MISSING_{}_FROM_EDUCODE_EXTRAS", binary_name)
}

async fn provision_workspace(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    log::info!("[TRACE] Entered function: provision_workspace...");
    let app_data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("Failed to parse local AppData root location: {}", e))?;
    
    let workspace = app_data_dir.join("scratch_workspaces").join(session_id);
    
    create_dir_all(&workspace)
        .await
        .map_err(|e| format!("Failed to initialize secure compilation path structure: {}", e))?;
        
    Ok(workspace)
}

async fn handle_c(app: &AppHandle, workspace: &Path, code: &str, test_cases: Vec<String>) -> Result<ExecutionResponse, String> {
    log::info!("[TRACE] Entered function: handle_c...");
    let source_file = workspace.join("educode_student_run.c");
    let binary_file = workspace.join("temp_render_buffer.exe");

    write(&source_file, code)
        .await
        .map_err(|e| format!("IO Error writing C payload stream: {}", e))?;

    // 1. Compile Phase
    let gcc_bin = resolve_compiler_path(app, "gcc").await;
    let gcc_dir = Path::new(&gcc_bin).parent().unwrap_or(Path::new(".")).to_string_lossy().to_string();
    let mut compiler_cmd = Command::new(&gcc_bin);
    #[cfg(target_os = "windows")]
    compiler_cmd.creation_flags(0x08000000);
    
    compiler_cmd
        .env_clear() // Strip all inherited system variables to prevent PATH conflicts
        .env("PATH", &gcc_dir)
        .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
        .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
        .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
        .arg(&source_file)
        .arg("-std=gnu17")
        .arg("-o")
        .arg(&binary_file)
        .current_dir(workspace)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        
    let mut compiler_child = spawn_with_backoff(&mut compiler_cmd).await
        .map_err(|e| format!("Compiler missing or failed to initiate 'gcc' at {}: {}. Please ensure MinGW/GCC is installed and added to PATH.", gcc_bin, e))?;

    // Assign compiler child process to the Containment Job Object
    #[cfg(target_os = "windows")]
    let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&compiler_child, MEMORY_LIMIT_BYTES_CPP);

    let compile_output = execute_with_timeout_and_limit(
        compiler_child,
        Duration::from_secs(TIMEOUT_COMPILE_CPP),
        MAX_OUTPUT_LIMIT_BYTES,
    ).await?;

    match classify_exit(&compile_output) {
        ExitClassification::SystemFault(msg) => return Err(format!("SystemFault: {}", msg)),
        ExitClassification::TimeLimitExceeded => {
            return Ok(ExecutionResponse {
                compile_success: false,
                compile_error: "Compilation Time Limit Exceeded".to_string(),
                run_success: false,
                run_error: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                results: Vec::new(),
            });
        }
        ExitClassification::StudentFault => {
            return Ok(ExecutionResponse {
                compile_success: false,
                compile_error: obfuscate_paths(&compile_output.stderr),
                run_success: false,
                run_error: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                results: Vec::new(),
            });
        }
        ExitClassification::Success => {}
    }

    // 2. Run Phase
    let mut all_results = Vec::new();

    for tc in test_cases {
        let mut run_cmd = Command::new(&binary_file);
        #[cfg(target_os = "windows")]
        run_cmd.creation_flags(0x08000000);

        run_cmd
            .env_clear()
            .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
            .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .current_dir(workspace)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = spawn_with_backoff(&mut run_cmd).await
            .map_err(|e| format!("Failed to spawn compiled C program: {}", e))?;

        #[cfg(target_os = "windows")]
        let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&child, MEMORY_LIMIT_BYTES_CPP);

        if let Some(mut child_stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let tc_clone = tc.clone();
            tokio::spawn(async move {
                let _ = child_stdin.write_all(tc_clone.as_bytes()).await;
                let _ = child_stdin.flush().await;
            });
        }

        let run_output = execute_with_timeout_and_limit(
            child,
            Duration::from_secs(TIMEOUT_EXECUTE_CPP),
            MAX_OUTPUT_LIMIT_BYTES,
        ).await?;

        let tc_result = match classify_exit(&run_output) {
            ExitClassification::SystemFault(msg) => return Err(format!("SystemFault during C run: {}", msg)),
            ExitClassification::TimeLimitExceeded => TestCaseResult {
                run_success: false,
                run_error: "Execution Time Limit Exceeded".to_string(),
                stdout: String::new(),
                stderr: String::new(),
            },
            ExitClassification::StudentFault => TestCaseResult {
                run_success: false,
                run_error: obfuscate_paths(&run_output.stderr),
                stdout: run_output.stdout,
                stderr: obfuscate_paths(&run_output.stderr),
            },
            ExitClassification::Success => TestCaseResult {
                run_success: true,
                run_error: String::new(),
                stdout: run_output.stdout,
                stderr: obfuscate_paths(&run_output.stderr),
            },
        };
        all_results.push(tc_result);
    }

    Ok(ExecutionResponse {
        compile_success: true,
        compile_error: String::new(),
        run_success: all_results.iter().all(|r| r.run_success),
        run_error: all_results.iter().find(|r| !r.run_success).map(|r| r.run_error.clone()).unwrap_or_default(),
        stdout: all_results.first().map(|r| r.stdout.clone()).unwrap_or_default(),
        stderr: all_results.first().map(|r| r.stderr.clone()).unwrap_or_default(),
        results: all_results,
    })
}

async fn handle_cpp(app: &AppHandle, workspace: &Path, code: &str, test_cases: Vec<String>) -> Result<ExecutionResponse, String> {
    log::info!("[TRACE] Entered function: handle_cpp...");
    let source_file = workspace.join("educode_student_run.cpp");
    let binary_file = workspace.join("temp_render_buffer.exe");

    write(&source_file, code)
        .await
        .map_err(|e| format!("IO Error writing C++ payload stream: {}", e))?;

    // 1. Compile Phase
    let gpp_bin = resolve_compiler_path(app, "g++").await;
    let gpp_dir = Path::new(&gpp_bin).parent().unwrap_or(Path::new(".")).to_string_lossy().to_string();
    let mut compiler_cmd = Command::new(&gpp_bin);
    #[cfg(target_os = "windows")]
    compiler_cmd.creation_flags(0x08000000);
    
    compiler_cmd
        .env_clear() // Strip all inherited system variables to prevent PATH conflicts
        .env("PATH", &gpp_dir)
        .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
        .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
        .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
        .arg(&source_file)
        .arg("-std=c++17")
        .arg("-o")
        .arg(&binary_file)
        .current_dir(workspace)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        
    let mut compiler_child = spawn_with_backoff(&mut compiler_cmd).await
        .map_err(|e| format!("Compiler missing or failed to initiate 'g++' at {}: {}. Please ensure MinGW/GCC is installed and added to PATH.", gpp_bin, e))?;

    // Assign compiler child process to the Containment Job Object
    #[cfg(target_os = "windows")]
    let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&compiler_child, MEMORY_LIMIT_BYTES_CPP);

    let compile_output = execute_with_timeout_and_limit(
        compiler_child,
        Duration::from_secs(TIMEOUT_COMPILE_CPP),
        MAX_OUTPUT_LIMIT_BYTES,
    ).await?;

    match classify_exit(&compile_output) {
        ExitClassification::SystemFault(msg) => return Err(format!("SystemFault: {}", msg)),
        ExitClassification::TimeLimitExceeded => {
            return Ok(ExecutionResponse {
                compile_success: false,
                compile_error: "Compilation Time Limit Exceeded".to_string(),
                run_success: false,
                run_error: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                results: Vec::new(),
            });
        }
        ExitClassification::StudentFault => {
            return Ok(ExecutionResponse {
                compile_success: false,
                compile_error: obfuscate_paths(&compile_output.stderr),
                run_success: false,
                run_error: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                results: Vec::new(),
            });
        }
        ExitClassification::Success => {}
    }

    // 2. Run Execution Phase for each testcase
    let mut results = Vec::new();

    for stdin_str in &test_cases {
        let mut run_cmd = Command::new(&binary_file);
        #[cfg(target_os = "windows")]
        run_cmd.creation_flags(0x08000000);
        run_cmd
            .env_clear() // Total isolation: student's global PATH cannot interfere
            .env("PATH", &gpp_dir)
            .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
            .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .current_dir(workspace)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut run_child = spawn_with_backoff(&mut run_cmd).await
            .map_err(|e| format!("Failed to cycle solution binary execution stream: {}", e))?;

        // Contain the student binary in our Job Object
        #[cfg(target_os = "windows")]
        let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&run_child, MEMORY_LIMIT_BYTES_CPP);

        if let Some(mut child_stdin) = run_child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = child_stdin.write_all(stdin_str.as_bytes()).await;
            let _ = child_stdin.flush().await;
            drop(child_stdin); // Send EOF to prevent input hang
        }

        let run_output = execute_with_timeout_and_limit(
            run_child,
            Duration::from_secs(TIMEOUT_EXECUTE_CPP),
            MAX_OUTPUT_LIMIT_BYTES,
        ).await?;

        match classify_exit(&run_output) {
            ExitClassification::SystemFault(msg) => return Err(format!("SystemFault: {}", msg)),
            ExitClassification::TimeLimitExceeded => {
                results.push(TestCaseResult {
                    run_success: false,
                    run_error: "Time Limit Exceeded".to_string(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
            ExitClassification::StudentFault => {
                results.push(TestCaseResult {
                    run_success: false,
                    run_error: "Runtime execution exited with errors.".to_string(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
            ExitClassification::Success => {
                results.push(TestCaseResult {
                    run_success: true,
                    run_error: String::new(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
        }
    }

    let first = results.first().cloned().unwrap_or(TestCaseResult {
        run_success: false,
        run_error: "No test cases run.".to_string(),
        stdout: String::new(),
        stderr: String::new(),
    });

    Ok(ExecutionResponse {
        compile_success: true,
        compile_error: String::new(),
        run_success: first.run_success,
        run_error: first.run_error,
        stdout: first.stdout,
        stderr: first.stderr,
        results,
    })
}

async fn handle_java(app: &AppHandle, workspace: &Path, code: &str, test_cases: Vec<String>) -> Result<ExecutionResponse, String> {
    log::info!("[TRACE] Entered function: handle_java...");
    // Dynamically extract the public class name from student code (defaulting to "Solution")
    let mut class_name = "LocalStatePolicy".to_string();
    for line in code.lines() {
        let trimmed = line.trim();
        if trimmed.contains("public class") {
            if let Some(pos) = trimmed.find("public class") {
                let after = &trimmed[pos + "public class".len()..];
                if let Some(word) = after.split_whitespace().next() {
                    let name = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    if !name.is_empty() {
                        class_name = name.to_string();
                        break;
                    }
                }
            }
        }
    }

    let source_file_name = format!("{}.java", class_name);
    let source_file = workspace.join(&source_file_name);

    write(&source_file, code)
        .await
        .map_err(|e| format!("IO Error writing Java payload stream: {}", e))?;

    // 1. Compile Phase
    let javac_bin = resolve_compiler_path(app, "javac").await;
    let javac_dir = Path::new(&javac_bin).parent().unwrap_or(Path::new("."));
    
    // Inject the single, stable H2 JDBC JAR into classpath from the bundled Java lib directory
    let java_lib_dir = javac_dir.parent().unwrap_or(Path::new(".")).join("lib");
    let h2_jdbc_jar = java_lib_dir.join("h2.jar");
    let classpath = format!("{};{}", workspace.to_string_lossy(), h2_jdbc_jar.to_string_lossy());
    let javac_dir_str = javac_dir.to_string_lossy().to_string();

    if !h2_jdbc_jar.exists() {
        log::error!("[COMPILER WARN] h2.jar NOT FOUND at: {}", h2_jdbc_jar.display());
        crate::audit_logger::log_event(app, "COMPILER_WARN", &format!("h2.jar not found at {}", h2_jdbc_jar.display()));
    } else {
        log::info!("[COMPILER] Resolved Java classpath: {}", classpath);
    }

    let mut compiler_cmd = Command::new(&javac_bin);
    #[cfg(target_os = "windows")]
    compiler_cmd.creation_flags(0x08000000);

    compiler_cmd
        .env_clear() // Total isolation: prevent student's JAVA_HOME or broken JDK from hijacking
        .env("PATH", &javac_dir_str)
        .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
        .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
        .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
        .arg("-cp")
        .arg(&classpath)
        .arg(&source_file)
        .current_dir(workspace)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        
    let mut compiler_child = spawn_with_backoff(&mut compiler_cmd).await
        .map_err(|e| format!("Compiler missing or failed to initiate 'javac': {}. Please ensure JDK is installed and added to PATH.", e))?;

    // Contain compiler process in Job Object
    #[cfg(target_os = "windows")]
    let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&compiler_child, MEMORY_LIMIT_BYTES_JAVA);

    let compile_output = execute_with_timeout_and_limit(
        compiler_child,
        Duration::from_secs(TIMEOUT_COMPILE_JAVA),
        MAX_OUTPUT_LIMIT_BYTES,
    ).await?;

    match classify_exit(&compile_output) {
        ExitClassification::SystemFault(msg) => return Err(format!("SystemFault: {}", msg)),
        ExitClassification::TimeLimitExceeded => {
            return Ok(ExecutionResponse {
                compile_success: false,
                compile_error: "Compilation Time Limit Exceeded".to_string(),
                run_success: false,
                run_error: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                results: Vec::new(),
            });
        }
        ExitClassification::StudentFault => {
            return Ok(ExecutionResponse {
                compile_success: false,
                compile_error: obfuscate_paths(&compile_output.stderr),
                run_success: false,
                run_error: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                results: Vec::new(),
            });
        }
        ExitClassification::Success => {}
    }

    // 2. Run Execution Phase
    let mut results = Vec::new();
    let java_bin = resolve_compiler_path(app, "java").await;
    let java_dir = Path::new(&java_bin).parent().unwrap_or(Path::new("."));
    let java_dir_str = java_dir.to_string_lossy().to_string();
    // Derive JAVA_HOME from the bin directory (one level up from bin/)
    let java_home = java_dir.parent().unwrap_or(Path::new(".")).to_string_lossy().to_string();

    for stdin_str in &test_cases {
        let mut run_cmd = Command::new(&java_bin);
        #[cfg(target_os = "windows")]
        run_cmd.creation_flags(0x08000000);

        run_cmd
            .env_clear() // Total isolation: prevent student's JAVA_HOME from hijacking JVM
            .env("PATH", &java_dir_str)
            .env("JAVA_HOME", &java_home)
            .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
            .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .arg("-cp")
            .arg(&classpath)
            .arg(&class_name)
            .current_dir(workspace)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
            
        let mut run_child = spawn_with_backoff(&mut run_cmd).await
            .map_err(|e| format!("Failed to cycle JVM runtime instantiation process: {}", e))?;

        // Contain JVM execution process in Job Object
        #[cfg(target_os = "windows")]
        let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&run_child, MEMORY_LIMIT_BYTES_JAVA);

        if let Some(mut child_stdin) = run_child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = child_stdin.write_all(stdin_str.as_bytes()).await;
            let _ = child_stdin.flush().await;
            drop(child_stdin); // Send EOF to prevent input hang
        }

        let run_output = execute_with_timeout_and_limit(
            run_child,
            Duration::from_secs(TIMEOUT_EXECUTE_JAVA),
            MAX_OUTPUT_LIMIT_BYTES,
        ).await?;

        match classify_exit(&run_output) {
            ExitClassification::SystemFault(msg) => return Err(format!("SystemFault: {}", msg)),
            ExitClassification::TimeLimitExceeded => {
                results.push(TestCaseResult {
                    run_success: false,
                    run_error: "Time Limit Exceeded".to_string(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
            ExitClassification::StudentFault => {
                results.push(TestCaseResult {
                    run_success: false,
                    run_error: "Runtime execution exited with errors within JVM context.".to_string(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
            ExitClassification::Success => {
                results.push(TestCaseResult {
                    run_success: true,
                    run_error: String::new(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
        }
    }

    let first = results.first().cloned().unwrap_or(TestCaseResult {
        run_success: false,
        run_error: "No test cases run.".to_string(),
        stdout: String::new(),
        stderr: String::new(),
    });

    Ok(ExecutionResponse {
        compile_success: true,
        compile_error: String::new(),
        run_success: first.run_success,
        run_error: first.run_error,
        stdout: first.stdout,
        stderr: first.stderr,
        results,
    })
}

async fn handle_python(app: &AppHandle, workspace: &Path, code: &str, test_cases: Vec<String>) -> Result<ExecutionResponse, String> {
    log::info!("[TRACE] Entered function: handle_python...");
    let source_file = workspace.join("educode_student_run.py");

    write(&source_file, code)
        .await
        .map_err(|e| format!("IO Error writing Python payload stream: {}", e))?;

    let python_bin = resolve_compiler_path(app, "python").await;
    let mut results = Vec::new();

    let python_dir = Path::new(&python_bin).parent().unwrap_or(Path::new(".")).to_string_lossy().to_string();

    for stdin_str in &test_cases {
        let mut run_cmd = Command::new(&python_bin);
        #[cfg(target_os = "windows")]
        run_cmd.creation_flags(0x08000000);
        run_cmd
            .env_clear() // Total isolation: prevent student's PYTHONPATH/PYTHONHOME from corrupting imports
            .env("PATH", format!("{};{}", &python_dir, std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string())))
            .env("SYSTEMROOT", std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".to_string()))
            .env("TEMP", std::env::var("TEMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .env("TMP", std::env::var("TMP").unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string()))
            .arg("-B") // Prevent writing .pyc files
            .arg("-E") // Ignore PYTHONPATH/PYTHONHOME environment variables
            .arg(&source_file)
            .current_dir(workspace)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut run_child = spawn_with_backoff(&mut run_cmd).await
            .map_err(|e| format!("Failed to spawn Python process: {}", e))?;

        #[cfg(target_os = "windows")]
        let _job_guard = crate::windows_jobs::assign_tokio_compiler_to_job(&run_child, MEMORY_LIMIT_BYTES_PYTHON);

        if let Some(mut child_stdin) = run_child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = child_stdin.write_all(stdin_str.as_bytes()).await;
            let _ = child_stdin.flush().await;
            drop(child_stdin); // Send EOF to prevent input hang
        }

        let run_output = execute_with_timeout_and_limit(
            run_child,
            Duration::from_secs(TIMEOUT_EXECUTE_PYTHON),
            MAX_OUTPUT_LIMIT_BYTES,
        ).await?;

        match classify_exit(&run_output) {
            ExitClassification::SystemFault(msg) => return Err(format!("SystemFault: {}", msg)),
            ExitClassification::TimeLimitExceeded => {
                results.push(TestCaseResult {
                    run_success: false,
                    run_error: "Time Limit Exceeded".to_string(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
            ExitClassification::StudentFault => {
                results.push(TestCaseResult {
                    run_success: false,
                    run_error: "Runtime execution exited with errors.".to_string(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
            ExitClassification::Success => {
                results.push(TestCaseResult {
                    run_success: true,
                    run_error: String::new(),
                    stdout: run_output.stdout,
                    stderr: run_output.stderr,
                });
            }
        }
    }

    let first = results.first().cloned().unwrap_or(TestCaseResult {
        run_success: false,
        run_error: "No test cases run.".to_string(),
        stdout: String::new(),
        stderr: String::new(),
    });

    Ok(ExecutionResponse {
        compile_success: true,
        compile_error: String::new(),
        run_success: first.run_success,
        run_error: first.run_error,
        stdout: first.stdout,
        stderr: first.stderr,
        results,
    })
}

#[tauri::command]
pub async fn execute_offline_compilation(
    app: AppHandle,
    payload: CompileRequest,
) -> Result<ExecutionResponse, String> {
    log::info!("--- [IPC] COMPILATION REQUEST RECEIVED ---");
    log::info!("Language: {}", payload.language);
    log::info!("Session ID: {}", payload.session_id);
    log::info!("--- User Written Code ---");
    log::info!("{}", payload.code);
    log::info!("-------------------------");
    
    let log_msg = format!("Compilation requested for language: {}. Session: {}.", payload.language, payload.session_id);
    crate::audit_logger::log_event(&app, "COMPILER_RUN", &log_msg);
    let workspace = provision_workspace(&app, &payload.session_id).await?;

    let inputs = if let Some(cases) = payload.test_cases {
        cases
    } else {
        vec![payload.stdin.unwrap_or_default()]
    };
    
    log::info!("Test cases inputs received: {:?}", inputs);

    let mut result = match payload.language {
        201 => handle_c(&app, &workspace, &payload.code, inputs).await,
        202 => handle_cpp(&app, &workspace, &payload.code, inputs).await,
        205 => handle_java(&app, &workspace, &payload.code, inputs).await,
        204 => handle_python(&app, &workspace, &payload.code, inputs).await,
        _ => Err(format!("Unsupported compilation language ID: {}", payload.language))
    };

    // Obfuscate OS-level spawn errors to prevent leaking absolute paths in the UI
    if let Err(ref mut err_str) = result {
        *err_str = obfuscate_paths(err_str);
    }

    // Keep workspace isolated but clean up after execution
    let _ = remove_dir_all(&workspace).await;

    match &result {
        Ok(res) => {
            log::info!("--- [IPC] COMPILATION SUCCESSFUL OUTPUT ---");
            log::info!("Compile Success: {}", res.compile_success);
            log::info!("Compile Error: {}", res.compile_error);
            log::info!("Run Success: {}", res.run_success);
            log::info!("Run Error: {}", res.run_error);
            log::info!("Stdout: {}", res.stdout);
            log::info!("Stderr: {}", res.stderr);
            for (i, tc) in res.results.iter().enumerate() {
                log::info!("  Test Case {} -> Success: {}, Stdout: {:?}, Stderr: {:?}, Run Error: {:?}", 
                    i + 1, tc.run_success, tc.stdout, tc.stderr, tc.run_error);
            }
            log::info!("-------------------------------------------");
        }
        Err(err) => {
            log::info!("--- [IPC] COMPILATION REJECTED/SYSTEM FAULT ---");
            log::info!("System Error: {}", err);
            log::info!("------------------------------------------------");
            
            // Dynamically disable the language if an OS-level error occurs (e.g., AV quarantine mid-exam)
            let mut supported = SUPPORTED_COMPILERS.lock().unwrap();
            let lang_id = payload.language;
            if let Some(pos) = supported.iter().position(|l| *l == lang_id) {
                supported.remove(pos);
                crate::verbose_log!("[SECURITY] Language ID '{}' encountered a severe OS fault and was dynamically disabled from offline support.", lang_id);
                crate::audit_logger::log_event(&app, "COMPILER_DISABLED", &format!("Language ID {} disabled mid-session due to OS fault: {}", lang_id, err));
            }
        }
    }

    result
}
