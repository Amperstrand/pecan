//! Caddyfile handling. The deployed Caddyfile ships as a release artifact and
//! is env-placeholder driven; mintctl's only edit is prepending the ACME
//! account email global block. (The guided wizard renders BYO-proxy snippets
//! from here as well.)

use std::path::Path;

use anyhow::{Context, Result};

/// Prepend `{ email ... }` unless a global block already exists
/// (bash `apply_acme_email` parity).
pub fn apply_acme_email(install_dir: &Path, email: &str) -> Result<()> {
    if email.is_empty() {
        return Ok(());
    }
    let caddyfile = install_dir.join("Caddyfile");
    let Ok(current) = std::fs::read_to_string(&caddyfile) else {
        return Ok(());
    };
    if current.lines().any(|line| line.trim_end() == "{") {
        return Ok(());
    }
    let updated = format!("{{\n\temail {email}\n}}\n\n{current}");
    let tmp = caddyfile.with_extension("tmp");
    std::fs::write(&tmp, updated).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &caddyfile).with_context(|| format!("replace {}", caddyfile.display()))?;
    Ok(())
}

/// Ready-to-paste server blocks for an operator-owned reverse proxy
/// (behind-proxy mode): the app binds loopback; their proxy terminates TLS.
/// The X-Forwarded-Proto header is what makes session cookies `Secure`;
/// SSE (/events) must stream unbuffered.
pub fn write_proxy_snippets(plan: &crate::install::InstallPlan) -> Result<()> {
    let dir = plan.install_dir.join("proxy-snippets");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    std::fs::write(dir.join("Caddyfile.snippet"), caddy_snippet(plan))?;
    std::fs::write(dir.join("nginx.conf.snippet"), nginx_snippet(plan))?;
    Ok(())
}

pub fn caddy_snippet(plan: &crate::install::InstallPlan) -> String {
    format!(
        "# Custom Unit Mint behind your Caddy — paste into your Caddyfile.\n\
         # Caddy forwards X-Forwarded-Proto and streams SSE by itself;\n\
         # flush_interval -1 makes the SSE behavior explicit.\n\
         {domain} {{\n\
         \treverse_proxy 127.0.0.1:{mint_port}\n\
         }}\n\
         \n\
         {console} {{\n\
         \treverse_proxy 127.0.0.1:{ui_port} {{\n\
         \t\tflush_interval -1\n\
         \t}}\n\
         }}\n",
        domain = plan.domain,
        console = plan.console_domain,
        mint_port = plan.mint_port,
        ui_port = plan.ui_port,
    )
}

pub fn nginx_snippet(plan: &crate::install::InstallPlan) -> String {
    format!(
        "# Custom Unit Mint behind nginx — one server block per hostname.\n\
         # Certificates are your proxy's responsibility (certbot etc.).\n\
         server {{\n\
         \tlisten 443 ssl;\n\
         \tserver_name {domain};\n\
         \t# ssl_certificate / ssl_certificate_key ...\n\
         \tlocation / {{\n\
         \t\tproxy_pass http://127.0.0.1:{mint_port};\n\
         \t\tproxy_set_header Host $host;\n\
         \t\tproxy_set_header X-Forwarded-Proto $scheme;\n\
         \t}}\n\
         }}\n\
         \n\
         server {{\n\
         \tlisten 443 ssl;\n\
         \tserver_name {console};\n\
         \t# ssl_certificate / ssl_certificate_key ...\n\
         \tlocation / {{\n\
         \t\tproxy_pass http://127.0.0.1:{ui_port};\n\
         \t\tproxy_set_header Host $host;\n\
         \t\tproxy_set_header X-Forwarded-Proto $scheme;\n\
         \t\t# Server-sent events (/events): stream, don't buffer.\n\
         \t\tproxy_http_version 1.1;\n\
         \t\tproxy_set_header Connection \"\";\n\
         \t\tproxy_buffering off;\n\
         \t\tproxy_read_timeout 1h;\n\
         \t}}\n\
         }}\n",
        domain = plan.domain,
        console = plan.console_domain,
        mint_port = plan.mint_port,
        ui_port = plan.ui_port,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_email_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("Caddyfile");
        std::fs::write(&path, "{$DOMAIN} {\n\treverse_proxy mint:8089\n}\n").expect("write");
        apply_acme_email(dir.path(), "ops@example.org").expect("apply");
        let out = std::fs::read_to_string(&path).expect("read");
        assert!(out.starts_with("{\n\temail ops@example.org\n}\n\n"));
        // Second run: a global block now exists, nothing changes.
        apply_acme_email(dir.path(), "other@example.org").expect("apply again");
        let again = std::fs::read_to_string(&path).expect("read");
        assert_eq!(out, again);
    }

    #[test]
    fn empty_email_and_missing_file_are_no_ops() {
        let dir = tempfile::tempdir().expect("tempdir");
        apply_acme_email(dir.path(), "").expect("empty email");
        apply_acme_email(dir.path(), "ops@example.org").expect("missing file");
        assert!(!dir.path().join("Caddyfile").exists());
    }
}
