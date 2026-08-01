//! The guided installer (and `mintctl domain`) — a clack-style wizard.
//!
//! Runs whenever install has a terminal and no `--yes`; every question has a
//! flag twin so automation never lands here. Cancelling any prompt (ESC or
//! Ctrl-C) aborts cleanly without touching the system.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Result};
use cliclack::{confirm, input, intro, log, note, outro, outro_cancel, select, spinner};

use crate::compose::{self, Stack};
use crate::dns;
use crate::envfile::EnvFile;
use crate::install::{self, AccessMode, InstallPlan, MintMode};
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
    intro(console::style(" Custom Unit Mint ").on_cyan().black())?;

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
                    .placeholder("/opt/custom-unit-mint-2")
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
    let mut mint_port = args.mint_port;
    for (label, port) in [("console", &mut ui_port), ("mint API", &mut mint_port)] {
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

    // --- what to set up ----------------------------------------------------
    let mint_mode = if args.processor_only {
        MintMode::ProcessorOnly
    } else {
        step!(select("What do you want to set up?")
            .item(
                MintMode::Bundled,
                "Mint + processor (recommended)",
                "a complete mint, pre-wired; it starts when the first unit is added"
            )
            .item(
                MintMode::ProcessorOnly,
                "Processor only",
                "connect an existing cdk-mintd later in the console"
            )
            .interact())
    };
    let mut grpc_bind_addr = args.grpc_bind.clone().unwrap_or_default();
    if mint_mode == MintMode::ProcessorOnly && grpc_bind_addr.is_empty() {
        #[derive(Clone, PartialEq, Eq)]
        enum MintLocation {
            SameHost,
            Lan,
        }
        let location = step!(select("Where does your existing cdk-mintd run?")
            .item(
                MintLocation::SameHost,
                "On this server",
                "the payment gRPC stays on localhost"
            )
            .item(
                MintLocation::Lan,
                "On another machine in the private network",
                "publishes the gRPC on all interfaces — firewall it; the link has no auth"
            )
            .interact());
        grpc_bind_addr = match location {
            MintLocation::SameHost => "127.0.0.1".into(),
            MintLocation::Lan => {
                log::warning(
                    "The payment gRPC (port 50051) carries no authentication.\n\
                     Restrict it to your private network with a firewall rule.",
                )?;
                "0.0.0.0".into()
            }
        };
    }
    if grpc_bind_addr.is_empty() {
        grpc_bind_addr = "127.0.0.1".into();
    }

    // --- public access -----------------------------------------------------
    let ports_busy = preflight::ports_80_443_busy();
    let access = if args.behind_proxy {
        AccessMode::BehindProxy
    } else if args.plain_http {
        AccessMode::PlainHttp
    } else if args.domain.is_some() && !ports_busy {
        AccessMode::DomainTls
    } else {
        if ports_busy {
            log::info(
                "Something on this server already listens on port 80/443 —\n\
                 an existing reverse proxy, most likely. The stack can run\n\
                 behind it instead of bringing its own.",
            )?;
        }
        let mut sel = select("How should people reach the mint?")
            .item(
                AccessMode::DomainTls,
                if ports_busy {
                    "Domain with automatic HTTPS (needs ports 80/443)"
                } else {
                    "Domain with automatic HTTPS (recommended)"
                },
                "bundled Caddy obtains certificates; wallets refuse plain HTTP"
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
                "LAN or testing only — wallets refuse plain-HTTP mints"
            );
        sel = sel.initial_value(if ports_busy {
            AccessMode::BehindProxy
        } else {
            AccessMode::DomainTls
        });
        step!(sel.interact())
    };

    let mut domain = args.domain.clone().unwrap_or_default();
    let mut console_domain = args.console_domain.clone().unwrap_or_default();
    let mut acme_email = args.email.clone().unwrap_or_default();
    let mut access = access;
    if access != AccessMode::PlainHttp {
        (domain, console_domain) = collect_domains(&domain, &console_domain)?;
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
        confirm_dns(&domain, &console_domain, public_ip.as_deref(), &mut access)?;
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
        mint_mode,
        domain: if access == AccessMode::PlainHttp { String::new() } else { domain },
        console_domain: if access == AccessMode::PlainHttp {
            String::new()
        } else {
            console_domain
        },
        acme_email,
        ui_port,
        mint_port,
        grpc_bind_addr,
        grpc_port: args.grpc_port,
        public_ip,
        admin_password: passphrase::generate(),
    };

    let setup_line = match plan.mint_mode {
        MintMode::Bundled => "Mint + processor",
        MintMode::ProcessorOnly => "Processor only (connect a mint in the console)",
    };
    let access_line = match plan.access {
        AccessMode::DomainTls => format!("{} — automatic HTTPS", plan.mint_public_url()),
        AccessMode::BehindProxy => format!("{} — via your own reverse proxy", plan.mint_public_url()),
        AccessMode::PlainHttp => format!("{} — plain HTTP (LAN/testing)", plan.mint_public_url()),
    };
    note(
        "Ready to install",
        format!(
            "Setup       {setup_line}\n\
             Mint URL    {access_line}\n\
             Console     {console}\n\
             Directory   {dir}\n\
             Version     {version}",
            console = plan.console_url(),
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

fn collect_domains(preset: &str, preset_console: &str) -> Result<(String, String)> {
    let domain: String = if preset.is_empty() {
        step!(input("Domain for the mint")
            .placeholder("mint.example.org")
            .validate(|value: &String| {
                if dns::valid_hostname(value.trim()) {
                    Ok(())
                } else {
                    Err("enter a bare hostname like mint.example.org (no https://, lowercase)")
                }
            })
            .interact())
    } else {
        preset.to_string()
    };
    let domain = domain.trim().to_string();
    let default_console = format!("console.{domain}");
    let console_domain = if preset_console.is_empty() {
        let customize = step!(confirm(format!(
            "The operator console gets its own hostname: {default_console} — keep it?"
        ))
        .initial_value(true)
        .interact());
        if customize {
            default_console
        } else {
            let entered: String = step!(input("Console hostname")
                .placeholder(&default_console)
                .validate(|value: &String| {
                    if dns::valid_hostname(value.trim()) {
                        Ok(())
                    } else {
                        Err("enter a bare hostname (no https://, lowercase)")
                    }
                })
                .interact());
            entered.trim().to_string()
        }
    } else {
        preset_console.to_string()
    };
    Ok((domain, console_domain))
}

/// Show the required records, then live-poll public DNS until both resolve to
/// this server (or the operator decides otherwise).
fn confirm_dns(
    domain: &str,
    console_domain: &str,
    public_ip: Option<&str>,
    access: &mut AccessMode,
) -> Result<()> {
    let ip_hint = public_ip.unwrap_or("<this server's IP>");
    note(
        "DNS records required (both pointing at this server)",
        format!(
            "A/AAAA  {domain:<width$}  →  {ip_hint}\n\
             A/AAAA  {console_domain:<width$}  →  {ip_hint}\n\
             Ports 80 and 443 must be reachable from the internet.",
            width = domain.len().max(console_domain.len()),
        ),
    )?;

    loop {
        let sp = spinner();
        sp.start("Checking DNS via public resolvers (1.1.1.1, 8.8.8.8) ...");
        let checks: Vec<dns::DnsCheck> = [domain, console_domain]
            .iter()
            .filter_map(|name| dns::check(name, public_ip).ok())
            .collect();
        let all_good = checks.len() == 2 && checks.iter().all(|c| c.matches);
        if all_good {
            sp.stop("DNS looks right — both records point at this server.");
            return Ok(());
        }
        sp.stop("DNS is not confirmed yet:");
        for check in &checks {
            let status = if check.matches {
                "ok".to_string()
            } else if check.resolved.is_empty() {
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
            .item(Next::Recheck, "Check again", "after creating or fixing the records")
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
         Mint API           {mint}\n\n\
         Sign in as         admin\n\
         Password           {password}\n\
         (also stored in {dir}/.env — you will choose\n\
         your own password at first sign-in)\n\nNext steps:",
        console = plan.console_url(),
        mint = plan.mint_public_url(),
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
        format!("Custom Unit Mint {} is running", plan.version),
        body,
    )?;
    outro("Manage with: mintctl status | logs | update | backup | restore | start | stop | uninstall")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// mintctl domain — re-run the access step on an existing install
// ---------------------------------------------------------------------------

pub fn domain_command(args: &DomainArgs) -> Result<()> {
    let stack = Stack::discover()?;
    let mut envf = EnvFile::load(&stack.env_path())?;
    let interactive = !args.yes && crate::ui::have_tty();

    let current_domain = envf.get("DOMAIN").unwrap_or_default();
    let ui_port: u16 = envf.get("UI_PORT").and_then(|p| p.parse().ok()).unwrap_or(9090);
    let mint_port: u16 = envf.get("MINT_PORT").and_then(|p| p.parse().ok()).unwrap_or(8089);

    let (access, domain, console_domain, acme_email) = if interactive {
        intro(console::style(" Domain & TLS ").on_cyan().black())?;
        if current_domain.is_empty() {
            log::info("Currently: plain HTTP (no domain).")?;
        } else {
            log::info(format!("Currently: https://{current_domain}"))?;
        }
        let ports_busy = preflight::ports_80_443_busy();
        let access = step!(select("How should people reach the mint?")
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
        let (mut domain, mut console_domain, mut email) = (String::new(), String::new(), String::new());
        if access != AccessMode::PlainHttp {
            let preset = args.domain.clone().unwrap_or_default();
            let preset_console = args.console_domain.clone().unwrap_or_default();
            (domain, console_domain) = collect_domains(&preset, &preset_console)?;
        }
        if access == AccessMode::DomainTls {
            email = args
                .email
                .clone()
                .unwrap_or_else(|| envf.get("ACME_EMAIL").unwrap_or_default());
            let public_ip = compose::detect_public_ip();
            confirm_dns(&domain, &console_domain, public_ip.as_deref(), &mut access)?;
        }
        (access, domain, console_domain, email)
    } else {
        let domain = args.domain.clone().unwrap_or_default();
        let access = if args.behind_proxy {
            AccessMode::BehindProxy
        } else if args.plain_http || domain.is_empty() {
            if !args.plain_http && domain.is_empty() {
                bail!("pass --domain <d>, --plain-http, or --behind-proxy (with --domain)");
            }
            AccessMode::PlainHttp
        } else {
            AccessMode::DomainTls
        };
        if access != AccessMode::PlainHttp && !dns::valid_hostname(&domain) {
            bail!("--domain {domain} is not a valid hostname");
        }
        let console_domain = match &args.console_domain {
            Some(c) => c.clone(),
            None if access == AccessMode::PlainHttp => String::new(),
            None => format!("console.{domain}"),
        };
        let email = args
            .email
            .clone()
            .unwrap_or_else(|| envf.get("ACME_EMAIL").unwrap_or_default());
        (access, domain, console_domain, email)
    };

    // Apply to .env; MINT_PUBLIC_URL only seeds first boots — the console owns
    // the wallet-facing URL afterwards, hence the reminder below.
    let public_ip = compose::detect_public_ip();
    let (profiles, bind, mint_public_url) = match access {
        AccessMode::DomainTls => ("tls", "127.0.0.1", format!("https://{domain}")),
        AccessMode::BehindProxy => ("", "127.0.0.1", format!("https://{domain}")),
        AccessMode::PlainHttp => (
            "",
            "0.0.0.0",
            format!(
                "http://{}:{mint_port}",
                public_ip.as_deref().unwrap_or("localhost")
            ),
        ),
    };
    envf.set("COMPOSE_PROFILES", profiles);
    envf.set("BIND_ADDR", bind);
    envf.set("DOMAIN", &domain);
    envf.set("CONSOLE_DOMAIN", &console_domain);
    envf.set("MINT_PUBLIC_URL", &mint_public_url);
    envf.set("ACME_EMAIL", &acme_email);
    envf.save()?;
    caddy::apply_acme_email(&stack.install_dir, &acme_email)?;
    if access == AccessMode::BehindProxy {
        let snippet_plan = snippet_plan(&stack, &domain, &console_domain, ui_port, mint_port);
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
        log::warning(
            "The wallet-facing URL shown to wallets is managed in the console:\n\
             Mint tab → Identity → wallet-facing URL. Update it to match.",
        )?;
        outro("Done.")?;
    } else {
        apply(false)?;
        if !compose::wait_healthy(ui_port, Duration::from_secs(120)) {
            bail!("the console did not come back — check 'mintctl logs processor'");
        }
        crate::ui::say("Access configuration applied.");
        crate::ui::warn(
            "update the wallet-facing URL in the console (Mint tab → Identity) to match",
        );
    }
    Ok(())
}

/// A minimal InstallPlan for snippet rendering on an existing install.
fn snippet_plan(
    stack: &Stack,
    domain: &str,
    console_domain: &str,
    ui_port: u16,
    mint_port: u16,
) -> InstallPlan {
    InstallPlan {
        install_dir: stack.install_dir.clone(),
        version: String::new(),
        no_pull: true,
        access: AccessMode::BehindProxy,
        mint_mode: MintMode::Bundled,
        domain: domain.to_string(),
        console_domain: console_domain.to_string(),
        acme_email: String::new(),
        ui_port,
        mint_port,
        bind_addr: "127.0.0.1".into(),
        grpc_bind_addr: "127.0.0.1".into(),
        grpc_port: 50051,
        public_ip: None,
        admin_password: String::new(),
    }
}

