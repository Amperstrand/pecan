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
}
