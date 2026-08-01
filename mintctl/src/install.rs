//! `mintctl install` — plan construction and execution.
//!
//! Two front ends produce the same `InstallPlan`: the guided wizard (a TTY
//! and no `--yes`) and the pure-flag path (automation, `curl | bash --yes`,
//! CI). Execution is shared; the wizard wraps it in progress UI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use time::format_description::well_known::Rfc3339;

use crate::caddy;
use crate::compose::{self, Stack, BIN_LINK, DEFAULT_LINUX_DIR};
use crate::dns;
use crate::passphrase;
use crate::release::{self, ArtifactSource};
use crate::ui::{self, Ui};
use crate::wizard;
use crate::InstallArgs;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    /// Bundled Caddy terminates TLS for domain + console.domain.
    DomainTls,
    /// No proxy; app ports exposed directly (LAN / testing).
    PlainHttp,
    /// The operator's own reverse proxy terminates TLS; we bind loopback
    /// and hand them ready-made proxy snippets.
    BehindProxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintMode {
    /// Mint + processor, pre-wired (the default).
    Bundled,
    /// Processor only; an existing cdk-mintd is connected later in the console.
    ProcessorOnly,
}

pub struct InstallPlan {
    pub install_dir: PathBuf,
    pub version: String,
    pub no_pull: bool,
    pub access: AccessMode,
    pub mint_mode: MintMode,
    pub domain: String,
    pub console_domain: String,
    pub acme_email: String,
    pub ui_port: u16,
    pub mint_port: u16,
    pub bind_addr: String,
    /// Where the payment gRPC is published for an external mint: loopback for
    /// a same-host mintd, 0.0.0.0 (plus operator firewalling) for a LAN one.
    pub grpc_bind_addr: String,
    pub grpc_port: u16,
    pub public_ip: Option<String>,
    pub admin_password: String,
}

impl InstallPlan {
    pub fn compose_profiles(&self) -> &'static str {
        match self.access {
            AccessMode::DomainTls => "tls",
            AccessMode::PlainHttp | AccessMode::BehindProxy => "",
        }
    }

    pub fn console_url(&self) -> String {
        match self.access {
            AccessMode::DomainTls | AccessMode::BehindProxy => {
                format!("https://{}", self.console_domain)
            }
            AccessMode::PlainHttp => format!(
                "http://{}:{}",
                self.public_ip.as_deref().unwrap_or("<server>"),
                self.ui_port
            ),
        }
    }

    pub fn mint_public_url(&self) -> String {
        match self.access {
            AccessMode::DomainTls | AccessMode::BehindProxy => format!("https://{}", self.domain),
            AccessMode::PlainHttp => format!(
                "http://{}:{}",
                self.public_ip.as_deref().unwrap_or("localhost"),
                self.mint_port
            ),
        }
    }

    pub fn mint_mode_key(&self) -> &'static str {
        match self.mint_mode {
            MintMode::Bundled => "bundled",
            MintMode::ProcessorOnly => "external-pending",
        }
    }
}

pub fn run(args: &InstallArgs) -> Result<()> {
    if args.yes || !ui::have_tty() {
        run_noninteractive(args)
    } else {
        wizard::run(args)
    }
}

fn run_noninteractive(args: &InstallArgs) -> Result<()> {
    let ui = Ui::new(true);
    preflight_platform()?;
    let install_dir = resolve_install_dir(args.dir.clone())?;
    compose::ensure_docker(ui)?;
    guard_fresh_dir(&install_dir)?;

    let version = match &args.version {
        Some(v) => v.clone(),
        None => {
            ui::say("Resolving the latest release ...");
            release::resolve_latest_version()?
        }
    };
    let source = artifact_source(args.artifacts_dir.clone(), args.artifact_ref.clone(), &version);

    ui::say(format!(
        "Installing Custom Unit Mint {version} into {}",
        install_dir.display()
    ));
    fetch_deploy_artifacts(&source, &install_dir)?;
    install_binary(&source, &version, &install_dir.join("mintctl"))?;

    let plan = plan_from_flags(args, install_dir, version)?;
    write_config(&plan)?;

    let stack = Stack {
        install_dir: plan.install_dir.clone(),
    };
    ui::say("");
    if plan.no_pull {
        ui::say(format!(
            "Skipping the image pull (--no-pull); using the local {} image.",
            plan.version
        ));
    } else {
        ui::say(format!("Pulling the image ({}) ...", plan.version));
        pull_image(&stack)?;
    }
    stack.compose(&["up", "-d", "--remove-orphans"])?;

    ui::say("Waiting for the operator console to come up ...");
    if !compose::wait_healthy(plan.ui_port, Duration::from_secs(120)) {
        let _ = stack.compose(&["ps"]);
        bail!(
            "the console did not become healthy within 2 minutes — check '{}/mintctl logs processor'",
            plan.install_dir.display()
        );
    }
    install_cli_symlink(&plan.install_dir);
    print_summary(&plan);
    Ok(())
}

