//! Operator-facing charger fleet status, proxied from the atom-gateway.
//!
//! The gateway's device contract authenticates with a shared key
//! (X-API-Key) which must never reach the browser — the processor
//! queries the gateway server-side and re-serves a read-only summary
//! for the console's Mint tab, mirroring how the chain-backend card
//! surfaces the owned bitcoind's health.
//!
//! Env (all three required, otherwise the fleet surface stays off):
//!   CDK_BRANCH_PROCESSOR_EV_FLEET       comma-separated device ids
//!   CDK_BRANCH_PROCESSOR_EV_GATEWAY_URL e.g. http://127.0.0.1:8099
//!   CDK_BRANCH_PROCESSOR_EV_GATEWAY_KEY the atom-gateway bridge key

use serde::Serialize;
use std::time::Duration;

#[derive(Clone)]
pub struct FleetConfig {
    url: String,
    key: String,
    devices: Vec<String>,
}

impl FleetConfig {
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("CDK_BRANCH_PROCESSOR_EV_GATEWAY_URL").ok()?;
        let key = std::env::var("CDK_BRANCH_PROCESSOR_EV_GATEWAY_KEY").ok()?;
        let devices = parse_devices(&std::env::var("CDK_BRANCH_PROCESSOR_EV_FLEET").ok()?);
        if url.is_empty() || key.is_empty() || devices.is_empty() {
            return None;
        }
        Some(Self { url, key, devices })
    }
}

/// Device ids keep their case: the gateway keys its session map by the id
/// as triggered (atomD, not atoma) — normalizing case here would silently
/// disconnect the card from live sessions.
fn parse_devices(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|device| device.trim().to_string())
        .filter(|device| !device.is_empty())
        .collect()
}

#[derive(Debug, PartialEq, Serialize)]
pub struct FleetDevice {
    pub id: String,
    /// idle | running | done — the gateway's per-device session state.
    pub state: String,
    /// The gateway's session uuid, when a session record exists.
    pub session: Option<String>,
    /// Seconds actually delivered (the device is the metering authority).
    pub delivered_secs: u64,
    pub stopped: bool,
}

#[derive(Serialize)]
pub struct FleetStatus {
    /// "ok" | "unreachable" — the card degrades instead of erroring.
    pub gateway: &'static str,
    pub devices: Vec<FleetDevice>,
}

/// Map one gateway `GET /device/{id}/status` body onto the API row.
/// The gateway defaults idle devices to sparse JSON; tolerate gaps the
/// same way instead of failing the whole card.
pub fn device_from_body(id: &str, body: &serde_json::Value) -> FleetDevice {
    let text = |field: &str| {
        body.get(field)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let state = text("state").unwrap_or_else(|| "idle".to_string());
    FleetDevice {
        id: id.to_string(),
        state: if matches!(state.as_str(), "idle" | "running" | "done") {
            state
        } else {
            "idle".to_string()
        },
        session: text("session"),
        delivered_secs: body
            .get("seconds")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        stopped: body
            .get("stopped")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    }
}

/// Query every configured device. Any failed request collapses the whole
/// answer to gateway "unreachable" — the gateway is localhost, so partial
/// failure is not a shape worth rendering.
pub async fn query(http: &reqwest::Client, config: &FleetConfig) -> FleetStatus {
    let base = config.url.trim_end_matches('/');
    let mut devices = Vec::with_capacity(config.devices.len());
    for id in &config.devices {
        let row = async {
            let response = http
                .get(format!("{base}/device/{id}/status"))
                .header("x-api-key", &config.key)
                .timeout(Duration::from_secs(3))
                .send()
                .await?;
            let response = response.error_for_status()?;
            let body: serde_json::Value = response.json().await?;
            Ok::<_, reqwest::Error>(device_from_body(id, &body))
        }
        .await;
        match row {
            Ok(device) => devices.push(device),
            Err(_) => {
                return FleetStatus {
                    gateway: "unreachable",
                    devices: Vec::new(),
                }
            }
        }
    }
    FleetStatus {
        gateway: "ok",
        devices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_parsing_preserves_case_and_drops_empties() {
        assert_eq!(
            parse_devices("atomA, atomD ,,atomC"),
            vec!["atomA".to_string(), "atomD".to_string(), "atomC".to_string()]
        );
        assert!(parse_devices(" , ").is_empty());
    }

    #[test]
    fn idle_devices_default_to_sparse_bodies() {
        let body = serde_json::json!({});
        assert_eq!(
            device_from_body("atomD", &body),
            FleetDevice {
                id: "atomD".into(),
                state: "idle".into(),
                session: None,
                delivered_secs: 0,
                stopped: false,
            }
        );
    }

    #[test]
    fn running_sessions_carry_delivery() {
        let body = serde_json::json!({
            "state": "running",
            "session": "5f0f9d3e-1111-2222-3333-444455556666",
            "seconds": 7,
            "stopped": false,
        });
        let device = device_from_body("atomC", &body);
        assert_eq!(device.state, "running");
        assert_eq!(
            device.session.as_deref(),
            Some("5f0f9d3e-1111-2222-3333-444455556666")
        );
        assert_eq!(device.delivered_secs, 7);
        assert!(!device.stopped);
    }

    #[test]
    fn unknown_states_and_wrong_types_fall_back_to_idle_defaults() {
        let body = serde_json::json!({
            "state": "rebooting",
            "session": "",
            "seconds": "twelve",
            "stopped": "yes",
        });
        let device = device_from_body("atomA", &body);
        assert_eq!(device.state, "idle");
        assert_eq!(device.session, None);
        assert_eq!(device.delivered_secs, 0);
        assert!(!device.stopped);
    }

    #[test]
    fn stopped_sessions_report_delivered_seconds() {
        let body = serde_json::json!({
            "state": "done",
            "seconds": 12,
            "stopped": true,
        });
        let device = device_from_body("atomD", &body);
        assert_eq!(device.state, "done");
        assert_eq!(device.delivered_secs, 12);
        assert!(device.stopped);
    }
}
