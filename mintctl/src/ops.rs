//! The operations subcommands: everything except install.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use time::macros::format_description;

use crate::caddy;
use crate::compose::{self, Stack, BIN_LINK};
use crate::envfile::EnvFile;
use crate::install;
use crate::release;
use crate::ui::{self, Ui};
use crate::UpdateArgs;

fn env(stack: &Stack) -> Result<EnvFile> {
    EnvFile::load(&stack.env_path())
}

pub fn status() -> Result<()> {
    let stack = Stack::discover()?;
    let envf = env(&stack)?;
    let ui_port = envf.get("UI_PORT").unwrap_or_else(|| "9090".into());
    let version = envf.get("VERSION").unwrap_or_default();

    stack.compose(&["ps"])?;
    ui::say("");
    let health_url = format!("http://127.0.0.1:{ui_port}/healthz");
    match compose::probe_healthz(&health_url) {
        Some(running) => ui::say(format!("console: ok (version {running})")),
        None => ui::say(format!("console: not responding on 127.0.0.1:{ui_port}")),
    }
    if let Some(mint_version) = envf.get("MINT_VERSION").filter(|v| !v.is_empty()) {
        let mint_port = envf.get("MINT_PORT").unwrap_or_else(|| "3338".into());
        let mint_url = format!("http://127.0.0.1:{mint_port}/v1/info");
        if compose::wait_http_ok(&mint_url, std::time::Duration::from_secs(3)) {
            ui::say(format!("mint:    ok (cashubtc/mintd:{mint_version})"));
        } else {
            ui::say(format!(
                "mint:    not responding on 127.0.0.1:{mint_port} (cashubtc/mintd:{mint_version})"
            ));
        }
    }
    ui::say(format!(
        "installed version: {}",
        if version.is_empty() { "unknown" } else { &version }
    ));
    match release::resolve_latest_version() {
        Ok(latest) if latest != version => {
            ui::say(format!("latest release:    {latest}  → run 'mintctl update'"))
        }
        Ok(latest) => ui::say(format!("latest release:    {latest} (up to date)")),
        Err(_) => {}
    }
    Ok(())
}

pub fn logs(services: &[String]) -> Result<()> {
    let stack = Stack::discover()?;
    let mut args = vec!["logs", "-f", "--tail=200"];
    args.extend(services.iter().map(String::as_str));
    stack.compose(&args)
}

