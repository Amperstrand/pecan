//! Host checks the wizard runs before asking anything.

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortStatus {
    Free,
    Busy,
    /// Could not tell (e.g. binding a privileged port without root).
    Unknown,
}

/// Whether something on this host already listens on `port`. A connect probe
/// catches loopback-reachable listeners without needing root; the bind probe
/// then distinguishes free from bound-elsewhere.
pub fn port_status(port: u16) -> PortStatus {
    let loopback = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    if TcpStream::connect_timeout(&loopback, Duration::from_millis(400)).is_ok() {
        return PortStatus::Busy;
    }
    match TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))) {
        Ok(listener) => {
            drop(listener);
            PortStatus::Free
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => PortStatus::Busy,
        // EACCES on 80/443 without root, or anything else exotic.
        Err(_) => PortStatus::Unknown,
    }
}

pub fn ports_80_443_busy() -> bool {
    port_status(80) == PortStatus::Busy || port_status(443) == PortStatus::Busy
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert_eq!(port_status(port), PortStatus::Busy);
        drop(listener);
        assert_eq!(port_status(port), PortStatus::Free);
    }
}
