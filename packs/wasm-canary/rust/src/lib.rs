//! The canary's line diff, for the browser. No `unsafe` here (forbidden below): strings cross into
//! JavaScript through wasm-bindgen's generated glue.

#![forbid(unsafe_code)]

use similar::{ChangeTag, TextDiff};
use wasm_bindgen::prelude::*;

/// Old against new, by line: one line out per diff line, its first character ' ' (in both), '-'
/// (only in the old text) or '+' (only in the new), then the line without its line ending.
#[wasm_bindgen]
pub fn diff(old: &str, new: &str) -> String {
    let mut out = String::new();
    for c in TextDiff::from_lines(old, new).iter_all_changes() {
        out.push(match c.tag() {
            ChangeTag::Equal => ' ',
            ChangeTag::Delete => '-',
            ChangeTag::Insert => '+',
        });
        out.push_str(c.value().trim_end_matches(['\n', '\r']));
        out.push('\n');
    }
    out
}