pub fn update(args: &UpdateArgs) -> Result<()> {
    let stack = Stack::discover()?;
    let mut envf = env(&stack)?;
    // Pre-0.2 installs bundled a MANAGED cdk-mintd in this compose project
    // (marker: the MINT_MODE key the old installer wrote — none of the
    // current MINT_* keys is MINT_MODE, so this cannot misfire on 0.3+
    // bundled-mint installs). The new compose file has no managed mint
    // service, so `up --remove-orphans` would take their mint container down
    // mid-update. Refuse and point at the migration note.
    if envf.get("MINT_MODE").is_some() {
        bail!(
            "this install was created by a pre-0.2 version that bundled a managed mint. \
             Since 0.2 the mint runs from its own official image (or outside the stack) — \
             updating in place would remove the old managed mint container. \
             See docs/operations.md (\"Migrating from the bundled mint\") before updating."
        );
    }
    // The bundled mint's image is pinned independently: it holds money, so a
    // pecan release never drags it along. --mint-version upgrades it
    // deliberately (with or without a processor update).
    if let Some(mint_version) = &args.mint_version {
        if envf.get("MINT_VERSION").is_none() {
            bail!("--mint-version only applies to installs with a bundled mint");
        }
        envf.set("MINT_VERSION", mint_version);
        envf.save()?;
        ui::say(format!("mint image pinned to cashubtc/mintd:{mint_version}"));
    }
    let current = envf.get("VERSION").unwrap_or_default();
    let target = match &args.version {
        Some(v) => v.clone(),
        None => release::resolve_latest_version()
            .context("could not resolve the latest release; pass --version vX.Y.Z")?,
    };
    if target == current {
        if args.mint_version.is_some() {
            // Only the mint moves: pull and restart with the new pin.
            if !args.no_pull {
                stack.compose(&["pull", "--quiet"])?;
            }
            stack.compose(&["up", "-d", "--remove-orphans"])?;
            let mint_port = envf.get("MINT_PORT").unwrap_or_else(|| "3338".into());
            if !compose::wait_http_ok(
                &format!("http://127.0.0.1:{mint_port}/v1/info"),
                Duration::from_secs(120),
            ) {
                bail!("the mint did not come back after the update — check 'mintctl logs mintd'");
            }
            ui::say("mint updated");
        } else {
            ui::say(format!("already on {current}"));
        }
        return Ok(());
    }
    ui::say(format!(
        "Updating {} → {target}",
        if current.is_empty() { "?" } else { &current }
    ));

    // Artifacts and image always move together: stage the target tag's
    // artifacts (and its mintctl binary) before switching the version.
    let source = install::artifact_source(args.artifacts_dir.clone(), args.artifact_ref.clone(), &target);
    let staging = tempfile::tempdir_in(&stack.install_dir).context("create staging dir")?;
    install::fetch_deploy_artifacts(&source, staging.path())?;
    let staged_binary = staging.path().join("mintctl");
    install::install_binary(&source, &target, &staged_binary)?;

    for artifact in ["docker-compose.yml", "Caddyfile", ".env.example"] {
        std::fs::rename(staging.path().join(artifact), stack.install_dir.join(artifact))
            .with_context(|| format!("move {artifact} into place"))?;
    }
    // Replacing the running binary via rename is safe on unix — the running
    // inode lives on until process exit.
    std::fs::rename(&staged_binary, stack.install_dir.join("mintctl"))
        .context("move mintctl into place")?;
    caddy::apply_acme_email(&stack.install_dir, &envf.get("ACME_EMAIL").unwrap_or_default())?;
    // The fresh Caddyfile artifact has no mint site block — re-apply it for
    // bundled-mint installs serving the mint through the bundled Caddy.
    let mint_site_enabled = envf
        .get("COMPOSE_PROFILES")
        .unwrap_or_default()
        .split(',')
        .any(|p| p.trim() == "mint")
        && envf
            .get("COMPOSE_PROFILES")
            .unwrap_or_default()
            .split(',')
            .any(|p| p.trim() == "tls")
        && envf.get("MINT_DOMAIN").is_some_and(|d| !d.is_empty());
    caddy::apply_mint_site(&stack.install_dir, mint_site_enabled)?;

    envf.set("VERSION", &target);
    envf.save()?;
    if !args.no_pull {
        stack.compose(&["pull", "--quiet"])?;
    }
    stack.compose(&["up", "-d", "--remove-orphans"])?;

    let ui_port: u16 = envf
        .get("UI_PORT")
        .and_then(|p| p.parse().ok())
        .unwrap_or(9090);
    if !compose::wait_healthy(ui_port, Duration::from_secs(120)) {
        bail!("the console did not come back after the update — check 'mintctl logs processor'");
    }
    if let Some(running) = compose::probe_healthz(&format!("http://127.0.0.1:{ui_port}/healthz")) {
        if !running.is_empty() && running != target {
            ui::warn(format!("console reports version {running}, expected {target}"));
        }
    }
    let _ = std::process::Command::new("docker")
        .args(["image", "prune", "-f"])
        .output();
    ui::say(format!("updated to {target}"));
    Ok(())
}

pub fn backup(output: Option<PathBuf>) -> Result<()> {
    let stack = Stack::discover()?;
    let envf = env(&stack)?;
    let out = match output {
        Some(path) => absolutize(path)?,
        None => {
            let stamp = time::OffsetDateTime::now_utc()
                .format(format_description!(
                    "[year][month][day]-[hour][minute][second]"
                ))
                .unwrap_or_default();
            absolutize(PathBuf::from(format!("pecan-backup-{stamp}.tar.gz")))?
        }
    };
    let project = envf
        .get("COMPOSE_PROJECT_NAME")
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| compose::project_name(&stack.install_dir));
    let out_dir = out.parent().context("backup path has no directory")?;
    let out_name = out
        .file_name()
        .and_then(|n| n.to_str())
        .context("backup path has no file name")?;

    let has_mint = envf
        .get("COMPOSE_PROFILES")
        .unwrap_or_default()
        .split(',')
        .any(|p| p.trim() == "mint");

    ui::say("Stopping services for a consistent snapshot ...");
    stack.compose(&["stop"])?;
    let mut cmd = std::process::Command::new("docker");
    cmd.args(["run", "--rm"])
        .args(["-v", &format!("{project}_config-data:/backup/config:ro")])
        .args(["-v", &format!("{project}_processor-data:/backup/processor:ro")])
        .args(["-v", &format!("{}:/backup/install:ro", stack.install_dir.display())])
        .args(["-v", &format!("{}:/out", out_dir.display())]);
    if has_mint {
        cmd.args(["-v", &format!("{project}_mintd-data:/backup/mint-data:ro")]);
    }
    cmd.arg("debian:bookworm-slim").args([
        "tar",
        "czf",
        &format!("/out/{out_name}"),
        "-C",
        "/backup",
        "config",
        "processor",
        "install/.env",
    ]);
    if has_mint {
        // The mint's database and its seed + config: the archive can mint
        // this install's ecash.
        cmd.args(["mint-data", "install/mint"]);
    }
    let status = cmd.status().context("run the backup container")?;
    stack.compose(&["start"])?;
    if !status.success() {
        bail!("the backup container failed");
    }
    ui::say("");
    ui::say(format!("Backup written to {}", out.display()));
    if has_mint {
        ui::say("It contains the operator accounts (password hashes), the attachment");
        ui::say("configuration, the ticket ledger, AND the mint's database and SEED —");
        ui::say("this archive can issue your ecash. Encrypt it and store it off this");
        ui::say("server.");
    } else {
        ui::say("It contains the operator accounts (password hashes), the attachment");
        ui::say("configuration, and the ticket ledger — store it encrypted, off this");
        ui::say("server. The mint's own data is NOT included; the mint is backed up");
        ui::say("by whoever operates it.");
    }
    Ok(())
}

