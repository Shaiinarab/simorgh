//! `simorgh-native` — command-line surface of the native modules.
//!
//! The CLI is the integration seam a Node host uses before a cdylib/FFI binding exists:
//! `native/test/differential.mjs` drives it, and `simorgh-platform` can shell out to it
//! on hosts where loading a cdylib is not worth the complexity. Output is JSON Lines so
//! a caller can stream results without a JSON parser dependency in the hot path.
//!
//! Usage:
//!   simorgh-native sanitize --text "<string>"
//!   simorgh-native sanitize --file <path>
//!   simorgh-native sanitize --stdin
//!   simorgh-native sanitize --batch <length-prefixed-binary>   (4-byte LE length + UTF-8 per record)
//!   simorgh-native mark-untrusted --text "<string>" | --file <path> | --stdin

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::process::ExitCode;

use simorgh_native::shield::{mark_untrusted, sanitize_model_output};

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn sanitize_json(text: &str) -> String {
    let result = sanitize_model_output(text);
    let findings = result
        .findings
        .iter()
        .map(|f| format!("\"{}\"", json_escape(f)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"text\":\"{}\",\"findings\":[{}]}}",
        json_escape(&result.text),
        findings
    )
}

fn read_input(args: &[String]) -> Result<String, String> {
    let mut text: Option<String> = None;
    let mut file: Option<String> = None;
    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--text" => {
                idx += 1;
                text = args.get(idx).cloned();
            }
            "--file" => {
                idx += 1;
                file = args.get(idx).cloned();
            }
            "--stdin" => {
                let mut buf = String::new();
                io::stdin()
                    .read_to_string(&mut buf)
                    .map_err(|e| format!("failed to read stdin: {}", e))?;
                return Ok(buf);
            }
            other => return Err(format!("unknown argument: {}", other)),
        }
        idx += 1;
    }
    if let Some(path) = file {
        return fs::read_to_string(&path).map_err(|e| format!("failed to read {}: {}", path, e));
    }
    text.ok_or_else(|| "one of --text, --file, --stdin is required".to_string())
}

/// Read the batch format: repeated [u32 LE length][UTF-8 bytes] records.
fn read_batch(path: &str) -> Result<Vec<String>, String> {
    let bytes = fs::read(path).map_err(|e| format!("failed to read {}: {}", path, e))?;
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 4 <= bytes.len() {
        let len = u32::from_le_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]])
            as usize;
        pos += 4;
        if pos + len > bytes.len() {
            return Err("batch record length exceeds file".to_string());
        }
        let record = String::from_utf8(bytes[pos..pos + len].to_vec())
            .map_err(|e| format!("batch record is not UTF-8: {}", e))?;
        out.push(record);
        pos += len;
    }
    Ok(out)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(command) = args.first() else {
        eprintln!("usage: simorgh-native <sanitize|mark-untrusted> [options]");
        return ExitCode::from(2);
    };
    let rest = &args[1..];

    match command.as_str() {
        "sanitize" => {
            if rest.first().map(String::as_str) == Some("--batch") {
                let Some(path) = rest.get(1) else {
                    eprintln!("--batch requires a file path");
                    return ExitCode::from(2);
                };
                match read_batch(path) {
                    Ok(records) => {
                        let stdout = io::stdout();
                        let mut out = stdout.lock();
                        for record in &records {
                            let _ = writeln!(out, "{}", sanitize_json(record));
                        }
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("{}", err);
                        ExitCode::from(1)
                    }
                }
            } else {
                match read_input(rest) {
                    Ok(text) => {
                        println!("{}", sanitize_json(&text));
                        ExitCode::SUCCESS
                    }
                    Err(err) => {
                        eprintln!("{}", err);
                        ExitCode::from(1)
                    }
                }
            }
        }
        "mark-untrusted" => match read_input(rest) {
            Ok(text) => {
                println!("{}", json_escape(&mark_untrusted(&text)));
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!("{}", err);
                ExitCode::from(1)
            }
        },
        other => {
            eprintln!("unknown command: {}", other);
            ExitCode::from(2)
        }
    }
}