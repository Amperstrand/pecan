//! Payout rails: melt destinations can name the rail that should fulfill
//! them. There are hundreds of real-world payout rails (bank transfer,
//! mobile payment, wire); each gets an adapter, and a deployment enables
//! the subset it actually operates. The wallet expresses the choice in
//! the melt request text as `rail:destination` — e.g. `sim:ALIAS`,
//! `sepa:DE89...` — and the processor turns that into an explicit,
//! validated rail on the ticket so only the right adapter ever acts on
//! it. Plain destination text (no envelope) stays a human-teller memo.

use std::collections::HashSet;

/// A melt destination that names its payout rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayoutRequest {
    pub rail: String,
    pub destination: String,
}

/// Parses `rail:destination` from a melt request. Rail ids are lowercase
/// `[a-z][a-z0-9-]{1,23}` so they cannot be confused with free-text
/// memos that merely contain a colon (times, IBAN-less notes), and the
/// destination must be non-empty. Anything else is `None` — a plain
/// teller memo, not a routing decision.
pub fn parse_payout_envelope(request: &str) -> Option<PayoutRequest> {
    let trimmed = request.trim();
    let (rail, destination) = trimmed.split_once(':')?;
    if !valid_rail_id(rail) || destination.trim().is_empty() {
        return None;
    }
    Some(PayoutRequest {
        rail: rail.to_string(),
        destination: destination.trim().to_string(),
    })
}

/// A rail id a deployment may enable: lowercase, starts with a letter,
/// 2-24 chars of `[a-z0-9-]`.
pub fn valid_rail_id(rail: &str) -> bool {
    let bytes = rail.as_bytes();
    if !(2..=24).contains(&bytes.len()) {
        return false;
    }
    let starts_letter = bytes[0].is_ascii_lowercase();
    let body_ok = bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
    starts_letter && body_ok
}

/// Parses the enabled-rail list from `CDK_BRANCH_PROCESSOR_PAYOUT_RAILS`
/// (comma-separated). Empty means teller-only — every enveloped melt is
/// refused, which is the safe default for a deployment with no adapters.
pub fn rails_from_config(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|rail| valid_rail_id(rail))
        .map(str::to_string)
        .collect()
}

/// The simulated rail set: destination validation and receipt formats for
/// every rail this deployment can auto-settle (the demo mode and the
/// python adapters share these semantics; the Rust side is authoritative
/// at quote time).
pub const SIMULATED_RAILS: &[&str] = &[
    "sim",
    "sepa",
    "sepa-instant",
    "swish",
    "mobilepay",
    "ideal",
    "bizum",
];

fn valid_msisdn(dest: &str, prefixes: &[&str]) -> bool {
    let digits = dest.strip_prefix('+').unwrap_or("");
    (7..=16).contains(&dest.len())
        && !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && prefixes.iter().any(|p| dest.starts_with(p))
}

/// ISO 13616 IBAN check: rearranged mod 97 (ISO 7064 MOD 97-10), computed
/// incrementally so no bignum is needed.
pub fn valid_iban(raw: &str) -> bool {
    let s: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase();
    let bytes = s.as_bytes();
    if !(15..=34).contains(&bytes.len())
        || !bytes.iter().all(|b| b.is_ascii_alphanumeric())
        || !bytes[..2].iter().all(|b| b.is_ascii_alphabetic())
        || !bytes[2..4].iter().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    let rearranged: String = format!("{}{}", &s[4..], &s[..4]);
    let mut rem: u64 = 0;
    for c in rearranged.chars() {
        let v = if c.is_ascii_digit() {
            c as u64 - '0' as u64
        } else {
            c as u64 - 'A' as u64 + 10
        };
        if c.is_ascii_alphabetic() {
            rem = (rem * 100 + v) % 97;
        } else {
            rem = (rem * 10 + v) % 97;
        }
    }
    rem == 1
}

/// Destination validation per rail — enforced at melt-quote time so an
/// invalid destination never becomes a ticket.
pub fn valid_destination(rail: &str, dest: &str) -> bool {
    match rail {
        "sim" => !dest.trim().is_empty(),
        "sepa" | "sepa-instant" => valid_iban(dest),
        "ideal" => valid_iban(dest) && dest.replace(' ', "").to_uppercase().starts_with("NL"),
        "swish" => valid_msisdn(dest, &["+46"]),
        "mobilepay" => valid_msisdn(dest, &["+45", "+358"]),
        "bizum" => valid_msisdn(dest, &["+34"]),
        // The EV rail addresses a charger by device slug (atom1,
        // t-relay-r3). Unlike the simulated rails this one settles through
        // the ev-charge adapter against real hardware — it must never be
        // added to SIMULATED_RAILS or autosimmed.
        "ev" => valid_device_slug(dest),
        _ => false,
    }
}

