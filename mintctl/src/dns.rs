//! DNS preflight for the domain step: resolve the candidate hostnames against
//! public resolvers (not the host's stub, which caches and lies mid-setup)
//! and compare with the server's detected public IP.

use std::net::IpAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use hickory_resolver::config::{NameServerConfigGroup, ResolverConfig, ResolverOpts};
use hickory_resolver::Resolver;

pub struct DnsCheck {
    pub domain: String,
    pub resolved: Vec<IpAddr>,
    /// True when the detected public IP is among the resolved addresses.
    pub matches: bool,
    /// True when any resolved address belongs to Cloudflare's proxy ranges —
    /// certificates cannot be issued for an orange-clouded record.
    pub behind_cloudflare: bool,
}

fn public_resolver() -> Result<Resolver> {
    let ips = NameServerConfigGroup::from_ips_clear(
        &[IpAddr::from([1, 1, 1, 1]), IpAddr::from([8, 8, 8, 8])],
        53,
        true,
    );
    let mut opts = ResolverOpts::default();
    opts.timeout = Duration::from_secs(4);
    opts.attempts = 1;
    Resolver::new(ResolverConfig::from_parts(None, vec![], ips), opts)
        .context("build DNS resolver")
}

pub fn check(domain: &str, public_ip: Option<&str>) -> Result<DnsCheck> {
    let resolver = public_resolver()?;
    let resolved: Vec<IpAddr> = resolver
        .lookup_ip(format!("{domain}."))
        .map(|lookup| lookup.iter().collect())
        .unwrap_or_default();
    let expected: Option<IpAddr> = public_ip.and_then(|ip| ip.parse().ok());
    Ok(DnsCheck {
        domain: domain.to_string(),
        matches: match expected {
            Some(expected) => resolved.contains(&expected),
            // Without a detected public IP the best we can say is "resolves".
            None => !resolved.is_empty(),
        },
        behind_cloudflare: resolved.iter().any(is_cloudflare),
        resolved,
    })
}

/// AAAA records for the domain from the public resolvers. Advisory only —
/// Let's Encrypt prefers IPv6 when an AAAA exists, so a wrong AAAA breaks
/// certificate issuance even when the A record is perfect.
pub fn lookup_aaaa(domain: &str) -> Vec<IpAddr> {
    let Ok(resolver) = public_resolver() else {
        return Vec::new();
    };
    resolver
        .ipv6_lookup(format!("{domain}."))
        .map(|lookup| lookup.iter().map(|aaaa| IpAddr::V6(aaaa.0)).collect())
        .unwrap_or_default()
}

/// A warning when the domain's AAAA record would sabotage certificate
/// issuance: it exists but does not point at this server's detected IPv6
/// (or the server has no IPv6 egress at all). None = nothing concerning.
pub fn aaaa_advisory(domain: &str, public_ipv6: Option<&str>) -> Option<String> {
    let aaaa = lookup_aaaa(domain);
    if aaaa.is_empty() {
        return None;
    }
    let expected: Option<IpAddr> = public_ipv6.and_then(|ip| ip.parse().ok());
    if let Some(expected) = expected {
        if aaaa.contains(&expected) {
            return None;
        }
    }
    let ips: Vec<String> = aaaa.iter().map(|ip| ip.to_string()).collect();
    let ips = ips.join(", ");
    Some(match expected {
        Some(expected) => format!(
            "{domain} has an AAAA record ({ips}) that is not this server's \
             IPv6 ({expected}). Let's Encrypt prefers IPv6 when an AAAA exists — \
             fix or remove that record, or certificate issuance may fail."
        ),
        None => format!(
            "{domain} has an AAAA record ({ips}), but this server shows no IPv6 \
             egress. Let's Encrypt prefers IPv6 when an AAAA exists — remove the \
             record unless IPv6 to this server really works."
        ),
    })
}

/// Cloudflare's published proxy IPv4 ranges (https://www.cloudflare.com/ips/),
/// as (network, prefix_len). Enough to warn about orange-cloud records.
const CLOUDFLARE_V4: &[([u8; 4], u8)] = &[
    ([173, 245, 48, 0], 20),
    ([103, 21, 244, 0], 22),
    ([103, 22, 200, 0], 22),
    ([103, 31, 4, 0], 22),
    ([141, 101, 64, 0], 18),
    ([108, 162, 192, 0], 18),
    ([190, 93, 240, 0], 20),
    ([188, 114, 96, 0], 20),
    ([197, 234, 240, 0], 22),
    ([198, 41, 128, 0], 17),
    ([162, 158, 0, 0], 15),
    ([104, 16, 0, 0], 13),
    ([172, 64, 0, 0], 13),
    ([131, 0, 72, 0], 22),
];

fn is_cloudflare(ip: &IpAddr) -> bool {
    let IpAddr::V4(v4) = ip else {
        // The v6 ranges 2400:cb00::/32 etc. — match the two common prefixes.
        let IpAddr::V6(v6) = ip else { return false };
        let seg = v6.segments();
        return seg[0] == 0x2400 && seg[1] == 0xcb00
            || seg[0] == 0x2606 && seg[1] == 0x4700
            || seg[0] == 0x2803 && seg[1] == 0xf800;
    };
    let addr = u32::from_be_bytes(v4.octets());
    CLOUDFLARE_V4.iter().any(|(net, prefix)| {
        let net = u32::from_be_bytes(*net);
        let mask = if *prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
        addr & mask == net & mask
    })
}

/// Hostname shape check: lowercase labels, digits, hyphens, at least one dot.
pub fn valid_hostname(host: &str) -> bool {
    if host.len() > 253 || !host.contains('.') {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostname_validation() {
        assert!(valid_hostname("mint.example.org"));
        assert!(valid_hostname("a-1.b-2.example"));
        assert!(!valid_hostname("nodots"));
        assert!(!valid_hostname("Upper.Case.Org"));
        assert!(!valid_hostname("-bad.example.org"));
        assert!(!valid_hostname("bad-.example.org"));
        assert!(!valid_hostname("bad..example.org"));
        assert!(!valid_hostname(&format!("{}.org", "a".repeat(260))));
    }

    #[test]
    fn cloudflare_ranges_match() {
        assert!(is_cloudflare(&"104.16.132.229".parse().unwrap()));
        assert!(is_cloudflare(&"172.67.68.228".parse().unwrap()));
        assert!(!is_cloudflare(&"79.197.12.186".parse().unwrap()));
        assert!(!is_cloudflare(&"127.0.0.1".parse().unwrap()));
        assert!(is_cloudflare(&"2606:4700::6810:84e5".parse().unwrap()));
        assert!(!is_cloudflare(&"2001:db8::1".parse().unwrap()));
    }
}
