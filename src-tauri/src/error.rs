use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Network,
    Timeout,
    Auth,
    Parse,
    Server,
    Config,
    Io,
}

/// 统一的错误载荷。会被序列化后经 IPC 传给前端，
/// 前端的 `src/api/errors.ts` 里有一份镜像类型，两边字段必须保持一致。
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    pub retryable: bool,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message, true)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, message, true)
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Auth, message, false)
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Parse, message, false)
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Config, message, false)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Io, message, false)
    }

    /// 5xx 与服务端 429 视为可重试；其余 4xx 不可重试
    pub fn from_status(status: u16) -> Self {
        let retryable = status >= 500 || status == 429;
        Self::new(ErrorKind::Server, format!("HTTP {status}"), retryable)
    }

    /// 把 reqwest 的错误归类；超时单独识别，便于前端给出不同提示
    pub fn from_reqwest(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            return Self::timeout(err.to_string());
        }
        if err.is_connect() || err.is_request() {
            return Self::network(err.to_string());
        }
        Self::new(ErrorKind::Network, err.to_string(), true)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_errors_are_retryable() {
        let e = AppError::network("connection reset");
        assert_eq!(e.kind, ErrorKind::Network);
        assert!(e.retryable);
    }

    #[test]
    fn auth_errors_are_not_retryable() {
        let e = AppError::auth("bad password");
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(!e.retryable);
    }

    #[test]
    fn server_5xx_is_retryable_but_4xx_is_not() {
        assert!(AppError::from_status(503).retryable);
        assert!(!AppError::from_status(404).retryable);
    }

    #[test]
    fn serializes_to_kind_and_message() {
        let e = AppError::auth("session expired");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "auth");
        assert_eq!(v["message"], "session expired");
        assert_eq!(v["retryable"], false);
    }

    #[test]
    fn every_kind_serializes_to_lowercase() {
        let kinds = [
            ErrorKind::Network,
            ErrorKind::Timeout,
            ErrorKind::Auth,
            ErrorKind::Parse,
            ErrorKind::Server,
            ErrorKind::Config,
            ErrorKind::Io,
        ];
        for k in kinds {
            let s = serde_json::to_value(k).unwrap();
            let text = s.as_str().unwrap();
            assert_eq!(text, text.to_lowercase(), "{text} 应为全小写");
        }
    }
}
