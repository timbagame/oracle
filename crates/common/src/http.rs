//! HTTP/1.1 serving with the limits `Bun.serve` applied to the TypeScript oracles:
//! connections idle for 10 seconds while the server waits for a request are closed
//! (slow or abandoned clients cannot pin sockets), and request bodies over
//! `MAX_REQUEST_BODY_BYTES` get 413 before any route or bearer check runs.

use std::future::Future;
use std::time::Duration;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use futures::StreamExt;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;

use crate::security::MAX_REQUEST_BODY_BYTES;

/// `Bun.serve`'s default `idleTimeout`.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10);

fn status(code: StatusCode) -> Response {
    Response::builder().status(code).body(Body::empty()).expect("static response parts are valid")
}

/// Reads the whole body (at most `MAX_REQUEST_BODY_BYTES`, within `IDLE_TIMEOUT`)
/// before routing, so oversized chunked uploads fail like oversized declared ones.
async fn buffer_body(request: Request, next: Next) -> Response {
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > MAX_REQUEST_BODY_BYTES as u64) {
        return status(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let (parts, body) = request.into_parts();
    let read = async {
        let mut stream = body.into_data_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
            if bytes.len() + chunk.len() > MAX_REQUEST_BODY_BYTES {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    };
    match tokio::time::timeout(IDLE_TIMEOUT, read).await {
        Ok(Ok(bytes)) => next.run(Request::from_parts(parts, Body::from(bytes))).await,
        Ok(Err(code)) => status(code),
        Err(_) => status(StatusCode::REQUEST_TIMEOUT),
    }
}

/// Adds the body limit in front of every route of `router`.
pub fn limit_bodies(router: Router) -> Router {
    router.layer(axum::middleware::from_fn(buffer_body))
}

/// Serves `router` until `shutdown` resolves, then waits for in-flight requests.
pub async fn serve(listener: TcpListener, router: Router, shutdown: impl Future<Output = ()>) -> std::io::Result<()> {
    serve_with(listener, limit_bodies(router), shutdown, IDLE_TIMEOUT).await
}

async fn serve_with(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
    idle: Duration,
) -> std::io::Result<()> {
    let graceful = GracefulShutdown::new();
    let mut builder = hyper::server::conn::http1::Builder::new();
    // hyper restarts this timer whenever it waits for the next request head,
    // so it also closes idle keep-alive connections.
    builder.timer(TokioTimer::new()).header_read_timeout(idle);
    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = &mut shutdown => break,
        };
        let Some(stream) = accepted_stream(accepted).await else { continue };
        let service = TowerToHyperService::new(router.clone());
        let connection = builder.serve_connection(TokioIo::new(stream), service);
        let connection = graceful.watch(connection);
        tokio::spawn(async move {
            let _ = connection.await;
        });
    }
    drop(listener);
    graceful.shutdown().await;
    Ok(())
}

