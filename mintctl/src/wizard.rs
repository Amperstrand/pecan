//! The guided installer (and `mintctl domain`) — a clack-style wizard.
//!
//! Runs whenever install has a terminal and no `--yes`; every question has a
//! flag twin so automation never lands here. Cancelling any prompt (ESC or
//! Ctrl-C) aborts cleanly without touching the system.
//!
//! The wizard sets up the processor only: console reachability, the payment
//! gRPC bind for the operator's own cdk-mintd, and the first admin password.
//! Attaching the mint happens afterwards, in the console's Mint tab.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Result};
use cliclack::{confirm, input, intro, log, note, outro, outro_cancel, select, spinner};

use crate::compose::{self, Stack};
use crate::dns;
use crate::envfile::EnvFile;
use crate::install::{self, AccessMode, InstallPlan};
use crate::preflight::{self, PortStatus};
use crate::release;
use crate::{caddy, passphrase};
use crate::{DomainArgs, InstallArgs};

fn cancelled(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::Interrupted
}

/// Wrap a cliclack interaction: cancel becomes a clean abort.
macro_rules! step {
    ($expr:expr) => {
        match $expr {
            Ok(value) => value,
            Err(ref e) if cancelled(e) => {
                let _ = outro_cancel("Cancelled — nothing was changed.");
                bail!("install cancelled");
            }
            Err(e) => return Err(e.into()),
        }
    };
}

