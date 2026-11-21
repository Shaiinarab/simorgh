//! `native-bench` — block-amortised benchmark of the Rust output shield.
//!
//! Method mirrors `bench/native-audit/run.mjs` (docs/research/NATIVE-COMPUTE-AUDIT.md)
//! so the numbers are comparable: single-call timing is wrong on a loaded box (a 40 ns
//! timer cannot see a 40 µs preemption), so each sample is a *block* of K calls sized to
//! last ~500 µs, per-call cost is block_elapsed / K, an empty-loop baseline is measured
//! through the identical path, and three full passes report the median spread.
//!
//! Correctness runs *before* timing (a wrong shield that is fast proves nothing), and a
//! negative control confirms the assertions can fail.
//!
//! Usage: `cargo run --release --bin native-bench [--markdown]`

use std::hint::black_box;
use std::time::Instant;

use simorgh_native::shield::{sanitize_model_output, SanitizedModelOutput};

struct Sample {
    median_us: f64,
    p95_us: f64,
    n: u64,
}

/// Time `f` in blocks of K calls, each block ~500 µs, three passes; return per-call us.
fn measure<'a>(mut f: impl FnMut() -> SanitizedModelOutput<'a>) -> Sample {
    // Calibrate K so one block lands near 500 µs.
    let mut k: u64 = 1;
    loop {
        let start = Instant::now();
        for _ in 0..k {
            black_box(f());
        }
        let elapsed = start.elapsed().as_secs_f64();
        if elapsed >= 0.0005 || k >= 1_000_000 {
            break;
        }
        k *= 2;
    }
    let mut samples: Vec<f64> = Vec::new();
    let mut total_calls: u64 = 0;
    for _pass in 0..3 {
        let blocks = 20u64;
        for _ in 0..blocks {
            let start = Instant::now();
            for _ in 0..k {
                black_box(f());
            }
            let per_call_us = start.elapsed().as_secs_f64() * 1e6 / k as f64;
            samples.push(per_call_us);
            total_calls += k;
        }
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples[samples.len() / 2];
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];
    Sample {
        median_us: median,
        p95_us: p95,
        n: total_calls,
    }
}

fn measure_empty_baseline() -> f64 {
    let mut sink = 0usize;
    let sample = measure(|| {
        sink = sink.wrapping_add(1);
        SanitizedModelOutput {
            text: std::borrow::Cow::Borrowed(""),
            findings: Vec::new(),
        }
    });
    black_box(sink);
    sample.median_us
}