/// Charger/device slug: letters, digits, dashes and underscores, 3-24
/// chars, starting alphanumeric — the evmap fleet names chargers like
/// `atomA`, `atomB`, `t-relay_r3`. The slug is the adapter's device key
/// (mapped to a gateway device id by the ev-charge adapter's --device-map).
fn valid_device_slug(dest: &str) -> bool {
    let len = dest.len();
    (3..=24).contains(&len)
        && dest.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
        })
        && dest.as_bytes().first().is_some_and(|b| b.is_ascii_alphanumeric())
}

/// Settling delay per simulated rail — the demo's stand-in for scheme
/// latency (SEPA batch vs instant rails).
pub fn settle_delay_ms(rail: &str) -> Option<u64> {
    Some(match rail {
        "sim" => 800,
        "sepa" => 2000,
        "sepa-instant" => 500,
        "swish" | "mobilepay" | "bizum" => 600,
        "ideal" => 1000,
        _ => return None,
    })
}

fn digits(n: usize) -> String {
    use rand::Rng;
    (0..n)
        .map(|_| char::from(b'0' + rand::thread_rng().gen_range(0..10)))
        .collect()
}

/// yymmdd UTC from the Unix clock (Howard Hinnant's civil-from-days).
fn yymmdd_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:02}{:02}{:02}", y.rem_euclid(100), m, d)
}

