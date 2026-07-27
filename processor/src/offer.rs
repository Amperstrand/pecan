//! NUT-XX quote offer construction and serialization.
//!
//! A quote offer is handed to the wallet (QR / copy-paste) and encodes
//! everything the wallet needs to claim a mint or melt quote for itself:
//! `"cquote" + "A" + base64_urlsafe(CBOR({m, o, h, u, t, a, d, e}))`.
//!
//! The CBOR is a definite-length map written in the spec's field order
//! (m, o, h, u, a, t, d, e) so encoding is deterministic. Hand-rolled to keep
//! the dependency tree unchanged — the value shapes are only text strings and
//! unsigned integers.

pub struct QuoteOffer {
    /// Mint URL (`m`).
    pub mint_url: String,
    /// `"mint"` or `"melt"` (`o`).
    pub operation: &'static str,
    /// Payment method (`h`).
    pub method: String,
    /// Unit (`u`).
    pub unit: String,
    /// Ticket id (`t`).
    pub ticket: String,
    /// Amount (`a`).
    pub amount: Option<u64>,
    /// Human readable description (`d`).
    pub description: Option<String>,
    /// Unix timestamp until which the offer can be claimed (`e`).
    pub expiry: Option<u64>,
}

impl QuoteOffer {
    pub fn encode(&self) -> String {
        let mut pairs: Vec<(&str, CborValue)> = vec![
            ("m", CborValue::Text(&self.mint_url)),
            ("o", CborValue::Text(self.operation)),
            ("h", CborValue::Text(&self.method)),
            ("u", CborValue::Text(&self.unit)),
        ];
        if let Some(a) = self.amount {
            pairs.push(("a", CborValue::Uint(a)));
        }
        pairs.push(("t", CborValue::Text(&self.ticket)));
        if let Some(d) = self.description.as_deref() {
            pairs.push(("d", CborValue::Text(d)));
        }
        if let Some(e) = self.expiry {
            pairs.push(("e", CborValue::Uint(e)));
        }

        let mut out = Vec::new();
        cbor_head(&mut out, 5, pairs.len() as u64);
        for (key, value) in pairs {
            cbor_text(&mut out, key);
            match value {
                CborValue::Text(s) => cbor_text(&mut out, s),
                CborValue::Uint(v) => cbor_head(&mut out, 0, v),
            }
        }

        format!("cquoteA{}", base64url_nopad(&out))
    }
}

enum CborValue<'a> {
    Text(&'a str),
    Uint(u64),
}

fn cbor_head(out: &mut Vec<u8>, major: u8, value: u64) {
    let major = major << 5;
    match value {
        0..=23 => out.push(major | value as u8),
        24..=0xFF => {
            out.push(major | 24);
            out.push(value as u8);
        }
        0x100..=0xFFFF => {
            out.push(major | 25);
            out.extend_from_slice(&(value as u16).to_be_bytes());
        }
        0x1_0000..=0xFFFF_FFFF => {
            out.push(major | 26);
            out.extend_from_slice(&(value as u32).to_be_bytes());
        }
        _ => {
            out.push(major | 27);
            out.extend_from_slice(&value.to_be_bytes());
        }
    }
}

fn cbor_text(out: &mut Vec<u8>, s: &str) {
    cbor_head(out, 3, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn base64url_nopad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example offer from the NUT-XX spec must encode byte-exact.
    #[test]
    fn encodes_spec_example() {
        let offer = QuoteOffer {
            mint_url: "https://mint.example.com".to_string(),
            operation: "mint",
            method: "branch".to_string(),
            unit: "ora".to_string(),
            ticket: "0198c0ef-3f11-7000-a3f7-2f4b6e2d9c1a".to_string(),
            amount: Some(500),
            description: Some("Cash deposit".to_string()),
            expiry: None,
        };
        assert_eq!(
            offer.encode(),
            "cquoteAp2FteBhodHRwczovL21pbnQuZXhhbXBsZS5jb21hb2RtaW50YWhmYnJhbmNoYXVjb3JhYWEZAfRhdHgkMDE5OGMwZWYtM2YxMS03MDAwLWEzZjctMmY0YjZlMmQ5YzFhYWRsQ2FzaCBkZXBvc2l0"
        );
    }

    #[test]
    fn encodes_all_fields() {
        let offer = QuoteOffer {
            mint_url: "https://m.example".to_string(),
            operation: "melt",
            method: "branch".to_string(),
            unit: "ora".to_string(),
            ticket: "t-1".to_string(),
            amount: Some(70000),
            description: None,
            expiry: Some(1_900_000_000),
        };
        let encoded = offer.encode();
        assert!(encoded.starts_with("cquoteA"));
        assert!(!encoded.contains('='));
    }
}