pub fn restore(archive: PathBuf, yes: bool) -> Result<()> {
    let stack = Stack::discover()?;
    let envf = env(&stack)?;
    let ui_prompt = Ui::new(yes);
    if !archive.is_file() {
        bail!("no such file: {}", archive.display());
    }
    let archive = absolutize(archive)?;
    let project = envf
        .get("COMPOSE_PROJECT_NAME")
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| compose::project_name(&stack.install_dir));
    let archive_dir = archive.parent().context("archive path has no directory")?;
    let archive_name = archive
        .file_name()
        .and_then(|n| n.to_str())
        .context("archive path has no file name")?;
    // The file name is interpolated into a `sh -c` script inside the restore
    // container; any shell metacharacter in it is command injection
    // (CWE-78). Restrict to a conservative charset that cannot escape it.
    if !archive_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        bail!(
            "archive file name {:?} contains characters outside [A-Za-z0-9._-]; \
             rename the archive before restoring",
            archive_name
        );
    }

    // Which shape does the archive have, and does it match this install?
    let listing = std::process::Command::new("tar")
        .args(["tzf", &archive.display().to_string()])
        .output()
        .context("inspect the archive (tar tzf)")?;
    if !listing.status.success() {
        bail!("could not read {} (tar tzf failed)", archive.display());
    }
    let members = String::from_utf8_lossy(&listing.stdout);
    let archive_has_mint = members.lines().any(|l| l.starts_with("mint-data/"));
    let install_has_mint = envf
        .get("COMPOSE_PROFILES")
        .unwrap_or_default()
        .split(',')
        .any(|p| p.trim() == "mint");
    if archive_has_mint && !install_has_mint {
        bail!(
            "this archive contains a bundled mint (database + seed), but this install \
             is processor-only. Re-install with --with-mint first, then restore."
        );
    }
    if !archive_has_mint && install_has_mint {
        bail!(
            "this install bundles a mint, but the archive has no mint data — restoring \
             would leave the processor's ledger out of step with the running mint. \
             Restore it into a processor-only install, or use a bundled-mint backup."
        );
    }

    ui::say("Restoring replaces the processor's current state (attachment config,");
    ui::say(format!(
        "operator accounts, ticket ledger) of project '{project}' with the archive"
    ));
    if archive_has_mint {
        ui::say("contents, INCLUDING the mint's database and seed. (.env is not touched.)");
    } else {
        ui::say("contents. (.env is not touched; the mint is unaffected.)");
    }
    if !ui_prompt.confirm("Continue?") {
        bail!("restore cancelled");
    }
    stack.compose(&["down", "--remove-orphans"])?;
    let mut volumes = vec!["config-data", "processor-data"];
    if archive_has_mint {
        volumes.push("mintd-data");
    }
    for vol in &volumes {
        let status = std::process::Command::new("docker")
            .args(["volume", "create", &format!("{project}_{vol}")])
            .stdout(std::process::Stdio::null())
            .status()
            .context("docker volume create")?;
        if !status.success() {
            bail!("could not create volume {project}_{vol}");
        }
    }
    // Extracting named members only also accepts pre-0.2 archives, whose
    // additional mint/ directory is simply skipped. Bundled archives restore
    // the mint volume plus the install-dir mint/ files (config + seed, 0600)
    // together, so cdk's signer-fingerprint check stays consistent.
    let script = if archive_has_mint {
        format!(
            "find /restore/config /restore/processor /restore/mint-data -mindepth 1 -delete \
             && tar xzf /in/{archive_name} -C /restore config processor mint-data \
             && rm -rf /restore/install-dir/mint \
             && tar xzf /in/{archive_name} -C /restore-staging install/mint \
             && mv /restore-staging/install/mint /restore/install-dir/mint \
             && chmod 700 /restore/install-dir/mint \
             && chmod 600 /restore/install-dir/mint/*"
        )
    } else {
        format!(
            "find /restore/config /restore/processor -mindepth 1 -delete \
             && tar xzf /in/{archive_name} -C /restore config processor"
        )
    };
    let mut cmd = std::process::Command::new("docker");
    cmd.args(["run", "--rm"])
        .args(["-v", &format!("{project}_config-data:/restore/config")])
        .args(["-v", &format!("{project}_processor-data:/restore/processor")])
        .args(["-v", &format!("{}:/in:ro", archive_dir.display())]);
    if archive_has_mint {
        cmd.args(["-v", &format!("{project}_mintd-data:/restore/mint-data")])
            .args(["-v", &format!("{}:/restore/install-dir", stack.install_dir.display())])
            .args(["--tmpfs", "/restore-staging"]);
    }
    let status = cmd
        .arg("debian:bookworm-slim")
        .args(["sh", "-c", &script])
        .status()
        .context("run the restore container")?;
    if !status.success() {
        bail!("the restore container failed");
    }
    stack.compose(&["up", "-d", "--remove-orphans"])?;
    ui::say("restore complete — check 'mintctl status'");
    Ok(())
}