/// Resolve the access + mint mode from flags alone (no prompts).
fn plan_from_flags(args: &InstallArgs, install_dir: PathBuf, version: String) -> Result<InstallPlan> {
    let domain = args.domain.clone().unwrap_or_default();
    if !domain.is_empty() && !dns::valid_hostname(&domain) {
        bail!("--domain {domain} is not a valid hostname (lowercase labels, dots, no scheme)");
    }
    let access = if args.behind_proxy {
        if domain.is_empty() {
            bail!("--behind-proxy needs --domain: your proxy's public hostname for the mint");
        }
        AccessMode::BehindProxy
    } else if args.plain_http || domain.is_empty() {
        if args.plain_http && !domain.is_empty() {
            bail!("--plain-http and --domain are mutually exclusive");
        }
        AccessMode::PlainHttp
    } else {
        AccessMode::DomainTls
    };
    let console_domain = match (&args.console_domain, access) {
        (Some(c), _) => c.clone(),
        (None, AccessMode::PlainHttp) => String::new(),
        (None, _) => format!("console.{domain}"),
    };
    if !console_domain.is_empty() && !dns::valid_hostname(&console_domain) {
        bail!("--console-domain {console_domain} is not a valid hostname");
    }
    Ok(InstallPlan {
        bind_addr: args.bind.clone().unwrap_or_else(|| {
            match access {
                AccessMode::PlainHttp => "0.0.0.0",
                AccessMode::DomainTls | AccessMode::BehindProxy => "127.0.0.1",
            }
            .to_string()
        }),
        mint_mode: if args.processor_only {
            MintMode::ProcessorOnly
        } else {
            MintMode::Bundled
        },
        grpc_bind_addr: args
            .grpc_bind
            .clone()
            .unwrap_or_else(|| "127.0.0.1".to_string()),
        grpc_port: args.grpc_port,
        install_dir,
        version,
        no_pull: args.no_pull,
        access,
        domain,
        console_domain,
        acme_email: args.email.clone().unwrap_or_default(),
        ui_port: args.ui_port,
        mint_port: args.mint_port,
        public_ip: compose::detect_public_ip(),
        admin_password: passphrase::generate(),
    })
}

// ---------------------------------------------------------------------------
// shared primitives (used by both front ends)
// ---------------------------------------------------------------------------

pub fn preflight_platform() -> Result<()> {
    match std::env::consts::ARCH {
        "x86_64" | "aarch64" => {}
        other => bail!("unsupported architecture {other}; images are published for amd64 and arm64"),
    }
    match std::env::consts::OS {
        "linux" => {}
        "macos" => ui::warn("macOS detected — fine for development and testing, not for production."),
        other => bail!("unsupported platform: {other}"),
    }
    Ok(())
}

pub fn resolve_install_dir(explicit: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(dir) = explicit {
        return Ok(dir);
    }
    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").context("HOME is not set")?;
        Ok(PathBuf::from(home).join("custom-unit-mint"))
    } else {
        Ok(PathBuf::from(DEFAULT_LINUX_DIR))
    }
}

pub fn guard_fresh_dir(install_dir: &Path) -> Result<()> {
    if install_dir.join(".env").is_file() {
        bail!(
            "an installation already exists in {dir} — use '{dir}/mintctl status' or \
             '{dir}/mintctl update'. (For a second instance, re-run with --dir and different ports.)",
            dir = install_dir.display()
        );
    }
    std::fs::create_dir_all(install_dir).with_context(|| {
        format!(
            "cannot create {} — re-run as root (curl ... | sudo bash) or pass --dir somewhere writable",
            install_dir.display()
        )
    })
}

