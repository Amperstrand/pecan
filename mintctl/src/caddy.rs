//! Caddyfile handling. The deployed Caddyfile ships as a release artifact and
//! is env-placeholder driven; mintctl's edits are the ACME account email
//! global block and (for bundled-mint installs) a marker-delimited mint site
//! block. Both are re-applied after `mintctl update` replaces the artifact.
//! (The guided wizard renders BYO-proxy snippets from here as well.)

use std::path::Path;

use anyhow::{Context, Result};

const MINT_SITE_BEGIN: &str = "# --- pecan:mint-site (managed by mintctl; do not edit) ---";
const MINT_SITE_END: &str = "# --- pecan:end-mint-site ---";

/// Set (or clear, with an empty email) the ACME account email. A global
/// block mintctl wrote earlier is updated in place; a foreign global block
/// gets the email directive inserted/updated inside it.
pub fn apply_acme_email(install_dir: &Path, email: &str) -> Result<()> {
    let caddyfile = install_dir.join("Caddyfile");
    let Ok(current) = std::fs::read_to_string(&caddyfile) else {
        return Ok(());
    };
    let updated = apply_acme_email_text(&current, email);
    if updated != current {
        write_atomic(&caddyfile, &updated)?;
    }
    Ok(())
}

fn apply_acme_email_text(current: &str, email: &str) -> String {
    let lines: Vec<&str> = current.lines().collect();
    // A global options block can only be the first non-comment, non-empty
    // construct in a Caddyfile.
    let block_start = lines
        .iter()
        .position(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'));
    let has_global_block = block_start.is_some_and(|i| lines[i].trim_end() == "{");

    if !has_global_block {
        if email.is_empty() {
            return current.to_string();
        }
        return format!("{{\n\temail {email}\n}}\n\n{current}");
    }

    let start = block_start.expect("checked above");
    let end = lines[start..]
        .iter()
        .position(|l| l.trim_end() == "}")
        .map(|offset| start + offset);
    let Some(end) = end else {
        // Unbalanced file — leave it alone rather than corrupt it.
        return current.to_string();
    };
    let mut block: Vec<String> = lines[start + 1..end].iter().map(|l| l.to_string()).collect();
    block.retain(|l| {
        let t = l.trim_start();
        !(t == "email" || t.starts_with("email ") || t.starts_with("email\t"))
    });
    if block.is_empty() && email.is_empty() {
        // The block was only ours; drop it (and one following blank line).
        let mut rest: Vec<&str> = lines[end + 1..].to_vec();
        if rest.first().is_some_and(|l| l.trim().is_empty()) {
            rest.remove(0);
        }
        let mut out = lines[..start].join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&rest.join("\n"));
        ensure_trailing_newline(out)
    } else {
        if !email.is_empty() {
            block.insert(0, format!("\temail {email}"));
        }
        let mut out_lines: Vec<String> = lines[..start].iter().map(|l| l.to_string()).collect();
        out_lines.push("{".into());
        out_lines.extend(block);
        out_lines.push("}".into());
        out_lines.extend(lines[end + 1..].iter().map(|l| l.to_string()));
        ensure_trailing_newline(out_lines.join("\n"))
    }
}

/// Idempotently add or remove the bundled mint's site block
/// (`{$MINT_DOMAIN} → mintd:8085`) between the marker comments.
pub fn apply_mint_site(install_dir: &Path, enabled: bool) -> Result<()> {
    let caddyfile = install_dir.join("Caddyfile");
    let Ok(current) = std::fs::read_to_string(&caddyfile) else {
        return Ok(());
    };
    let stripped = strip_mint_site(&current);
    let updated = if enabled {
        format!(
            "{}\n{MINT_SITE_BEGIN}\n{{$MINT_DOMAIN}} {{\n\treverse_proxy mintd:8085\n}}\n{MINT_SITE_END}\n",
            stripped.trim_end()
        )
    } else {
        stripped
    };
    if updated != current {
        write_atomic(&caddyfile, &updated)?;
    }
    Ok(())
}

fn strip_mint_site(current: &str) -> String {
    let Some(begin) = current.find(MINT_SITE_BEGIN) else {
        return current.to_string();
    };
    let after_begin = &current[begin..];
    let Some(end_offset) = after_begin.find(MINT_SITE_END) else {
        return current.to_string();
    };
    let mut tail = &after_begin[end_offset + MINT_SITE_END.len()..];
    tail = tail.strip_prefix('\n').unwrap_or(tail);
    let head = current[..begin].trim_end();
    if head.is_empty() {
        tail.to_string()
    } else {
        ensure_trailing_newline(format!("{head}\n{tail}"))
    }
}