/// Build an answer of approximately `size` bytes: clean prose or adversarial payload.
fn build_input(size: usize, adversarial: bool) -> String {
    let unit_clean = "The quick brown fox jumps over the lazy dog. Use `Connection: keep-alive` and let the CDN cache it. ";
    let unit_adversarial =
        "<script>alert(1)</script><img src=x onerror=steal()><a href=\"javascript:alert(1)\">x</a>\u{202E}\u{E0041} ";
    let unit = if adversarial { unit_adversarial } else { unit_clean };
    unit.repeat((size / unit.len()).max(1))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Batch mode: time caller-supplied inputs (native/test/bench-node.mjs drives both
    // implementations over the SAME bytes, which is the only honest comparison).
    if let Some(pos) = args.iter().position(|a| a == "--batch") {
        let path = args.get(pos + 1).map(String::as_str).unwrap_or("");
        let bytes = std::fs::read(path).expect("read batch");
        let mut records: Vec<String> = Vec::new();
        let mut pos = 0usize;
        while pos + 4 <= bytes.len() {
            let len = u32::from_le_bytes([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]) as usize;
            pos += 4;
            records.push(String::from_utf8(bytes[pos..pos + len].to_vec()).expect("utf8 record"));
            pos += len;
        }
        let baseline_us = measure_empty_baseline();
        let mut rows: Vec<(usize, usize, Sample)> = Vec::new();
        for (i, record) in records.iter().enumerate() {
            let sample = measure(|| sanitize_model_output(black_box(record.as_str())));
            rows.push((i, record.len(), sample));
        }
        let json_rows: Vec<String> = rows
            .iter()
            .map(|(i, bytes, sample)| {
                format!(
                    "{{\"index\":{},\"bytes\":{},\"median_us\":{:.3},\"p95_us\":{:.3},\"n\":{}}}",
                    i, bytes, sample.median_us, sample.p95_us, sample.n
                )
            })
            .collect::<Vec<_>>();
        println!(
            "{{\"baseline_us\":{:.4},\"rows\":[{}]}}",
            baseline_us,
            json_rows.join(",")
        );
        return;
    }

    // ── Correctness first: the shield must actually neutralise before it is timed ──
    let mut assertions: u32 = 0;
    let mut check = |name: &str, cond: bool| {
        assertions += 1;
        assert!(cond, "correctness assertion failed: {}", name);
    };

    let dirty = sanitize_model_output("answer: <script>fetch(\"/steal\")</script> done");
    check("script tag removed", dirty.text == "answer: fetch(\"/steal\") done");
    check("script finding", dirty.findings.iter().any(|f| f == "tag:script"));

    let handler = sanitize_model_output("<img src=\"cat.png\" onerror=\"steal()\" alt=\"a cat\">");
    check(
        "event handler stripped",
        handler.text == "<img src=\"cat.png\" alt=\"a cat\">",
    );

    let js = sanitize_model_output("<a href=\"javascript:alert(1)\">x</a>");
    check(
        "javascript scheme blocked",
        js.text.contains("<a href=\"blocked:") && js.findings.iter().any(|f| f == "javascript_url"),
    );

    let teaching = "Guard with `if (u.protocol !== \"javascript:\")`.";
    check(
        "prose left byte-identical",
        sanitize_model_output(teaching).text == teaching,
    );

    let persian = "نامه‌ها و کتاب‌ها";
    check(
        "persian joining preserved",
        sanitize_model_output(persian).text == persian,
    );

    // Negative control: a deliberately wrong expectation must fail through the same
    // check() path. If this does not panic, the assertions above prove nothing. The
    // default panic hook prints to stderr before unwinding, so silence it around this
    // one intentional panic and restore it afterwards.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let negative_fired = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        check("planted", 1 == 2);
    }))
    .is_err();
    std::panic::set_hook(default_hook);
    check("negative control fired", negative_fired);
    println!(
        "correctness: {} assertions passed, negative control {}",
        assertions,
        if negative_fired { "FIRED" } else { "DID NOT FIRE" }
    );

    // ── Timing ──
    let baseline_us = measure_empty_baseline();
    println!(
        "empty-loop baseline: {:.4} µs/call (subtracted below)",
        baseline_us
    );

    let markdown = std::env::args().any(|a| a == "--markdown");
    let mut rows: Vec<(String, usize, bool, Sample, f64)> = Vec::new();
    for size in [1024usize, 4096, 16_384, 32_000, 131_072] {
        for adversarial in [false, true] {
            let input = build_input(size, adversarial);
            let sample = measure(|| sanitize_model_output(black_box(&input)));
            let net = (sample.median_us - baseline_us).max(0.0);
            rows.push((
                format!("{}B", size),
                size,
                adversarial,
                sample,
                net,
            ));
        }
    }

    if markdown {
        println!("\n| input | kind | median µs | p95 µs | net of baseline µs | N |");
        println!("|---|---|---|---|---|---|");
        for (label, _, adversarial, sample, net) in &rows {
            println!(
                "| {} | {} | {:.3} | {:.3} | {:.3} | {} |",
                label,
                if *adversarial { "adversarial" } else { "clean" },
                sample.median_us,
                sample.p95_us,
                net,
                sample.n
            );
        }
    } else {
        println!(
            "\n{:>10} {:>12} {:>10} {:>10} {:>12}",
            "input", "kind", "median µs", "p95 µs", "N"
        );
        for (label, _, adversarial, sample, _) in &rows {
            println!(
                "{:>10} {:>12} {:>10.3} {:>10.3} {:>12}",
                label,
                if *adversarial { "adversarial" } else { "clean" },
                sample.median_us,
                sample.p95_us,
                sample.n
            );
        }
    }

    // Machine line for CI consumption: JSON on the last line.
    let json_rows: Vec<String> = rows
        .iter()
        .map(|(label, size, adversarial, sample, net)| {
            format!(
                "{{\"label\":\"{}\",\"bytes\":{},\"adversarial\":{},\"median_us\":{:.3},\"p95_us\":{:.3},\"net_us\":{:.3},\"n\":{}}}",
                label, size, adversarial, sample.median_us, sample.p95_us, net, sample.n
            )
        })
        .collect::<Vec<_>>();
    println!(
        "{{\"baseline_us\":{:.4},\"rows\":[{}]}}",
        baseline_us,
        json_rows.join(",")
    );
}