pub fn artifact_source(
    artifacts_dir: Option<PathBuf>,
    artifact_ref: Option<String>,
    version: &str,
) -> ArtifactSource {
    match artifacts_dir {
        Some(dir) => ArtifactSource::Dir(dir),
        None => ArtifactSource::Ref(artifact_ref.unwrap_or_else(|| version.to_string())),
    }
}

/// Fetch docker-compose.yml / Caddyfile / .env.example with the same sanity
/// checks the bash installer ran.
pub fn fetch_deploy_artifacts(source: &ArtifactSource, dest_dir: &Path) -> Result<()> {
    let compose_path = dest_dir.join("docker-compose.yml");
    source.fetch("docker-compose.yml", &compose_path)?;
    let compose_text = std::fs::read_to_string(&compose_path).unwrap_or_default();
    if !compose_text.lines().any(|l| l.starts_with("services:")) {
        bail!("downloaded docker-compose.yml looks wrong; aborting");
    }
    source.fetch("Caddyfile", &dest_dir.join("Caddyfile"))?;
    source.fetch(".env.example", &dest_dir.join(".env.example"))?;
    Ok(())
}

/// Put the pinned release's mintctl at `dest`. Self-copy when we ARE that
/// release (or in offline test rigs); otherwise download + verify the asset,
/// falling back to self-copy so an install never ends up without a mintctl.
pub fn install_binary(source: &ArtifactSource, version: &str, dest: &Path) -> Result<()> {
    let own = std::env::current_exe().context("resolve this binary's path")?;
    let self_copy = release::own_version() == version || matches!(source, ArtifactSource::Dir(_));
    if !self_copy {
        match release::download_release_binary(version, dest) {
            Ok(tmp) => {
                std::fs::rename(&tmp, dest)
                    .with_context(|| format!("install mintctl at {}", dest.display()))?;
                return Ok(());
            }
            Err(e) => ui::warn(format!(
                "could not download the {version} mintctl binary ({e}); \
                 installing this running copy ({}) instead",
                release::own_version()
            )),
        }
    }
    if std::fs::canonicalize(&own).ok() != std::fs::canonicalize(dest).ok() {
        std::fs::copy(&own, dest)
            .with_context(|| format!("copy mintctl to {}", dest.display()))?;
    }
    std::fs::set_permissions(dest, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
    Ok(())
}

/// Write .env (0600) and finish the Caddyfile / proxy snippets for the plan.
pub fn write_config(plan: &InstallPlan) -> Result<()> {
    write_env(plan)?;
    caddy::apply_acme_email(&plan.install_dir, &plan.acme_email)?;
    if plan.access == AccessMode::BehindProxy {
        caddy::write_proxy_snippets(plan)?;
    }
    Ok(())
}

pub fn pull_image(stack: &Stack) -> Result<()> {
    stack.compose(&["pull", "--quiet"]).map_err(|_| {
        anyhow::anyhow!(
            "image pull failed. If this is a brand-new setup, check that the GHCR package \
             ghcr.io/{} exists and is public.",
            release::REPO
        )
    })
}

pub fn install_cli_symlink(install_dir: &Path) {
    let target = install_dir.join("mintctl");
    let _ = std::fs::remove_file(BIN_LINK);
    if std::os::unix::fs::symlink(&target, BIN_LINK).is_ok() {
        ui::note(format!("installed the management CLI as {BIN_LINK}"));
    }
}

/// Poll the console through the operator's own proxy / Caddy over verified
/// HTTPS until certificates are issued and routing works.
pub fn wait_for_tls(console_domain: &str, budget: Duration) -> bool {
    let url = format!("https://{console_domain}/healthz");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();
    let deadline = std::time::Instant::now() + budget;
    while std::time::Instant::now() < deadline {
        if agent.get(&url).call().is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    false
}

fn write_env(plan: &InstallPlan) -> Result<()> {
    let now = time::OffsetDateTime::now_utc()
        .replace_millisecond(0)
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc())
        .format(&Rfc3339)
        .unwrap_or_default();
    let body = format!(
        "# Generated by the Custom Unit Mint installer {now}.\n\
         # Every key is documented in .env.example.\n\
         VERSION={version}\n\
         COMPOSE_PROJECT_NAME={project}\n\
         UI_PORT={ui_port}\n\
         MINT_PORT={mint_port}\n\
         BIND_ADDR={bind}\n\
         COMPOSE_PROFILES={compose_profiles}\n\
         DOMAIN={domain}\n\
         CONSOLE_DOMAIN={console_domain}\n\
         MINT_PUBLIC_URL={mint_public_url}\n\
         MINT_MODE={mint_mode}\n\
         GRPC_BIND_ADDR={grpc_bind}\n\
         GRPC_PORT={grpc_port}\n\
         # First boot only; inert once users.json exists. Kept as a recovery path in\n\
         # case the printed password is lost before the operator changes it.\n\
         INITIAL_ADMIN_PASSWORD={admin_password}\n\
         ACME_EMAIL={acme_email}\n",
        version = plan.version,
        project = compose::project_name(&plan.install_dir),
        ui_port = plan.ui_port,
        mint_port = plan.mint_port,
        bind = plan.bind_addr,
        compose_profiles = plan.compose_profiles(),
        domain = plan.domain,
        console_domain = plan.console_domain,
        mint_public_url = plan.mint_public_url(),
        mint_mode = plan.mint_mode_key(),
        grpc_bind = plan.grpc_bind_addr,
        grpc_port = plan.grpc_port,
        admin_password = plan.admin_password,
        acme_email = plan.acme_email,
    );
    let env_path = plan.install_dir.join(".env");
    std::fs::write(&env_path, body).with_context(|| format!("write {}", env_path.display()))?;
    std::fs::set_permissions(&env_path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(())
}

pub fn next_steps(plan: &InstallPlan) -> Vec<String> {
    let mut steps = vec![];
    match plan.mint_mode {
        MintMode::Bundled => {
            steps.push("1. Units tab  — add the first unit; this starts the mint.".into());
            steps.push("2. Mint tab   — reveal and back up the 24-word recovery phrase.".into());
            steps.push("3. Access tab — add teller accounts as needed.".into());
        }
        MintMode::ProcessorOnly => {
            steps.push("1. Mint tab   — connect your existing cdk-mintd.".into());
            steps.push("2. Units tab  — add the first unit once the mint is attached.".into());
            steps.push("3. Access tab — add teller accounts as needed.".into());
        }
    }
    steps
}

fn print_summary(plan: &InstallPlan) {
    use ui::say;
    say("");
    say("============================================================");
    say(format!(" Custom Unit Mint {} is running", plan.version));
    say("============================================================");
    say("");
    say(format!("  Operator console:  {}", plan.console_url()));
    say(format!("  Mint API:          {}", plan.mint_public_url()));
    say("");
    say(format!("  Sign in:           admin / {}", plan.admin_password));
    say(format!(
        "                     (also stored in {}/.env)",
        plan.install_dir.display()
    ));
    say("                     You will be asked to choose your own password");
    say("                     at first sign-in.");
    say("");
    say("  First steps in the console:");
    for step in next_steps(plan) {
        say(format!("    {step}"));
    }
    say("");
    match plan.access {
        AccessMode::DomainTls => {
            say("  Certificates are provisioned automatically; the first HTTPS");
            say("  request can take a minute. Firewall: allow 80 and 443.");
        }
        AccessMode::PlainHttp => {
            say("  Plain-HTTP mode: fine on a trusted LAN, not for the public");
            say(format!(
                "  internet. Firewall: allow {} and {}.",
                plan.ui_port, plan.mint_port
            ));
        }
        AccessMode::BehindProxy => {
            say("  Your reverse proxy terminates TLS. Ready-made server blocks:");
            say(format!(
                "    {}/proxy-snippets/  (Caddy and nginx)",
                plan.install_dir.display()
            ));
            say(format!(
                "  Proxy {} and {} to 127.0.0.1:{} / 127.0.0.1:{}.",
                plan.domain, plan.console_domain, plan.mint_port, plan.ui_port
            ));
        }
    }
    say("");
    say("  Manage with: mintctl status | logs | update | backup | restore |");
    say("               start | stop | uninstall");
    say("============================================================");
}