/// Receipt reference per rail — the payout-proof analogue of a Lightning
/// preimage, in the format the real scheme issues.
pub fn receipt_for_rail(rail: &str) -> Option<String> {
    use rand::Rng;
    Some(match rail {
        "sim" => format!("SIM-{:08X}", rand::thread_rng().gen::<u32>()),
        "sepa" => format!(
            "E2E-{}-{:08X}",
            yymmdd_now(),
            rand::thread_rng().gen::<u32>()
        ),
        "sepa-instant" => uuid::Uuid::new_v4().to_string(),
        "swish" => uuid::Uuid::new_v4().simple().to_string(),
        "mobilepay" => format!("MP-{}", digits(10)),
        "ideal" => digits(16),
        "bizum" => format!("BZ{}", digits(10)),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rail_and_destination() {
        assert_eq!(
            parse_payout_envelope("sim:ALIAS-1"),
            Some(PayoutRequest {
                rail: "sim".into(),
                destination: "ALIAS-1".into()
            })
        );
        assert_eq!(
            parse_payout_envelope("  sepa:DE89 3704 0044 0532 0130 00 "),
            Some(PayoutRequest {
                rail: "sepa".into(),
                destination: "DE89 3704 0044 0532 0130 00".into()
            })
        );
        // Envelope edges: the quote-time gate must reject the shapes a
        // confused wallet could produce — no colon, empty destination,
        // unknown rail, whitespace-only, case-mismatched rail.
        assert_eq!(parse_payout_envelope("no-envelope"), None);
        assert_eq!(parse_payout_envelope("ev:"), None);
        assert_eq!(parse_payout_envelope("ev:   "), None);
        // An unoperated-but-well-formed rail still parses: the envelope
        // grammar and the deployment's rail gate are separate layers
        // (backend::tests::melt_quote_gates_payout_rails pins the gate).
        assert_eq!(
            parse_payout_envelope("nope:whatever"),
            Some(PayoutRequest {
                rail: "nope".into(),
                destination: "whatever".into()
            })
        );
        assert_eq!(parse_payout_envelope("EV:atomA"), None);
        assert_eq!(parse_payout_envelope(""), None);
        // The destination keeps interior structure; only the envelope's
        // edges are trimmed.
        let inner = parse_payout_envelope("  ev:atom-1  ").unwrap();
        assert_eq!(inner.destination, "atom-1");
    }

    #[test]
    fn plain_memos_are_not_envelopes() {
        assert_eq!(parse_payout_envelope("e2e-recipient"), None);
        assert_eq!(parse_payout_envelope("202-555-0173"), None);
        assert_eq!(parse_payout_envelope("meet at 12:30"), None);
        assert_eq!(parse_payout_envelope(""), None);
        assert_eq!(parse_payout_envelope("sim:"), None);
        assert_eq!(parse_payout_envelope(":"), None);
    }

    #[test]
    fn rail_ids_are_limited_to_the_envelope_grammar() {
        assert!(!valid_rail_id("S")); // too short, uppercase
        assert!(!valid_rail_id("Sim"));
        assert!(!valid_rail_id("1st")); // must start with a letter
        assert!(!valid_rail_id("has_underscore"));
        assert!(!valid_rail_id(&"x".repeat(25)));
        assert!(valid_rail_id("sim"));
        assert!(valid_rail_id("mobile-pay"));
        assert!(valid_rail_id("sepa"));
    }

    #[test]
    fn config_parsing_drops_invalid_entries() {
        let rails = rails_from_config(" sim , BAD , sepa ,, ");
        assert!(rails.contains("sim"));
        assert!(rails.contains("sepa"));
        assert!(!rails.contains("BAD"));
        assert_eq!(rails.len(), 2);
        assert!(rails_from_config("").is_empty());
    }

    #[test]
    fn iban_validation_accepts_real_and_rejects_broken() {
        for iban in [
            "NL33INGB0000000881",
            "DE96370205000003292912",
            "IT71P0501803200000011184009",
            "NL33 INGB 0000 0008 81",
        ] {
            assert!(valid_iban(iban), "{iban}");
        }
        // pleBank's checksum-invalid ES fixture must fail here too.
        assert!(!valid_iban("ES57018223704000185702009"));
        assert!(!valid_iban("NOTANIBAN"));
        assert!(!valid_iban(""));
    }

    #[test]
    fn destination_validation_matches_each_scheme() {
        assert!(valid_destination("sim", "alias-1"));
        assert!(!valid_destination("sim", "  "));
        assert!(valid_destination("ideal", "NL33INGB0000000881"));
        assert!(!valid_destination("ideal", "DE96370205000003292912"));
        assert!(valid_destination("swish", "+46700000001"));
        assert!(!valid_destination("swish", "+4712345678"));
        assert!(valid_destination("mobilepay", "+45700000002"));
        assert!(valid_destination("mobilepay", "+358401234567"));
        assert!(!valid_destination("mobilepay", "+4612345678"));
        assert!(valid_destination("bizum", "+34600000003"));
        assert!(!valid_destination("bizum", "+44700000004"));
        // The EV rail addresses chargers by device slug (the evmap fleet
        // names them atomA, atomB, t-relay_r3); a malformed slug never
        // becomes a ticket the adapter would have to refuse later.
        assert!(valid_destination("ev", "atomA"));
        assert!(valid_destination("ev", "atomB"));
        assert!(valid_destination("ev", "t-relay_r3"));
        assert!(!valid_destination("ev", "x"));
        assert!(!valid_destination("ev", "-leading-dash"));
        assert!(!valid_destination("ev", "has space"));
        assert!(!valid_destination("unknown-rail", "anything"));
    }

    #[test]
    fn receipts_match_scheme_formats() {
        assert!(receipt_for_rail("sim").unwrap().starts_with("SIM-"));
        let e2e = receipt_for_rail("sepa").unwrap();
        assert_eq!(e2e.len(), "E2E-".len() + 7 + 8);
        assert!(e2e.starts_with("E2E-"));
        assert!(receipt_for_rail("sepa-instant")
            .unwrap()
            .parse::<uuid::Uuid>()
            .is_ok());
        assert_eq!(receipt_for_rail("swish").unwrap().len(), 32);
        assert!(receipt_for_rail("mobilepay")
            .unwrap()
            .strip_prefix("MP-")
            .is_some_and(|d| d.len() == 10 && d.bytes().all(|b| b.is_ascii_digit())));
        assert_eq!(receipt_for_rail("ideal").unwrap().len(), 16);
        let bz = receipt_for_rail("bizum").unwrap();
        assert!(bz.starts_with("BZ") && bz.len() == 12);
        assert!(receipt_for_rail("wire").is_none());
        assert!(settle_delay_ms("sepa") > settle_delay_ms("sepa-instant"));
        assert!(settle_delay_ms("teller-none").is_none());
    }
}