pub fn run(args: &InstallArgs) -> Result<()> {
    intro(console::style(" Pecan — branch processor ").on_cyan().black())?;

    // --- resolve version early: everything else is pinned to it -----------
    install::preflight_platform()?;
    let sp = spinner();
    let version = match &args.version {
        Some(v) => v.clone(),
        None => {
            sp.start("Resolving the latest release ...");
            match release::resolve_latest_version() {
                Ok(v) => {
                    sp.stop(format!("Latest release: {v}"));
                    v
                }
                Err(e) => {
                    sp.error("Could not resolve the latest release");
                    return Err(e);
                }
            }
        }
    };

    // --- preflight ---------------------------------------------------------
    ensure_docker_interactive()?;

    let mut install_dir = install::resolve_install_dir(args.dir.clone())?;
    while install_dir.join(".env").is_file() {
        log::warning(format!(
            "An installation already exists in {}",
            install_dir.display()
        ))?;
        #[derive(Clone, PartialEq, Eq)]
        enum Existing {
            OtherDir,
            Abort,
        }
        match step!(select("How do you want to proceed?")
            .item(
                Existing::Abort,
                "Keep it",
                "manage it with mintctl status / update"
            )
            .item(
                Existing::OtherDir,
                "Install a second instance elsewhere",
                "choose another directory"
            )
            .interact())
        {
            Existing::Abort => {
                outro("Nothing was changed.")?;
                return Ok(());
            }
            Existing::OtherDir => {
                let dir: String = step!(input("Install directory")
                    .placeholder("/opt/pecan-2")
                    .validate(|value: &String| {
                        if value.trim().is_empty() {
                            Err("enter a directory path")
                        } else {
                            Ok(())
                        }
                    })
                    .interact());
                install_dir = PathBuf::from(dir.trim());
            }
        }
    }

    let sp = spinner();
    sp.start("Detecting the server's public IP ...");
    let public_ip = compose::detect_public_ip();
    match &public_ip {
        Some(ip) => sp.stop(format!("Public IP: {ip}")),
        None => sp.stop("Public IP: could not detect (offline or LAN-only) — continuing"),
    }

    let mut ui_port = args.ui_port;
    let mut grpc_port = args.grpc_port;
    for (label, port) in [("console", &mut ui_port), ("payment gRPC", &mut grpc_port)] {
        if preflight::port_status(*port) == PortStatus::Busy {
            log::warning(format!("Port {port} (for the {label}) is already in use."))?;
            let answer: String = step!(input(format!("Alternative {label} port"))
                .default_input(&(*port + 10000).to_string())
                .validate(|value: &String| match value.trim().parse::<u16>() {
                    Ok(p) if p >= 1024 => Ok(()),
                    _ => Err("enter a port number (1024-65535)"),
                })
                .interact());
            *port = answer.trim().parse().unwrap_or(*port);
        }
    }

    // --- where the mint runs ------------------------------------------------
    let mut grpc_bind_addr = args.grpc_bind.clone().unwrap_or_default();
    if grpc_bind_addr.is_empty() {
        #[derive(Clone, PartialEq, Eq)]
        enum MintLocation {
            SameHost,
            OtherMachine,
        }
        let location = step!(select("Where does (or will) your cdk-mintd run?")
            .item(
                MintLocation::SameHost,
                "On this server",
                "the payment gRPC stays on localhost"
            )
            .item(
                MintLocation::OtherMachine,
                "On another machine in the private network",
                "publishes the gRPC on all interfaces — firewall it or enable TLS"
            )
            .interact());
        grpc_bind_addr = match location {
            MintLocation::SameHost => "127.0.0.1".into(),
            MintLocation::OtherMachine => {
                log::warning(format!(
                    "The payment gRPC (port {grpc_port}) carries no authentication.\n\
                     Restrict it to your private network with a firewall rule, or\n\
                     enable mutual TLS (GRPC_TLS_DIR in .env.example)."
                ))?;
                "0.0.0.0".into()
            }
        };
    }

    // --- console access -----------------------------------------------------
    let ports_busy = preflight::ports_80_443_busy();
    let access = if args.behind_proxy {
        AccessMode::BehindProxy
    } else if args.plain_http {
        AccessMode::PlainHttp
    } else if args.console_domain.is_some() && !ports_busy {
        AccessMode::DomainTls
    } else {
        if ports_busy {
            log::info(
                "Something on this server already listens on port 80/443 —\n\
                 an existing reverse proxy, most likely. The console can run\n\
                 behind it instead of bringing its own.",
            )?;
        }
        let mut sel = select("How should operators reach the console?")
            .item(
                AccessMode::DomainTls,
                if ports_busy {
                    "Domain with automatic HTTPS (needs ports 80/443)"
                } else {
                    "Domain with automatic HTTPS (recommended)"
                },
                "bundled Caddy obtains certificates for the console hostname"
            )
            .item(
                AccessMode::BehindProxy,
                if ports_busy {
                    "Behind my own reverse proxy (recommended here)"
                } else {
                    "Behind my own reverse proxy"
                },
                "binds to localhost; you get ready-made Caddy/nginx snippets"
            )
            .item(
                AccessMode::PlainHttp,
                "Plain HTTP",
                "LAN or testing only"
            );
        sel = sel.initial_value(if ports_busy {
            AccessMode::BehindProxy
        } else {
            AccessMode::DomainTls
        });
        step!(sel.interact())
    };

    let mut console_domain = args.console_domain.clone().unwrap_or_default();
    let mut acme_email = args.email.clone().unwrap_or_default();
    let mut access = access;
    if access != AccessMode::PlainHttp {
        console_domain = collect_console_domain(&console_domain)?;
    }
    match access {
        AccessMode::DomainTls => {
            if ports_busy {
                log::warning(
                    "Ports 80/443 are in use — the bundled Caddy will not be able to bind them.",
                )?;
                if !step!(confirm("Continue with the bundled Caddy anyway?")
                    .initial_value(false)
                    .interact())
                {
                    log::step("Switching to behind-your-own-proxy mode.")?;
                    access = AccessMode::BehindProxy;
                }
            }
        }
        AccessMode::PlainHttp | AccessMode::BehindProxy => {}
    }
    if access == AccessMode::DomainTls {
        if acme_email.is_empty() {
            acme_email = step!(input("Email for certificate expiry notices (optional)")
                .placeholder("you@example.org")
                .required(false)
                .validate(|value: &String| {
                    let v = value.trim();
                    if v.is_empty() || (v.contains('@') && !v.contains(char::is_whitespace)) {
                        Ok(())
                    } else {
                        Err("enter an email address or leave empty")
                    }
                })
                .interact());
            acme_email = acme_email.trim().to_string();
        }
        confirm_dns(&console_domain, public_ip.as_deref(), &mut access)?;
    }

    // --- summary + confirm --------------------------------------------------
    let plan = InstallPlan {
        bind_addr: args.bind.clone().unwrap_or_else(|| {
            match access {
                AccessMode::PlainHttp => "0.0.0.0",
                _ => "127.0.0.1",
            }
            .to_string()
        }),
        install_dir,
        version,
        no_pull: args.no_pull,
        access,
        console_domain: if access == AccessMode::PlainHttp {
            String::new()
        } else {
            console_domain
        },
        acme_email,
        ui_port,
        grpc_bind_addr,
        grpc_port,
        public_ip,
        admin_password: passphrase::generate(),
    };

    let access_line = match plan.access {
        AccessMode::DomainTls => format!("{} — automatic HTTPS", plan.console_url()),
        AccessMode::BehindProxy => format!("{} — via your own reverse proxy", plan.console_url()),
        AccessMode::PlainHttp => format!("{} — plain HTTP (LAN/testing)", plan.console_url()),
    };
    note(
        "Ready to install",
        format!(
            "Console        {access_line}\n\
             Payment gRPC   {grpc} (your cdk-mintd connects here)\n\
             Directory      {dir}\n\
             Version        {version}\n\
             \n\
             The mint itself is attached afterwards, in the console's Mint tab.",
            grpc = plan.grpc_endpoint(),
            dir = plan.install_dir.display(),
            version = plan.version,
        ),
    )?;
    if !step!(confirm("Install now?").initial_value(true).interact()) {
        outro_cancel("Cancelled — nothing was changed.")?;
        bail!("install cancelled");
    }

    execute_with_progress(&plan, args)?;
    finish(&plan)?;
    Ok(())
}

