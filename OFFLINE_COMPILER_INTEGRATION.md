# Offline Compiler Integration Guide

This document explains how to communicate with the EduCode Desktop Secure Browser's offline compiler from your frontend web application. 

The secure browser injects an API into the `window` object via Electron's context bridge. Your frontend must detect this API and send the correct payload structure to execute code locally.

## 1. Detecting the Offline Compiler
Before attempting to run code offline, you must check if the frontend is running inside the EduCode Secure Browser environment.

```javascript
async function checkOfflineSupport() {
    if (window.electronAPI && typeof window.electronAPI.getCompilerStatus === 'function') {
        const status = await window.electronAPI.getCompilerStatus();
        
        if (status.isAvailable) {
            console.log(`Offline compiler active! System RAM: ${status.totalRamGB}GB`);
            console.log(`Supported Languages: ${status.supportedLanguages.join(', ')}`);
            return true;
        } else {
            console.warn(`Offline compiler disabled. Device only has ${status.totalRamGB}GB of RAM (4GB minimum required).`);
            return false;
        }
    }
    return false;
}

const isOfflineCompilerAvailable = await checkOfflineSupport();
```

## 2. The Request Payload Pattern

To execute code, you must call `window.electronAPI.runCode(payload)`. This function returns a **Promise** that resolves with the execution results.

### Payload Structure

```javascript
const payload = {
    // 1. The code the user typed
    userWrittenCode: "print('Hello, World!')", 

    // 2. The Judge0 language ID
    // 50 = C, 54 = C++, 62 = Java, 63/93 = JavaScript, 71 = Python
    languageId: 71, 

    // 3. Test cases as an Array of Arrays: [ [input, expectedOutput], ... ]
    // IMPORTANT: It MUST be an array of arrays, not an array of objects.
    sampleInputOutput: [
        ["1 2", "3"],
        ["5 5", "10"]
    ],

    // 4. (Optional) Any additional files required by Java/Custom engines
    files: [] 
};
```

> [!WARNING]
> **Strict Formatting Required for `sampleInputOutput`**
> The backend destructures the array using `const [input, expectedOutput] = sampleInputOutput[i];`. If you send an array of objects (like `[{input: "1", output: "2"}]`), the backend will crash with a `TypeError: Cannot read properties of undefined (reading 'trim')`.

## 3. The Response Pattern

The compiler executes all test cases provided in the `sampleInputOutput` array and returns an array of result objects.

### Response Structure

The new offline compiler uses a strictly defined JSON structure aligned with the Rust engine's `ExecutionResponse`. It groups compilation and runtime success flags at the root level, and provides individual test case results in a `results` array.

```javascript
{
  "compile_success": true,        // True if code compiled successfully (always true for Python/JS)
  "compile_error": "",            // Contains stderr if compilation failed (e.g., Syntax Error)
  "run_success": false,           // True ONLY if ALL test cases passed perfectly
  "run_error": "Wrong Answer",    // The error reason for the first failed test case, or ""
  "stdout": "3",                  // Output of the first test case
  "stderr": "",                   // Stderr of the first test case
  "results": [
    {
      "run_success": true,
      "run_error": "",
      "stdout": "3",
      "stderr": ""
    },
    {
      "run_success": false,
      "run_error": "Wrong Answer",
      "stdout": "11",
      "stderr": ""
    }
  ]
}
```

> [!NOTE]
> Unlike the Judge0 format, there is no `statusId`, `time`, or `memory` field inside the test cases. You must rely on `compile_success` and `run_success` to determine the outcome.

## 4. Complete Frontend Implementation Example

Here is a drop-in example of how a "Run Code" button handler might look in your React/Vue/Vanilla frontend:

```javascript
async function handleRunCodeClick(code, langId, testCases) {
    // 1. Map your test cases to the required [[input, expectedOutput]] format
    const formattedTestCases = testCases.map(tc => [tc.input, tc.expectedOutput]);

    const payload = {
        userWrittenCode: code,
        languageId: langId,
        sampleInputOutput: formattedTestCases
    };

    try {
        if (window.electronAPI && window.electronAPI.runCode) {
            // --- OFFLINE MODE ---
            console.log("Executing via Offline Browser Engine...");
            const results = await window.electronAPI.runCode(payload);
            
            // Process results exactly as if they came from your cloud API
            processResults(results); 
        } else {
            // --- CLOUD MODE ---
            console.log("Executing via Cloud API...");
            const response = await fetch('https://api.yourbackend.com/submit', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            const results = await response.json();
            
            processResults(results);
        }
    } catch (error) {
        console.error("Execution failed:", error);
        alert("Failed to run code.");
    }
}
```
