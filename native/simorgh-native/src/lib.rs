//! simorgh-native — optional native acceleration modules for the Simorgh gateway.
//!
//! The engine (`@simorgh/phoenix-core`) stays TypeScript and runtime-agnostic; this
//! crate is never linked into it. A host loads these modules behind a port when the
//! host can (Node via cdylib/FFI, Workers via the Wasm artifact, Go via cgo) and
//! silently keeps the TypeScript implementation when it cannot. See
//! `docs/adr/ADR-0010-native-module-policy.md`.

pub mod shield;

pub use shield::{
    mark_untrusted, sanitize_model_output, SanitizedModelOutput, MAX_MODEL_OUTPUT_CHARS,
    UNTRUSTED_CLOSE, UNTRUSTED_OPEN,
};

// ── C ABI: the FFI surface ────────────────────────────────────────────────────
//
// The CLI is the zero-dependency integration seam; this C ABI is the in-process one.
// A host that can load a cdylib (Node via ffi, Go via cgo) calls these directly; a
// host that cannot keeps using the CLI or the TypeScript implementation. The functions
// are deliberately allocation-free on the host side: the caller provides the output
// buffer and receives the required length, so a host can size its buffer once and
// reuse it.
//
// All pointers are caller-owned; the module never retains them. `out_cap` is the
// capacity of `out` in bytes. The return value is the number of UTF-8 bytes the
// sanitized text needs, excluding the NUL terminator. If it exceeds `out_cap`, the
// call wrote nothing and the caller retries with a larger buffer — the classic
// two-call sizing pattern.

/// ABI version: bump when the signatures below change.
#[no_mangle]
pub extern "C" fn simorgh_native_abi_version() -> u32 {
    1
}

/// The cap this module enforces, in UTF-16 code units (mirrors the TS constant).
#[no_mangle]
pub extern "C" fn simorgh_native_max_output_chars() -> usize {
    MAX_MODEL_OUTPUT_CHARS
}

// The findings handoff: one in-flight sanitize call per thread. A host needing
// concurrency uses one thread per call (documented contract, not a lock).
thread_local! {
    static LAST_FINDINGS: std::cell::RefCell<String> =
        std::cell::RefCell::new("[]".to_string());
}

/// Sanitize `input[..input_len]` (UTF-8) into `out` (capacity `out_cap`).
///
/// Returns the required UTF-8 byte length excluding the NUL terminator. Writes a
/// NUL-terminated result when it fits; writes nothing and returns the needed length
/// when it does not. Findings are retrieved separately with
/// `simorgh_native_last_findings_json` — the two-call split keeps the hot path a
/// single memcpy-shaped call.
///
/// # Safety
/// `input` must point to `input_len` readable bytes, `out` to `out_cap` writable
/// bytes. Pointers must be non-null when their lengths/capacities are non-zero.
#[no_mangle]
pub unsafe extern "C" fn simorgh_native_shield_sanitize(
    input: *const u8,
    input_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> usize {
    if input.is_null() || (out.is_null() && out_cap > 0) {
        return usize::MAX;
    }
    let text = match std::str::from_utf8(std::slice::from_raw_parts(input, input_len)) {
        Ok(t) => t,
        Err(_) => return usize::MAX,
    };
    let result = shield::sanitize_model_output(text);
    let bytes = result.text.as_bytes();
    let needed = bytes.len();
    let findings_json = format!(
        "[{}]",
        result
            .findings
            .iter()
            .map(|f| format!("\"{}\"", f.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(",")
    );
    LAST_FINDINGS.with(|cell| *cell.borrow_mut() = findings_json);

    if needed + 1 <= out_cap {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, needed);
        *out.add(needed) = 0;
    }
    needed
}

/// The findings JSON from the most recent `simorgh_native_shield_sanitize` on this
/// thread, e.g. `["control_characters","tag:script"]`.
///
/// # Safety
/// `out` must point to `out_cap` writable bytes. Returns the needed length; writes a
/// NUL-terminated copy when it fits.
#[no_mangle]
pub unsafe extern "C" fn simorgh_native_last_findings_json(out: *mut u8, out_cap: usize) -> usize {
    LAST_FINDINGS.with(|cell| {
        let json = cell.borrow();
        let bytes = json.as_bytes();
        let needed = bytes.len();
        if !out.is_null() && needed + 1 <= out_cap {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, needed);
            *out.add(needed) = 0;
        }
        needed
    })
}