fn collect_console_domain(preset: &str) -> Result<String> {
    if !preset.is_empty() {
        return Ok(preset.to_string());
    }
    let entered: String = step!(input("Hostname for the operator console")
        .placeholder("console.example.org")
        .validate(|value: &String| {
            if dns::valid_hostname(value.trim()) {
                Ok(())
            } else {
                Err("enter a bare hostname like console.example.org (no https://, lowercase)")
            }
        })
        .interact());
    Ok(entered.trim().to_string())
}

/// Show the required record, then live-poll public DNS until it resolves to
/// this server (or the operator decides otherwise).
fn confirm_dns(
    console_domain: &str,
    public_ip: Option<&str>,
    access: &mut AccessMode,
) -> Result<()> {
    let ip_hint = public_ip.unwrap_or("<this server's IP>");
    note(
        "DNS record required (pointing at this server)",
        format!(
            "A/AAAA  {console_domain}  →  {ip_hint}\n\
             Ports 80 and 443 must be reachable from the internet."
        ),
    )?;

    loop {
        let sp = spinner();
        sp.start("Checking DNS via public resolvers (1.1.1.1, 8.8.8.8) ...");
        let check = dns::check(console_domain, public_ip).ok();
        if check.as_ref().is_some_and(|c| c.matches) {
            sp.stop("DNS looks right — the record points at this server.");
            return Ok(());
        }
        sp.stop("DNS is not confirmed yet:");
        if let Some(check) = &check {
            let status = if check.resolved.is_empty() {
                "no record found".to_string()
            } else {
                let ips: Vec<String> = check.resolved.iter().map(|ip| ip.to_string()).collect();
                format!("resolves to {}", ips.join(", "))
            };
            log::step(format!("{}  —  {status}", check.domain))?;
            if check.behind_cloudflare {
                log::warning(format!(
                    "{} appears to be behind the Cloudflare proxy (orange cloud).\n\
                     Certificate issuance needs the record set to \"DNS only\" (grey cloud).",
                    check.domain
                ))?;
            }
        }
        log::info("Freshly created records can take a few minutes to propagate.")?;

        #[derive(Clone, PartialEq, Eq)]
        enum Next {
            Recheck,
            Continue,
            Fallback,
            Abort,
        }
        match step!(select("How do you want to proceed?")
            .item(Next::Recheck, "Check again", "after creating or fixing the record")
            .item(
                Next::Continue,
                "Continue anyway",
                "certificates will be retried in the background once DNS is right"
            )
            .item(
                Next::Fallback,
                "Switch to plain HTTP",
                "skip TLS for now; mintctl domain can set it up later"
            )
            .item(Next::Abort, "Abort the install", "nothing has been changed yet")
            .interact())
        {
            Next::Recheck => continue,
            Next::Continue => return Ok(()),
            Next::Fallback => {
                *access = AccessMode::PlainHttp;
                return Ok(());
            }
            Next::Abort => {
                outro_cancel("Cancelled — nothing was changed.")?;
                bail!("install cancelled");
            }
        }
    }
}

