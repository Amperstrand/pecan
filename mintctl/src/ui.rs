//! Terminal output and prompting.
//!
//! Phase split: the guided wizard (cliclack) drives interactive installs; the
//! helpers here cover plain output for subcommands and the non-interactive
//! (`--yes` / no-TTY) paths. Prompts read and write /dev/tty directly, never
//! stdin — when the bootstrap streams us in via `curl | bash`, stdin is not a
//! terminal but /dev/tty still is. This is the exact bash `ask()`/`confirm()`
//! contract the installer has always had.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};

pub fn say(msg: impl AsRef<str>) {
    println!("{}", msg.as_ref());
}

pub fn note(msg: impl AsRef<str>) {
    println!("  · {}", msg.as_ref());
}

pub fn warn(msg: impl AsRef<str>) {
    eprintln!("warning: {}", msg.as_ref());
}

/// A controlling terminal we can prompt on (bash `have_tty` parity).
pub fn have_tty() -> bool {
    tty_io().is_some()
}

fn tty_io() -> Option<(BufReader<File>, File)> {
    let input = File::open("/dev/tty").ok()?;
    let output = OpenOptions::new().write(true).open("/dev/tty").ok()?;
    Some((BufReader::new(input), output))
}

fn prompt_line(prompt: &str) -> Option<String> {
    let (mut input, mut output) = tty_io()?;
    output.write_all(prompt.as_bytes()).ok()?;
    output.flush().ok()?;
    let mut line = String::new();
    input.read_line(&mut line).ok()?;
    Some(line.trim().to_string())
}

#[derive(Clone, Copy)]
pub struct Ui {
    pub assume_yes: bool,
}

impl Ui {
    pub fn new(assume_yes: bool) -> Self {
        Self { assume_yes }
    }

    /// Yes/no with NO as the unattended default: nothing is confirmable
    /// without a terminal; automation passes --yes.
    pub fn confirm(&self, question: &str) -> bool {
        if self.assume_yes {
            return true;
        }
        matches!(
            prompt_line(&format!("{question} [y/N]: ")).map(|l| l.to_ascii_lowercase()),
            Some(ref answer) if matches!(answer.as_str(), "y" | "yes")
        )
    }

    /// Typed confirmation for destructive actions (uninstall --purge).
    /// `--yes` skips it with a warning, mirroring the bash behavior.
    pub fn confirm_typed(&self, prompt: &str, expected: &str) -> bool {
        if self.assume_yes {
            warn("--yes given; skipping the typed confirmation");
            return true;
        }
        matches!(prompt_line(&format!("{prompt}: ")), Some(ref answer) if answer == expected)
    }
}