pub fn start() -> Result<()> {
    Stack::discover()?.compose(&["up", "-d", "--remove-orphans"])
}

pub fn stop() -> Result<()> {
    Stack::discover()?.compose(&["stop"])
}

pub fn uninstall(purge: bool, yes: bool) -> Result<()> {
    let stack = Stack::discover()?;
    let envf = env(&stack)?;
    let ui_prompt = Ui::new(yes);
    let project = envf
        .get("COMPOSE_PROJECT_NAME")
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| compose::project_name(&stack.install_dir));

    if purge {
        let has_mint = envf
            .get("COMPOSE_PROFILES")
            .unwrap_or_default()
            .split(',')
            .any(|p| p.trim() == "mint");
        ui::say("PURGE deletes the containers, ALL VOLUMES (operator accounts,");
        if has_mint {
            ui::say("attachment config, the ticket ledger, the mint's database and its");
            ui::say(format!(
                "SEED in {}/mint), and the directory itself. This cannot",
                stack.install_dir.display()
            ));
            ui::say("be undone — without a backup, the mint's issued ecash dies with it.");
        } else {
            ui::say(format!(
                "attachment config, the ticket ledger), and {}. This cannot be undone.",
                stack.install_dir.display()
            ));
        }
        if !ui_prompt.confirm_typed(
            &format!("Type the project name ({project}) to confirm"),
            &project,
        ) {
            bail!("confirmation did not match; nothing was deleted");
        }
        stack.compose(&["down", "-v", "--remove-orphans"])?;
        remove_bin_link(&stack);
        std::fs::remove_dir_all(&stack.install_dir)
            .with_context(|| format!("remove {}", stack.install_dir.display()))?;
        ui::say(format!(
            "purged project {project} and {}",
            stack.install_dir.display()
        ));
    } else {
        stack.compose(&["down", "--remove-orphans"])?;
        remove_bin_link(&stack);
        ui::say(format!(
            "containers removed; volumes and {} kept.",
            stack.install_dir.display()
        ));
        ui::say(format!(
            "Re-run '{}/mintctl start' to bring it back, or",
            stack.install_dir.display()
        ));
        ui::say("'mintctl uninstall --purge' to delete everything.");
    }
    Ok(())
}

pub fn version() -> Result<()> {
    let stack = Stack::discover()?;
    let envf = env(&stack)?;
    let version = envf.get("VERSION").unwrap_or_default();
    ui::say(format!(
        "installed: {}",
        if version.is_empty() { "unknown" } else { &version }
    ));
    let _ = stack.compose(&["images"]);
    if let Ok(latest) = release::resolve_latest_version() {
        ui::say(format!("latest release: {latest}"));
    }
    Ok(())
}

/// Only remove the /usr/local/bin symlink when it points into this install.
fn remove_bin_link(stack: &Stack) {
    let link = std::path::Path::new(BIN_LINK);
    if let Ok(target) = std::fs::read_link(link) {
        if target == stack.install_dir.join("mintctl") {
            let _ = std::fs::remove_file(link);
        }
    }
}

fn absolutize(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