fn ensure_trailing_newline(mut s: String) -> String {
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

/// Ready-to-paste server blocks for an operator-owned reverse proxy
/// (behind-proxy mode): the console binds loopback; their proxy terminates
/// TLS. The X-Forwarded-Proto header is what makes session cookies `Secure`;
/// SSE (/events) must stream unbuffered. The payment gRPC is NOT proxied —
/// the mint connects to it directly. A bundled mint gets its own plain
/// reverse-proxy block per hostname.
pub fn write_proxy_snippets(plan: &crate::install::InstallPlan) -> Result<()> {
    let dir = plan.install_dir.join("proxy-snippets");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    std::fs::write(dir.join("Caddyfile.snippet"), caddy_snippet(plan))?;
    std::fs::write(dir.join("nginx.conf.snippet"), nginx_snippet(plan))?;
    Ok(())
}

pub fn caddy_snippet(plan: &crate::install::InstallPlan) -> String {
    let mut out = format!(
        "# Branch processor console behind your Caddy — paste into your Caddyfile.\n\
         # Caddy forwards X-Forwarded-Proto and streams SSE by itself;\n\
         # flush_interval -1 makes the SSE behavior explicit.\n\
         # (The payment gRPC is not proxied; the mint connects to it directly.)\n\
         {console} {{\n\
         \treverse_proxy 127.0.0.1:{ui_port} {{\n\
         \t\tflush_interval -1\n\
         \t}}\n\
         }}\n",
        console = plan.console_domain,
        ui_port = plan.ui_port,
    );
    if let Some(mint_plan) = &plan.mint {
        out.push_str(&format!(
            "\n# The bundled mint (wallets connect here).\n\
             {mint_domain} {{\n\
             \treverse_proxy 127.0.0.1:{mint_port}\n\
             }}\n",
            mint_domain = mint_plan.mint_domain,
            mint_port = mint_plan.mint_port,
        ));
    }
    out
}

pub fn nginx_snippet(plan: &crate::install::InstallPlan) -> String {
    let mut out = format!(
        "# Branch processor console behind nginx.\n\
         # Certificates are your proxy's responsibility (certbot etc.).\n\
         # (The payment gRPC is not proxied; the mint connects to it directly.)\n\
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
        console = plan.console_domain,
        ui_port = plan.ui_port,
    );
    if let Some(mint_plan) = &plan.mint {
        out.push_str(&format!(
            "\n# The bundled mint (wallets connect here).\n\
             server {{\n\
             \tlisten 443 ssl;\n\
             \tserver_name {mint_domain};\n\
             \t# ssl_certificate / ssl_certificate_key ...\n\
             \tlocation / {{\n\
             \t\tproxy_pass http://127.0.0.1:{mint_port};\n\
             \t\tproxy_set_header Host $host;\n\
             \t\tproxy_set_header X-Forwarded-Proto $scheme;\n\
             \t}}\n\
             }}\n",
            mint_domain = mint_plan.mint_domain,
            mint_port = mint_plan.mint_port,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepends_email_and_can_change_it_later() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("Caddyfile");
        std::fs::write(&path, "{$DOMAIN} {\n\treverse_proxy mint:8089\n}\n").expect("write");
        apply_acme_email(dir.path(), "ops@example.org").expect("apply");
        let out = std::fs::read_to_string(&path).expect("read");
        assert!(out.starts_with("{\n\temail ops@example.org\n}\n\n"));
        // Changing the email actually changes it (the pre-0.3 bug).
        apply_acme_email(dir.path(), "other@example.org").expect("apply again");
        let again = std::fs::read_to_string(&path).expect("read");
        assert!(again.starts_with("{\n\temail other@example.org\n}\n"));
        assert!(!again.contains("ops@example.org"));
        // Clearing removes the (now empty) global block.
        apply_acme_email(dir.path(), "").expect("clear");
        let cleared = std::fs::read_to_string(&path).expect("read");
        assert!(cleared.starts_with("{$DOMAIN} {"));
    }

    #[test]
    fn foreign_global_block_keeps_its_directives() {
        let current = "{\n\tdebug\n}\n\n{$DOMAIN} {\n}\n";
        let updated = apply_acme_email_text(current, "ops@example.org");
        assert!(updated.contains("\tdebug"));
        assert!(updated.contains("\temail ops@example.org"));
        // Clearing the email keeps the foreign directive and the block.
        let cleared = apply_acme_email_text(&updated, "");
        assert!(cleared.contains("\tdebug"));
        assert!(!cleared.contains("email"));
    }

    #[test]
    fn leading_comments_do_not_count_as_a_global_block() {
        let current = "# comment\n\n{$DOMAIN} {\n}\n";
        let updated = apply_acme_email_text(current, "ops@example.org");
        assert!(updated.starts_with("{\n\temail ops@example.org\n}\n\n# comment"));
    }

    #[test]
    fn empty_email_and_missing_file_are_no_ops() {
        let dir = tempfile::tempdir().expect("tempdir");
        apply_acme_email(dir.path(), "").expect("empty email");
        apply_acme_email(dir.path(), "ops@example.org").expect("missing file");
        assert!(!dir.path().join("Caddyfile").exists());
    }

    #[test]
    fn mint_site_block_is_idempotent_and_removable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("Caddyfile");
        let base = "{$CONSOLE_DOMAIN} {\n\treverse_proxy processor:9090\n}\n";
        std::fs::write(&path, base).expect("write");
        apply_mint_site(dir.path(), true).expect("enable");
        let with_site = std::fs::read_to_string(&path).expect("read");
        assert!(with_site.contains("{$MINT_DOMAIN}"));
        assert!(with_site.contains("reverse_proxy mintd:8085"));
        // Enabling twice adds exactly one block.
        apply_mint_site(dir.path(), true).expect("enable again");
        let again = std::fs::read_to_string(&path).expect("read");
        assert_eq!(again.matches("{$MINT_DOMAIN}").count(), 1);
        // Disabling strips exactly the managed block.
        apply_mint_site(dir.path(), false).expect("disable");
        let stripped = std::fs::read_to_string(&path).expect("read");
        assert!(!stripped.contains("MINT_DOMAIN"));
        assert!(stripped.contains("{$CONSOLE_DOMAIN}"));
    }

    #[test]
    fn mint_site_survives_email_reapplication() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("Caddyfile");
        std::fs::write(&path, "{$CONSOLE_DOMAIN} {\n}\n").expect("write");
        apply_mint_site(dir.path(), true).expect("enable");
        apply_acme_email(dir.path(), "ops@example.org").expect("email");
        let out = std::fs::read_to_string(&path).expect("read");
        assert!(out.starts_with("{\n\temail ops@example.org\n}\n"));
        assert_eq!(out.matches("{$MINT_DOMAIN}").count(), 1);
    }
}