/// The accepted stream, or `None` after an accept failure. Per-connection failures
/// (e.g. a reset before accept) must not stop the server; anything else (out of file
/// descriptors) backs off instead of spinning.
async fn accepted_stream<S>(accepted: std::io::Result<(S, std::net::SocketAddr)>) -> Option<S> {
    let error = match accepted {
        Ok((stream, _)) => return Some(stream),
        Err(error) => error,
    };
    if !is_connection_error(&error) {
        crate::warn!("HTTP accept failed: {error}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

fn is_connection_error(error: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(error.kind(), ConnectionRefused | ConnectionAborted | ConnectionReset)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::routing::{get, post};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::Notify;
    use tower::ServiceExt;

    use super::*;

    fn echo() -> Router {
        Router::new().route("/echo", post(|body: String| async move { body.len().to_string() })).route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                "done"
            }),
        )
    }

    async fn send(request: Request) -> (StatusCode, String) {
        let response = limit_bodies(echo()).oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    fn post_to(body: Body, length: Option<&str>) -> Request {
        let mut request = Request::post("/echo");
        if let Some(length) = length {
            request = request.header(header::CONTENT_LENGTH, length);
        }
        request.body(body).unwrap()
    }

    fn chunked(chunks: Vec<Result<Vec<u8>, std::io::Error>>) -> Body {
        Body::from_stream(futures::stream::iter(chunks))
    }

    #[tokio::test(start_paused = true)]
    async fn accept_failures_back_off_only_when_they_are_not_per_connection() {
        use std::io::{Error, ErrorKind};
        let started = tokio::time::Instant::now();
        for kind in [ErrorKind::ConnectionRefused, ErrorKind::ConnectionAborted, ErrorKind::ConnectionReset] {
            assert_eq!(accepted_stream::<()>(Err(Error::from(kind))).await, None);
        }
        assert_eq!(started.elapsed(), Duration::ZERO);
        assert_eq!(accepted_stream::<()>(Err(Error::other("Too many open files"))).await, None);
        assert_eq!(started.elapsed(), Duration::from_millis(100));
    }

    #[tokio::test]
    async fn passes_bodies_up_to_the_limit() {
        let full = "x".repeat(MAX_REQUEST_BODY_BYTES);
        assert_eq!(
            send(post_to(Body::from(full.clone()), None)).await,
            (StatusCode::OK, MAX_REQUEST_BODY_BYTES.to_string())
        );
        let declared = MAX_REQUEST_BODY_BYTES.to_string();
        assert_eq!(send(post_to(Body::from(full), Some(&declared))).await.0, StatusCode::OK);
        let parts = chunked(vec![Ok(vec![b'a'; 10]), Ok(vec![b'b'; 5])]);
        assert_eq!(send(post_to(parts, None)).await, (StatusCode::OK, "15".into()));
    }

    #[tokio::test]
    async fn rejects_oversized_bodies_before_routing() {
        // A declared length is enough, even for routes that do not exist.
        let unknown = Request::post("/nowhere").header(header::CONTENT_LENGTH, "16385").body(Body::empty()).unwrap();
        assert_eq!(send(unknown).await.0, StatusCode::PAYLOAD_TOO_LARGE);
        let huge = post_to(Body::empty(), Some("99999999999999999999999"));
        assert_eq!(send(huge).await.0, StatusCode::OK, "unparsable lengths are left to hyper");
        let streamed = chunked(vec![Ok(vec![0; MAX_REQUEST_BODY_BYTES]), Ok(vec![0])]);
        assert_eq!(send(post_to(streamed, None)).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn rejects_broken_and_stalled_bodies() {
        let broken = chunked(vec![Ok(vec![1]), Err(std::io::Error::other("reset"))]);
        assert_eq!(send(post_to(broken, None)).await.0, StatusCode::BAD_REQUEST);

        tokio::time::pause();
        let stalled = Body::from_stream(futures::stream::pending::<Result<Vec<u8>, std::io::Error>>());
        assert_eq!(send(post_to(stalled, None)).await.0, StatusCode::REQUEST_TIMEOUT);
    }

    async fn start(
        idle: Duration,
    ) -> (std::net::SocketAddr, Arc<Notify>, tokio::task::JoinHandle<std::io::Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(Notify::new());
        let signal = stop.clone();
        let task =
            tokio::spawn(serve_with(listener, limit_bodies(echo()), async move { signal.notified().await }, idle));
        (address, stop, task)
    }

    async fn read_all(stream: &mut tokio::net::TcpStream) -> String {
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn closes_connections_that_send_nothing_or_stall_mid_headers() {
        let (address, stop, task) = start(Duration::from_millis(150)).await;
        let mut silent = tokio::net::TcpStream::connect(address).await.unwrap();
        let mut partial = tokio::net::TcpStream::connect(address).await.unwrap();
        partial.write_all(b"GET /slow HTTP/1.1\r\nHost: x\r\n").await.unwrap();
        let started = std::time::Instant::now();
        let (silent_output, partial_output) = tokio::time::timeout(Duration::from_secs(5), async {
            (read_all(&mut silent).await, read_all(&mut partial).await)
        })
        .await
        .expect("idle connections are closed");
        assert!(started.elapsed() >= Duration::from_millis(100));
        assert!(!silent_output.contains("200") && !partial_output.contains("done"));
        stop.notify_one();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn serve_limits_bodies_and_stops_on_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(Notify::new());
        let waiter = stop.clone();
        let task = tokio::spawn(serve(listener, echo(), async move { waiter.notified().await }));
        let request = |length: usize| {
            format!("POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: {length}\r\n\r\n")
        };
        let mut small = tokio::net::TcpStream::connect(address).await.unwrap();
        small.write_all(format!("{}abc", request(3)).as_bytes()).await.unwrap();
        let output = read_all(&mut small).await;
        assert!(output.starts_with("HTTP/1.1 200") && output.ends_with('3'), "{output}");
        let mut large = tokio::net::TcpStream::connect(address).await.unwrap();
        large.write_all(request(MAX_REQUEST_BODY_BYTES + 1).as_bytes()).await.unwrap();
        assert!(read_all(&mut large).await.starts_with("HTTP/1.1 413"));
        stop.notify_one();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn keeps_slow_handlers_and_finishes_them_on_shutdown() {
        let (address, stop, task) = start(Duration::from_millis(100)).await;
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client.write_all(b"GET /slow HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Shutdown waits for the in-flight request, which outlives the idle timeout.
        stop.notify_one();
        let output = read_all(&mut client).await;
        assert!(output.starts_with("HTTP/1.1 200") && output.ends_with("done"), "{output}");
        task.await.unwrap().unwrap();
        assert!(tokio::net::TcpStream::connect(address).await.is_err(), "the listener is closed");
    }

    #[test]
    fn treats_resets_as_connection_errors() {
        assert!(is_connection_error(&std::io::ErrorKind::ConnectionReset.into()));
        assert!(!is_connection_error(&std::io::Error::other("EMFILE")));
    }
}
