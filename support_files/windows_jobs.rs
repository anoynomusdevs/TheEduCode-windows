// src-tauri/src/windows_jobs.rs
// Windows Job Object primitives for process tree containment

#[cfg(target_os = "windows")]
pub struct JobObjectGuard {
    handle: *mut winapi::ctypes::c_void,
}

#[cfg(target_os = "windows")]
impl Drop for JobObjectGuard {
    fn drop(&mut self) {
        // SAFETY: self.handle is guaranteed to be a valid handle owned by this guard. Closing it is safe.
        unsafe {
            winapi::um::handleapi::CloseHandle(self.handle);
        }
    }
}

// Ensure it's Send + Sync so Tokio doesn't complain if held across await points.
// SAFETY: The handle wrapped by JobObjectGuard is an OS handle that is thread-safe to move and share across threads.
#[cfg(target_os = "windows")]
unsafe impl Send for JobObjectGuard {}
// SAFETY: The underlying OS handle can be safely accessed concurrently.
#[cfg(target_os = "windows")]
unsafe impl Sync for JobObjectGuard {}

#[cfg(not(target_os = "windows"))]
pub struct JobObjectGuard {}

#[cfg(target_os = "windows")]
pub fn init_compiler_job() {
    crate::verbose_log!("[TRACE-ENTER] init_compiler_job (deprecated - now dynamic)");
}

#[cfg(not(target_os = "windows"))]
pub fn init_compiler_job() {
    crate::verbose_log!("[TRACE-ENTER] init_compiler_job");
}

#[cfg(target_os = "windows")]
pub fn assign_tokio_compiler_to_job(child: &tokio::process::Child, memory_limit_bytes: usize) -> Option<JobObjectGuard> {
    crate::verbose_log!("[TRACE-ENTER] assign_tokio_compiler_to_job with limit {} bytes", memory_limit_bytes);
    use std::os::windows::io::AsRawHandle;
    use winapi::um::jobapi2::*;
    use winapi::um::winnt::*;

    // SAFETY: FFI calls to Job Object API are safe because we pass valid pointers and sizes for the structs.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if !job.is_null() {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = 
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | 
                JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
                JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            
            info.ProcessMemoryLimit = memory_limit_bytes;
            
            let res = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            
            if res != 0 {
                if let Some(raw_handle) = child.raw_handle() {
                    let assign_res = AssignProcessToJobObject(job, raw_handle as *mut _);
                    if assign_res != 0 {
                        return Some(JobObjectGuard { handle: job });
                    } else {
                        winapi::um::handleapi::CloseHandle(job);
                    }
                } else {
                    winapi::um::handleapi::CloseHandle(job);
                }
            } else {
                winapi::um::handleapi::CloseHandle(job);
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub fn assign_tokio_compiler_to_job(_child: &tokio::process::Child, _memory_limit_bytes: usize) -> Option<JobObjectGuard> {
    crate::verbose_log!("[TRACE-ENTER] assign_tokio_compiler_to_job (non-Windows)");
    Some(JobObjectGuard {})
}

#[cfg(target_os = "windows")]
pub fn assign_compiler_to_job(child: &std::process::Child, memory_limit_bytes: usize) -> Option<JobObjectGuard> {
    crate::verbose_log!("[TRACE-ENTER] assign_compiler_to_job with limit {} bytes", memory_limit_bytes);
    use std::os::windows::io::AsRawHandle;
    use winapi::um::jobapi2::*;
    use winapi::um::winnt::*;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if !job.is_null() {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = 
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | 
                JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
                JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            
            info.ProcessMemoryLimit = memory_limit_bytes;
            
            let res = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            
            if res != 0 {
                let child_handle = child.as_raw_handle();
                let assign_res = AssignProcessToJobObject(job, child_handle as *mut _);
                if assign_res != 0 {
                    return Some(JobObjectGuard { handle: job });
                } else {
                    winapi::um::handleapi::CloseHandle(job);
                }
            } else {
                winapi::um::handleapi::CloseHandle(job);
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub fn assign_compiler_to_job(_child: &std::process::Child, _memory_limit_bytes: usize) -> Option<JobObjectGuard> {
    crate::verbose_log!("[TRACE-ENTER] assign_compiler_to_job (non-Windows)");
    Some(JobObjectGuard {})
}
