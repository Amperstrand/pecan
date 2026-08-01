//! Custom Unit Mint — one-command installer and operations CLI.
//!
//! `mintctl` with no arguments (or with install flags) runs the installer;
//! afterwards the same binary, installed into the stack directory, manages
//! the deployment: status / logs / update / backup / restore / start / stop /
//! uninstall / version.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

mod caddy;
mod compose;
mod dns;
mod envfile;
mod install;
mod ops;
mod passphrase;
mod preflight;
mod release;
mod ui;
mod wizard;

#[derive(Parser)]
#[command(
    name = "mintctl",
    about = "Custom Unit Mint — one-command installer and operations CLI",
    long_about = None,
    // --version pins a RELEASE for install (bash parity); the stack's version
    // is reported by the `version` subcommand.
    disable_version_flag = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Bare `mintctl --domain x --yes` installs, exactly like the bash script.
    #[command(flatten)]
    install: InstallArgs,
}

#[derive(Args, Clone, Default)]
pub struct InstallArgs {
    /// Answer every prompt with its default (non-interactive)
    #[arg(long, short = 'y')]
    pub yes: bool,
    /// Serve the mint at https://<domain> via the bundled Caddy
    #[arg(long)]
    pub domain: Option<String>,
    /// Console hostname (default console.<domain>)
    #[arg(long)]
    pub console_domain: Option<String>,
    /// ACME account email for certificate notices
    #[arg(long)]
    pub email: Option<String>,
    /// Install directory (default /opt/custom-unit-mint)
    #[arg(long)]
    pub dir: Option<PathBuf>,
    /// Pin a release instead of resolving the latest
    #[arg(long)]
    pub version: Option<String>,
    /// Host port for the operator console
    #[arg(long, default_value_t = 9090)]
    pub ui_port: u16,
    /// Host port for the mint API
    #[arg(long, default_value_t = 8089)]
    pub mint_port: u16,
    /// Host bind address override
    #[arg(long)]
    pub bind: Option<String>,
    /// Plain HTTP on the app ports (LAN/testing) — no domain, no TLS
    #[arg(long, conflicts_with = "domain")]
    pub plain_http: bool,
    /// Run behind your own reverse proxy: loopback binds + ready-made snippets
    #[arg(long, conflicts_with = "plain_http")]
    pub behind_proxy: bool,
    /// Install the processor only; connect an existing cdk-mintd in the console
    #[arg(long)]
    pub processor_only: bool,
    /// Bind address for the payment gRPC published to an external mint
    /// (default 127.0.0.1; use 0.0.0.0 for a mint on the private network)
    #[arg(long)]
    pub grpc_bind: Option<String>,
    /// Host port for the payment gRPC (second instances need distinct ports)
    #[arg(long, default_value_t = 50051)]
    pub grpc_port: u16,
    /// (testing) Fetch artifacts from this git ref instead of the release tag
    #[arg(long = "ref")]
    pub artifact_ref: Option<String>,
    /// (testing) Copy artifacts from a local checkout
    #[arg(long)]
    pub artifacts_dir: Option<PathBuf>,
    /// (testing) Use a locally built image, skip the pull
    #[arg(long)]
    pub no_pull: bool,
}

#[derive(Args)]
pub struct UpdateArgs {
    /// Update to this release instead of the latest
    #[arg(long)]
    pub version: Option<String>,
    /// Non-interactive
    #[arg(long, short = 'y')]
    pub yes: bool,
    /// (testing) Fetch artifacts from this git ref instead of the release tag
    #[arg(long = "ref")]
    pub artifact_ref: Option<String>,
    /// (testing) Copy artifacts from a local checkout
    #[arg(long)]
    pub artifacts_dir: Option<PathBuf>,
    /// (testing) Skip the image pull
    #[arg(long)]
    pub no_pull: bool,
}

#[derive(Args)]
pub struct DomainArgs {
    /// The mint's public hostname
    #[arg(long)]
    pub domain: Option<String>,
    /// Console hostname (default console.<domain>)
    #[arg(long)]
    pub console_domain: Option<String>,
    /// ACME account email for certificate notices
    #[arg(long)]
    pub email: Option<String>,
    /// Switch to plain HTTP (drop TLS)
    #[arg(long, conflicts_with = "domain")]
    pub plain_http: bool,
    /// Run behind your own reverse proxy (needs --domain)
    #[arg(long, conflicts_with = "plain_http")]
    pub behind_proxy: bool,
    /// Non-interactive: apply the flags without the guided flow
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Install the stack (default when no subcommand is given)
    Install(InstallArgs),
    /// Change how the mint is reached: domain + HTTPS, own proxy, or plain HTTP
    Domain(DomainArgs),
    /// Containers, console health, mint supervisor state, versions
    Status,
    /// Follow service logs (optionally: processor, mint, caddy)
    Logs {
        services: Vec<String>,
    },
    /// Update artifacts + image to a release (default: latest)
    Update(UpdateArgs),
    /// Archive all volumes and .env into a tar.gz (stops services briefly)
    Backup {
        /// Output file (default: ./custom-unit-mint-backup-<stamp>.tar.gz)
        output: Option<PathBuf>,
    },
    /// Replace ALL state from a backup archive
    Restore {
        archive: PathBuf,
        /// Skip the confirmation
        #[arg(long, short = 'y')]
        yes: bool,
    },
    /// Start the stack
    Start,
    /// Stop the stack (containers stay, nothing is removed)
    Stop,
    /// Remove the containers; --purge also deletes volumes and the install dir
    Uninstall {
        /// Also delete ALL volumes (keys, database) and the install directory
        #[arg(long)]
        purge: bool,
        /// Skip the typed confirmation
        #[arg(long, short = 'y')]
        yes: bool,
    },
    /// Installed and latest release versions
    Version,
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        None => install::run(&cli.install),
        Some(Command::Install(args)) => install::run(&args),
        Some(Command::Domain(args)) => wizard::domain_command(&args),
        Some(Command::Status) => ops::status(),
        Some(Command::Logs { services }) => ops::logs(&services),
        Some(Command::Update(args)) => ops::update(&args),
        Some(Command::Backup { output }) => ops::backup(output),
        Some(Command::Restore { archive, yes }) => ops::restore(archive, yes),
        Some(Command::Start) => ops::start(),
        Some(Command::Stop) => ops::stop(),
        Some(Command::Uninstall { purge, yes }) => ops::uninstall(purge, yes),
        Some(Command::Version) => ops::version(),
    };
    if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