fn ensure_docker_interactive() -> Result<()> {
    if !compose::docker_available() {
        if cfg!(target_os = "macos") {
            let _ = outro_cancel(
                "Docker is not installed. Install Docker Desktop (or OrbStack) and re-run.",
            );
            bail!("Docker is required");
        }
        log::warning("Docker is not installed.")?;
        if step!(confirm("Install Docker now via https://get.docker.com?")
            .initial_value(true)
            .interact())
        {
            let sp = spinner();
            sp.start("Installing Docker (this takes a minute) ...");
            let output = std::process::Command::new("sh")
                .args(["-c", "curl -fsSL https://get.docker.com | sh"])
                .output()?;
            if output.status.success() {
                sp.stop("Docker installed.");
            } else {
                sp.error("The Docker installer failed");
                bail!(
                    "docker install failed:\n{}",
                    String::from_utf8_lossy(&output.stderr)
                        .lines()
                        .rev()
                        .take(6)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n")
                );
            }
        } else {
            let _ = outro_cancel("Docker is required. Install it and re-run.");
            bail!("Docker is required");
        }
    }
    if !compose::docker_daemon_running() {
        let _ = outro_cancel(
            "The Docker daemon is not responding. Start it (or re-run as root / \
             add this user to the docker group) and try again.",
        );
        bail!("the Docker daemon is not responding");
    }
    if !compose::compose_v2_available() {
        let _ = outro_cancel(
            "Docker Compose v2 is required (the 'docker compose' plugin). \
             Install docker-compose-plugin and re-run.",
        );
        bail!("Docker Compose v2 is required");
    }
    log::success("Docker is ready.")?;
    Ok(())
}

fn execute_with_progress(plan: &InstallPlan, args: &InstallArgs) -> Result<()> {
    install::guard_fresh_dir(&plan.install_dir)?;
    let source =
        install::artifact_source(args.artifacts_dir.clone(), args.artifact_ref.clone(), &plan.version);

    let sp = spinner();
    sp.start(format!("Fetching the {} deployment artifacts ...", plan.version));
    install::fetch_deploy_artifacts(&source, &plan.install_dir)?;
    install::install_binary(&source, &plan.version, &plan.install_dir.join("mintctl"))?;
    install::write_config(plan)?;
    sp.stop(format!("Deployment artifacts in {}", plan.install_dir.display()));

    let stack = Stack {
        install_dir: plan.install_dir.clone(),
    };
    if plan.no_pull {
        log::step(format!(
            "Skipping the image pull (--no-pull); using the local {} image.",
            plan.version
        ))?;
    } else {
        let sp = spinner();
        sp.start(format!("Pulling the container image ({}) ...", plan.version));
        match stack.compose_quiet(&["pull", "--quiet"]) {
            Ok(()) => sp.stop("Image pulled."),
            Err(e) => {
                sp.error("Image pull failed");
                return Err(e);
            }
        }
    }

    let sp = spinner();
    sp.start("Starting the stack ...");
    if let Err(e) = stack.compose_quiet(&["up", "-d", "--remove-orphans"]) {
        sp.error("The stack did not start");
        return Err(e);
    }
    sp.stop("Stack started.");

    let sp = spinner();
    sp.start("Waiting for the operator console ...");
    if !compose::wait_healthy(plan.ui_port, Duration::from_secs(120)) {
        sp.error("The console did not become healthy within 2 minutes");
        bail!(
            "check '{}/mintctl logs processor'",
            plan.install_dir.display()
        );
    }
    sp.stop("Operator console is up.");

    if plan.access == AccessMode::DomainTls {
        let sp = spinner();
        sp.start(format!(
            "Waiting for Let's Encrypt certificates for {} (up to 3 minutes) ...",
            plan.console_domain
        ));
        if install::wait_for_tls(&plan.console_domain, Duration::from_secs(180)) {
            sp.stop(format!("HTTPS is live at {}", plan.console_url()));
        } else {
            sp.stop("Certificates are still pending — Caddy keeps retrying in the background.");
            log::info(format!(
                "Once DNS is right, https://{} will come up by itself.\n\
                 Watch progress with: {}/mintctl logs caddy",
                plan.console_domain,
                plan.install_dir.display()
            ))?;
        }
    }
    install::install_cli_symlink(&plan.install_dir);
    Ok(())
}

fn finish(plan: &InstallPlan) -> Result<()> {
    let mut body = format!(
        "Operator console   {console}\n\
         Payment gRPC       {grpc}  (your cdk-mintd connects here)\n\n\
         Sign in as         admin\n\
         Password           {password}\n\
         (also stored in {dir}/.env — you will choose\n\
         your own password at first sign-in)\n\nNext steps:",
        console = plan.console_url(),
        grpc = plan.grpc_endpoint(),
        password = plan.admin_password,
        dir = plan.install_dir.display(),
    );
    for step in install::next_steps(plan) {
        body.push_str(&format!("\n  {step}"));
    }
    if plan.access == AccessMode::BehindProxy {
        body.push_str(&format!(
            "\n\nYour reverse proxy terminates TLS — ready-made server blocks:\n  \
             {}/proxy-snippets/  (Caddy and nginx)",
            plan.install_dir.display()
        ));
    }
    note(
        format!("Branch processor {} is running", plan.version),
        body,
    )?;
    outro("Manage with: mintctl status | logs | update | backup | restore | start | stop | uninstall")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// mintctl domain — re-run the console-access step on an existing install
// ---------------------------------------------------------------------------

pub fn domain_command(args: &DomainArgs) -> Result<()> {
    let stack = Stack::discover()?;
    let mut envf = EnvFile::load(&stack.env_path())?;
    let interactive = !args.yes && crate::ui::have_tty();

    let current_domain = envf.get("CONSOLE_DOMAIN").unwrap_or_default();
    let ui_port: u16 = envf.get("UI_PORT").and_then(|p| p.parse().ok()).unwrap_or(9090);

    let (access, console_domain, acme_email) = if interactive {
        intro(console::style(" Console domain & TLS ").on_cyan().black())?;
        if current_domain.is_empty() {
            log::info("Currently: plain HTTP (no domain).")?;
        } else {
            log::info(format!("Currently: https://{current_domain}"))?;
        }
        let ports_busy = preflight::ports_80_443_busy();
        let access = step!(select("How should operators reach the console?")
            .item(
                AccessMode::DomainTls,
                "Domain with automatic HTTPS",
                "bundled Caddy obtains certificates"
            )
            .item(
                AccessMode::BehindProxy,
                "Behind my own reverse proxy",
                "binds to localhost; you get ready-made snippets"
            )
            .item(AccessMode::PlainHttp, "Plain HTTP", "LAN or testing only")
            .initial_value(if !current_domain.is_empty() {
                AccessMode::DomainTls
            } else if ports_busy {
                AccessMode::BehindProxy
            } else {
                AccessMode::DomainTls
            })
            .interact());
        let mut access = access;
        let (mut console_domain, mut email) = (String::new(), String::new());
        if access != AccessMode::PlainHttp {
            let preset = args.console_domain.clone().unwrap_or_default();
            console_domain = collect_console_domain(&preset)?;
        }
        if access == AccessMode::DomainTls {
            email = args
                .email
                .clone()
                .unwrap_or_else(|| envf.get("ACME_EMAIL").unwrap_or_default());
            let public_ip = compose::detect_public_ip();
            confirm_dns(&console_domain, public_ip.as_deref(), &mut access)?;
        }
        (access, console_domain, email)
    } else {
        let console_domain = args.console_domain.clone().unwrap_or_default();
        let access = if args.behind_proxy {
            if console_domain.is_empty() {
                bail!("--behind-proxy needs --console-domain");
            }
            AccessMode::BehindProxy
        } else if args.plain_http || console_domain.is_empty() {
            if !args.plain_http && console_domain.is_empty() {
                bail!("pass --console-domain <d>, --plain-http, or --behind-proxy (with --console-domain)");
            }
            AccessMode::PlainHttp
        } else {
            AccessMode::DomainTls
        };
        if access != AccessMode::PlainHttp && !dns::valid_hostname(&console_domain) {
            bail!("--console-domain {console_domain} is not a valid hostname");
        }
        let email = args
            .email
            .clone()
            .unwrap_or_else(|| envf.get("ACME_EMAIL").unwrap_or_default());
        (access, console_domain, email)
    };

    let (profiles, bind) = match access {
        AccessMode::DomainTls => ("tls", "127.0.0.1"),
        AccessMode::BehindProxy => ("", "127.0.0.1"),
        AccessMode::PlainHttp => ("", "0.0.0.0"),
    };
    envf.set("COMPOSE_PROFILES", profiles);
    envf.set("BIND_ADDR", bind);
    envf.set("CONSOLE_DOMAIN", &console_domain);
    envf.set("ACME_EMAIL", &acme_email);
    envf.save()?;
    caddy::apply_acme_email(&stack.install_dir, &acme_email)?;
    if access == AccessMode::BehindProxy {
        let snippet_plan = snippet_plan(&stack, &console_domain, ui_port);
        caddy::write_proxy_snippets(&snippet_plan)?;
    }

    let apply = |quiet: bool| -> Result<()> {
        if quiet {
            stack.compose_quiet(&["up", "-d", "--remove-orphans"])
        } else {
            stack.compose(&["up", "-d", "--remove-orphans"])
        }
    };
    if interactive {
        let sp = spinner();
        sp.start("Applying the new access configuration ...");
        if let Err(e) = apply(true) {
            sp.error("Could not apply the configuration");
            return Err(e);
        }
        if !compose::wait_healthy(ui_port, Duration::from_secs(120)) {
            sp.error("The console did not come back");
            bail!("check 'mintctl logs processor'");
        }
        sp.stop("Configuration applied.");
        if access == AccessMode::DomainTls {
            let sp = spinner();
            sp.start(format!(
                "Waiting for certificates for {console_domain} (up to 3 minutes) ..."
            ));
            if install::wait_for_tls(&console_domain, Duration::from_secs(180)) {
                sp.stop(format!("HTTPS is live at https://{console_domain}"));
            } else {
                sp.stop("Certificates are still pending — Caddy keeps retrying in the background.");
            }
        }
        outro("Done.")?;
    } else {
        apply(false)?;
        if !compose::wait_healthy(ui_port, Duration::from_secs(120)) {
            bail!("the console did not come back — check 'mintctl logs processor'");
        }
        crate::ui::say("Access configuration applied.");
    }
    Ok(())
}

/// A minimal InstallPlan for snippet rendering on an existing install.
fn snippet_plan(stack: &Stack, console_domain: &str, ui_port: u16) -> InstallPlan {
    InstallPlan {
        install_dir: stack.install_dir.clone(),
        version: String::new(),
        no_pull: true,
        access: AccessMode::BehindProxy,
        console_domain: console_domain.to_string(),
        acme_email: String::new(),
        ui_port,
        bind_addr: "127.0.0.1".into(),
        grpc_bind_addr: "127.0.0.1".into(),
        grpc_port: 50051,
        public_ip: None,
        admin_password: String::new(),
    }
}
