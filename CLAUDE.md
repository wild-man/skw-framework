# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace layout

Cargo workspace (edition 2024, resolver 3). Members: `libs/*`, `gates/*`, `services/*`. Plus `frontend/` (static page, no build step).

- **`libs/shared`** (crate `skw-lib-shared`) — the foundation every service builds on: global `AppContext` (`APP`), config loading, Postgres pools, Iggy message bus (`iggy.rs`), RabbitMQ client (`rabbitmq.rs`, via `lapin`), Redis client (`redis.rs`), JSON-RPC/HTTP glue, migrations, naming/tool helpers (`lib.rs`). `AppContext` eagerly holds a `postgres`/`iggy`/`rabbitmq`/`redis` quad (each typestate `Loaded`, `.connect()`'d lazily per-binary as needed). Ships the generic loops every service uses: `iggy::rpc::run_service_consumer` / `run_service_consumers_all_topic_types` (Iggy request/reply), `rabbitmq::run_task_consumer` + `RabbitMqPublisher` (background task queues, manual ack/nack), and `iggy::task_done::TaskDonePublisher` (a worker publishing to an Iggy topic). Read this crate first.
- **`libs/http-protos`** (crate `skw-lib-http-protos`) — per-domain **Iggy** wire contracts, i.e. request/reply shapes routed through a gate: `ping.rs` (`open::RpcMethod`, `signed::RpcMethod`, shared `RpcPayload`), `auth.rs` (public `RpcMethod`/`RpcPayload` = `CreateKey`; `internal::HttpMethod`/`HttpPayload` = HTTP-only `GetKeyById`), `dialog.rs` (`signed::RpcMethod`, `RpcPayload`, `Dialog`/`Message`). Each method carries `#[strum(props(topic = "..."))]`, checked at startup against the service's `/service/topicTypes`. Every `RpcPayload` implements `RpcReply` (provisional status, see below). Also the shared `JsonRpcServiceRequest<T>` envelope (implements `skw-lib-shared`'s `RpcMessageTrait`) and the `impl_try_from_iggy_message!` / `impl_try_from_string!` macros. Depends on `skw-lib-shared`; **`skw-lib-shared` must never depend back on this crate** (cycle) — see "Cross-service RPC over Iggy".
- **`libs/task-protos`** (crate `skw-lib-task-protos`) — per-domain **RabbitMQ** task payloads, plain serde structs sent as JSON: `ping::PingTask { api_key, signature, message }`, `dialog::DialogAskTask { dialog_id, message_id }`. Every task implements `rabbitmq::SkwMqTaskTrait` (`task_name()`), which `run_task_consumer` / `RabbitMqPublisher::publish` require.
- **`gates/api`** (crate `skw-api-gate`, binary `api-gate`) — `ntex` HTTPS gateway, one-shot-per-request. Loads TLS cert/key from disk, verifies the ed25519 request signature, refuses signed requests whose `Ts` is outdated (409, see `skw_is_outdated`), routes each request to an Iggy topic by its first two path segments, answers CORS preflights itself and adds `Access-Control-Allow-Origin` for origins in `/service/cors/allowedOrigins` (`src/cors.rs`), and fans replies back to the waiting request via a `tokio::sync::broadcast` channel (capacity 1000) filtered by signature; a lagging receiver keeps waiting until the timeout. Each back-topic worker builds its consumer at startup (failure stops the gate) and rebuilds it on the same connection (1s retry) if the stream ends. See "Request flow" below.
- **`gates/ws`** (crate `ws`, binary `ws`) — WebSocket gateway, sibling to `gates/api`, sharing the Iggy stream/back-topic/`topicsMap` convention but authenticating once per **connection**. Every frame is a `WsRequest` `{"Signature", "Uri", "Data": {"Ts","Method","Params"}}` (PascalCase, `deny_unknown_fields`):
  - `public`/`open` topic uris need no authorization; `Signature` is then just a client request id, and the gate mints its own correlation id via `skw_random_signature()`.
  - `signed` topics require a prior `Authorize {ApiKey}` frame (no `Uri`; checked against the auth service's `GetKeyById` and signature-verified, reply `{"Authorized": true}`; an outdated `Ts` or a bad signature closes with 1008). After that every frame is signed and verified locally against the cached public key; a valid frame with an outdated `Ts`, or whose signature is still pending, gets an `ErrCode` 409 reply.
  - Replies are `{"Signature", "Status", "ErrorMsg", "ErrCode", "Payload"}`. A provisional reply (`Status` 201/202) keeps the request pending, so the final reply under the same signature is delivered too.
  - `pending_requests` (`DashMap` keyed by request signature, atomic insert via the entry API, O(1) reply delivery, 30s watchdog = `BACK_MESSAGE_TIMEOUT`) and `connections` (keyed by connection id, for not-yet-used server pushes via `IGGY_HEADER_TARGET_WS_CONNECTION_ID`).
  - Heartbeat: one ping interval per connection (`/service/heartbeatIntervalSecs`); any client frame or pong refreshes it; silent clients are dropped after `/service/clientTimeoutSecs`. Ping/pong is logged at `trace`.
  - At most `/service/maxInFlightFrames` (default 64) frames per connection are handled at once (ntex `InFlightService`: verify + publish, not waiting for the reply); at the limit the gate stops reading that socket, so one client's burst can't stall its worker thread.
  - At most `/service/maxPendingRequests` (default 300) requests per connection may wait for their reply (counted by `gate::PendingSlot` inside each `pending_requests` entry, so every removal path decrements it); the next frame closes the connection with 1008 "Too many pending requests", checked before the signature check.
  - The gate's own Closes (`close_connection` / `unauthorized_close`) go through the heartbeat task as `WsOutbound::Close`: it sends the Close frame, then `io().close()`s the socket, so a client ignoring the Close can't keep it open.
  - The back-topic receiver rebuilds its consumer (1s retry) if the stream ends. **Not yet added to `docker-compose.yml`.**
- **`services/auth`** (crate `skw-auth-http-service`) — owns the Postgres `entities`/`roles` schema (namespaced under the `skw-auth-service` schema and `auth-…-<VERSION>` Iggy topics, keyed off `/service/name`). Binaries: `auth-http-service` (`src/http.rs`, axum: `GetKeyById` at `POST /internal`, used by both gates; `CreateKey` at `POST /`), `auth-stream-service` (`src/stream.rs`, Iggy consumer exposing the public `CreateKey`, so it's reachable via a gate's `/auth/open`), `auth-migrate`. Keypair generation/persistence is shared in `src/key.rs`. Does **not** verify signatures — the gates do.
- **`services/ping`** (crate `skw-ping-service`) — reference implementation of an Iggy- and RabbitMQ-driven service; shared helpers in `src/lib.rs` (`PING_TASK_QUEUE`, `named_queue()` reading `/rabbitmq/queues`).
  - `ping-stream-service` (`stream.rs`) — Iggy consumer (`run_service_consumers_all_topic_types`); `INCR`s `ping:count` in Redis on `Ping`; `PingCreated`/`PingAccepted` queue a `PingTask` and reply provisionally (201/202). `PingSlow` (test helper) replies `Ping` after 1s, so a request stays pending (used by the ws duplicate-request test). Run as two processes in `cfg/services.json` (`ping/local.json`, `ping/local-signed.json`) and two replicas in `docker-compose.yml`.
  - `ping-mq-service` (`mq.rs`) — RabbitMQ worker on the `ping-task` queue: `INCR`s `mq:count`, then publishes the **final reply** (`RpcPayload::Ping`, 200) to the gates' back topic under the task's `signature` via `TaskDonePublisher`. The nack/requeue branch is currently unreachable (`0..=u8::MAX`). **Not in `docker-compose.yml`.**
  - `ping-http-service` (`http.rs`) — empty stub.
- **`services/dialog`** (crate `skw-dialog-service`) — LLM dialogs in Postgres (`dialogs` + `messages`, uuidv7 ids, `created_at` derived via `uuid_extract_timestamp(id)`). Shared code in `src/lib.rs` (`models.rs` sqlx queries, `llm.rs` OpenAI-compatible `/chat/completions` client configured by `/llm`, e.g. Ollama on `localhost:11434/v1`). Binaries:
  - `dialog-stream-service` (`stream.rs`) — signed-only Iggy consumer for `CreateDialog`, `ListDialogs`, `GetDialog {Id, AfterMessageId}`, `Ask`, `RenameDialog`, `DeleteDialog`; the owner is the request's API-KEY, other owners' dialogs are `NotFound`. `Ask` stores the User message + a `Pending` Assistant message in one transaction (`FOR UPDATE`; a second pending → `UnprocessableEntity`), publishes `DialogAskTask` to the `dialog-ask` queue and replies 200 with both message ids; clients poll `GetDialog {AfterMessageId}`.
  - `dialog-mq-service` (`mq.rs`) — calls the LLM with the dialog's `Done` history, stores the answer (`Done`); retryable failures (timeouts, 429, 5xx) are nack-requeued until `/llm/maxAttempts`, then `Failed` with a provider-neutral `Error`.
  - **`LlmClient::chat` is currently a MOCK** (1s delay, echoes the last user message); the real HTTP call is commented out below it, and the response structs carry `#[allow(dead_code)] // MOCK` until it's restored.
- **`services/test`** (crate `skw-test-service`) — integration-test tooling, two binaries plus a small `lib.rs` (`cfg/services.json` + config helpers). Beforehand: infra running, `cargo build` done, migrations applied (`<service>-migrate -- up`) — `run` neither builds nor migrates.
  - `cargo run --bin run` (`src/bin/run.rs`) — spawns the prebuilt `target/debug/<bin>` of every `cfg/services.json` entry in order (CWD = crate dir, `ENV=local`, `SKW_CONFIG_FILE=services/test/cfg/<...>`, `RUST_LOG` passed through, default `info`), waiting for the port of `listens: true` entries. Gates create the Iggy topics, so stream consumers come after them. Output is prefixed `[bin]`; Ctrl-C/SIGTERM stops all children (SIGKILL after 10s). It also serves `frontend/` over TLS with the gates' cert on `https://127.0.0.1:8000/` (`FRONTEND_BIND_ADDRESS` overrides, `Cache-Control: no-store`).
  - `cargo run --bin test [-- <libtest args>]` (`src/bin/test/main.rs`) — checks `api-gate`/`ws` are up, then runs `cargo test --bin test`. Tests talk to the system **only via `api-gate` or `ws`**. Gates are providers behind `gate::Gate` (`gate/api.rs` = `ApiGate`, `gate/ws.rs` = `WsGate`); shared scenarios are `async fn name<G: Gate>()` in `tests/*.rs`, listed in `for_all_gates!` (generates `…::api::name` and `…::ws::name`). Replies are normalized to `GateReply { status, error_msg, payload }` (HTTP status / ws `Status` or `ErrCode` / close 1008 → 403). Credentials are `gate::Auth` (`None`, `Key`, `SignedByOther`, `TamperedBody`, `UnknownKey`); keys from `keys::main_key()`/`other_key()`. Transport-specific cases live in `tests/api_only.rs` / `tests/ws_only.rs`: api accepts 200 or 201/202 for `PingCreated`/`PingAccepted`; ws waits for the final 200 after a provisional reply (`WsGate::wait_final_reply`, logs each 201/202); duplicate-pending and outdated-`Ts` signed requests → 409. `common::gate_body_at` builds a body with a chosen `Ts`. Connection-lifetime tests use `gate::RawWs` (tungstenite only handshakes/writes, the socket is read raw, so nothing answers pings or echoes Close): a silent client is dropped after `clientTimeoutSecs` (~15s test); a client ignoring the gate's Close 1008 is still disconnected. `concurrent_signed_clients_get_only_their_own_replies` (2 × 1000 signed requests, ≤ 5/6 of `maxPendingRequests` waiting) and `too_many_pending_requests_close_the_connection` read the ws gate's limits from its config via `common`.
  - Add a service = add a `services.json` entry + its config copy in `cfg/`.
- **`frontend/`** — static chat page (`index.html`) + `skw-api.js` (`ApiGate` for HTTP, `WsGate` for one ws connection, `ApiKey` = WebCrypto ed25519 import/sign). "Start" runs `auth/CreateKey` via api-gate, connects to the ws gate (port 9443), authorizes and creates a dialog; each message is an `Ask` followed by `GetDialog` polling every 1s (120s limit) until the answer is `Done`/`Failed`. Session state is in memory only.

- **`docs/diagrams/`** — architecture/workflow/lifecycle/sequence/dataflow diagrams made with the archify skill: `*.json` is the source of truth, `*.html` is generated by archify ≥ 3.2 from inside `docs/diagrams/` (`archify finalize <type> <x>.json <x>.html --quality showcase --json`, which validates, delivers and browser-checks; each source sets `meta.output`), `*.delivery.json`/`*.finalize*.json`/`*.browser-check.json` are its receipts and `*.visual-check.*` the screenshots from `archify visual-check <x>.html`. Edit the JSON and redeliver when the request flow, gates or services change.

Every service/gate crate has its own `dev.json`/`local.json` (loaded relative to CWD, see Configuration below) and its own nested `.git` (separate repos, not submodules — no shared history). Local infra: Postgres, Iggy (+ web UI), RabbitMQ (`skw-rabbitmq`, management UI `:15672`), Redis (`skw-redis`, ACL-authenticated).

## Commands

```bash
cargo build                       # build all; --release for prod profile (dev builds still optimize curve25519-dalek/ed25519-dalek/sha2: unoptimized verify is ~8ms)
cargo fmt                         # rustfmt.toml: max_width=150, fn_call_width/chain_width=60, edition 2024
cargo clippy --all-targets
cargo test -p skw-lib-shared -p ws -p skw-dialog-service   # unit tests (pure logic, no infra/APP needed); NOT --workspace: services/test's `test` bin needs running services

# Run a service/gate — MUST cd into the crate dir first (see config gotcha below)
cd services/auth   && cargo run --bin auth-http-service     # axum: GetKeyById (/internal), CreateKey (/)
cd services/auth   && cargo run --bin auth-stream-service   # Iggy consumer: CreateKey
cd services/ping   && cargo run --bin ping-stream-service   # Iggy consumer
cd services/ping   && cargo run --bin ping-mq-service       # RabbitMQ worker, final replies for PingCreated/PingAccepted
cd services/dialog && cargo run --bin dialog-stream-service
cd services/dialog && cargo run --bin dialog-mq-service
cd gates/api       && cargo run --bin api-gate
cd gates/ws        && cargo run --bin ws

# Dev-only helper binaries in gates/api
cd gates/api && cargo run --bin sign       # signs a hardcoded Ping payload with the seeded root key, prints base64 signature
cd gates/api && cargo run --bin testback   # publishes a fake backend response straight onto the back topic

# Migrations (sqlx) — takes up|down as argv[1]. Bin names are unique, but CWD must still be the crate dir (./migrations + config)
cd services/auth   && cargo run --bin auth-migrate -- up
cd services/ping   && cargo run --bin ping-migrate -- up
cd services/dialog && cargo run --bin dialog-migrate -- up
cd services/auth   && cargo run --bin auth-migrate -- down   # reverts last migration

# Local infra (postgres, iggy, iggy-web-ui, rabbitmq, redis) + containerized api-gate/auth/ping-stream
docker compose up
```

Every bin target name is unique across the workspace (migration binaries are `<service>-migrate`), so `cargo build --workspace` produces no output-filename collisions. Keep new binaries following that convention.

Integration tests: `cd services/test && cargo run --bin run` in one terminal, `cargo run --bin test` in another (see `services/test` above). Debug logs of one crate only: `RUST_LOG=info,ws=trace cargo run --bin run`. `services/auth/tests/requests.hurl` exists but is empty.

`skw-lib-shared` honors `SKW_CONFIG_FILE=<path>`: if set, the config is read from that file instead of `./{ENV}.json` (CWD is still the base for `./migrations` and relative paths).

## Configuration (critical gotcha)

`skw_lib_shared::APP` is a `LazyLock<AppContext>` initialized on first deref via `init_by_env()`. It reads `./{ENV}.json` **from the process's current working directory** (`ENV` env var, default `"dev"`). Migrations likewise resolve `./migrations` relative to that same path. **Therefore binaries must be launched from their own crate directory** (where `dev.json` and `migrations/` live), not the workspace root — otherwise config loading panics.

Config access is fail-fast: `APP.config.expect_str/expect_string/expect_u32/expect_u64/expect_bool/...` panic on missing/wrong-typed keys; `.get(path)` returns `Option<&Value>` for optional config. Values are addressed by JSON Pointer paths (e.g. `/iggy/url`).

Each `dev.json` has an `/envOverrides` object mapping a JSON-pointer-into-the-config → an env var name. At startup any present env var overwrites the value at that pointer (type-preserving). This is how the Docker setup injects `POSTGRES_MASTER_URL`, `IGGY_URL`, `SERVICE_BIND_ADDRESS`, etc.

## Shared-library architecture (`libs/shared`)

Leans heavily on the **typestate pattern** (`PhantomData<S>` + marker structs) to make lifecycle stages compile-checked:

- `Config<ConfigNew>` → `.load()` → `Config<ConfigReady>` → `.override_values_from_env()`.
- `PostgresPools<Loaded>` → `.connect().await` → `PostgresPools<Connected>` (only `Connected` exposes `.master()`/`.slave()`).
- `Iggy<Loaded>` → `.connect().await?` (`Result<_, SkwIggyError>`) → `Iggy<Connected>` (only `Connected` exposes `.inner() -> Arc<IggyClient>`, no `Option`: the typestate guarantees the client). Same shape for `RabbitMq` (`inner() -> Arc<Connection>`) and `Redis` (`inner() -> ConnectionManager`). Idiom: `let client = APP.iggy.clone().connect().await?.inner();`.

`AppError` is the crate-wide error enum (`thiserror`, `From` conversions for Postgres/Iggy/RabbitMq/Redis/Reqwest/Migrate/Service/Serde errors); `AppError::service_error()` collapses everything but `AppError::Service` into `InternalServerError`, so internal details never reach clients.

**Naming helpers** (`lib.rs`, exported via `prelude::tools`), reading config: `skw_get_stream_name()` (`"{iggy.streamPrefix}-{VERSION}"`), `skw_get_stream_topic_name(topic_type)` (`"{service}-{topic_type}-{VERSION}"`, service from `/service/name` stripped of `skw-`/`-service`), `skw_get_back_topic_name()` (`"gate-back-{VERSION}"`, shared by every service), `skw_get_consumer_name(topic)` (`"consumer-{/service/name}-{topic}"` — so the two gates join the back topic in different groups as long as their service names differ), `skw_get_queue_name(base)`, `skw_get_task_done_notify_topic_name::<Task>()` (`"task-done-notify-{task_name}-{VERSION}"`), `skw_random_signature()`, `skw_is_valid_name()`, `skw_is_outdated(ts)` (a signed `Ts` more than `BACK_MESSAGE_TIMEOUT` = 30s from now, either way).

**Iggy headers** (`prelude::consts`): `signature` (correlation id), `api-key`, `http-method`, `http-path`, `err-response-code` (service error, `SkwServiceHttpError` display), `response-status` (provisional `SkwServiceStatus`: `Created`/`Accepted`), `ts-service-*` timings, `target-ws-connection-id` (ws push, unused). Use the prebuilt keys `prelude::iggy::header_keys::{SIGNATURE, API_KEY, ...}` (`LazyLock<HeaderKey>`; `.clone()` to insert, `&header_keys::X` to look up) instead of `HeaderKey::from_str(IGGY_HEADER_*)`; to read several headers, decode the map once (`message.user_headers_map()?`) and use `header_str(map.as_ref(), &key)` — `get_user_header` decodes the whole map on every call.

**Cross-service RPC over Iggy** (`libs/shared/src/iggy.rs`, module `rpc`): `run_service_consumer::<Req, H, Fut, Resp>(handler, pool_interval, batch_size, topic_type)` is the consumer-group loop for one topic type, handling up to `batch_size` messages concurrently (`for_each_concurrent` in one task, so a slow handler delays only its own reply; replies may complete out of order, gates match by signature; offsets are committed on read, so a crash loses the in-flight ones; `run_service_consumers_all_topic_types` therefore needs the handler `Send + Sync`); `run_service_consumers_all_topic_types` runs one per entry of `/service/topicTypes` (after validating every method's `topic` prop against them) — that's what services call. Per message it skips messages older than `BACK_MESSAGE_TIMEOUT`, converts `ReceivedMessage` into `Req: RpcMessageTrait` (`signature()`, `http_method()`, `http_path()`, `api_key()`, `into_rpc_method()`), calls `handler(method, meta: RpcRequestMeta) -> Result<Resp, AppError>`, and publishes the reply on the back topic with the original `signature` header: the JSON payload (+ `response-status` header when `Resp::status()` is `Some`), or `err-response-code` + `{}` on error.

Because `skw-lib-shared` cannot depend on `skw-lib-http-protos` (cycle), the bridge is a **blanket impl**: `libs/http-protos/src/lib.rs` implements `RpcMessageTrait` for `JsonRpcServiceRequest<T>` (legal under the orphan rule since `JsonRpcServiceRequest` is local to that crate). A service's `stream.rs` looks like:
```rust
run_service_consumers_all_topic_types::<JsonRpcServiceRequest<RpcMethod>, _, _, _>(
    move |rpc_method, meta| handle_message(rpc_method, meta, /* cloned state */),
    None,      // poll interval (default 1ms)
    Some(100), // batch size
).await?;
// (turbofish on Req is mandatory — it only appears via trait bounds, type inference can't find it)
async fn handle_message(method: RpcMethod, meta: RpcRequestMeta, ...) -> Result<RpcPayload, AppError> { ... }
```
See `services/dialog/src/stream.rs` (signed-only) and `services/ping/src/stream.rs` (open + signed topics) — anything more than domain logic in a service's `stream.rs` is a sign it should move into `libs/shared`.

**Provisional replies and task completion**: a handler returning a payload whose `RpcReply::status()` is `Created`/`Accepted` sends a provisional reply (the request is taken, e.g. a task queued). The final reply is published later by whoever finishes the work, under the same `signature`, with `iggy::task_done::TaskDonePublisher::new(topic)` + `publish(signature, payload, status)` — `ping-mq-service` does this on the back topic. The ws gate delivers both replies; the api gate answers HTTP with the provisional one (HTTP is one-shot) and the final one is dropped.

**RabbitMQ** (`rabbitmq.rs`): `QueueConfig` (name gets `-{VERSION}`), `run_task_consumer::<Task, _, _>(queue, handler)` handles deliveries concurrently up to `prefetch_count` (`for_each_concurrent` in one task; completion order ≠ delivery order, so a slow/retrying task holds only its own slot) and acks/nacks per the returned `TaskOutcome` (undeserializable payloads are nacked without requeue); `RabbitMqPublisher` uses publisher confirms.

**`prelude`** re-exports the curated public surface (`prelude::axum::*`, `prelude::iggy::*` — `run_service_consumer*`, `RpcMessageTrait`, `RpcReply`, `TaskDonePublisher` plus the whole `iggy::prelude`, `prelude::rabbitmq::*`, `prelude::redis::*`, `prelude::postgres::*`, `prelude::jsonrpc::*`, `prelude::log::*`, `prelude::tools::*`, `prelude::consts::*`). Service code imports from `skw_lib_shared::prelude` rather than reaching into crate internals.

**JSON-RPC / HTTP glue** (`jsonrpc.rs`): `JsonRpcGateHttpRequest { ts, method }` (the gate body; for signed requests exactly the signed bytes), `SkwServiceHttpError` (`NotFound`/`Forbidden`/`BadRequest`/`UnprocessableEntity`/`InternalServerError`; `Display` is the `err-response-code` header value, `status_code()` the HTTP status), `SkwServiceStatus`, `JsonRpcResponse`/`JsonRpcErrorResponse` for axum handlers, `internal_http_request()` for one service calling another over plain HTTP (the gates → auth `GetKeyById`; 400/403/404/422 map to their `SkwServiceHttpError`, any other non-2xx is logged and becomes `InternalServerError`).

## Cross-cutting request flow: gateway ↔ Iggy ↔ service

1. **Startup (gate)**: `init_iggy` creates the shared stream and back topic, then reads `/topicsMap` (`{"ping": {"topicTypes": ["open","signed"], "partitionsCount": 10, "messageExpiry": 31, ...}}`). For each service × topic type it creates the topic `{service}-{topic_type}-{VERSION}` and a producer, collected into `RoutesMap` keyed `"{service}/{topic_type}"` — i.e. the first two path segments (`POST /ping/signed`) or the ws frame's `Uri`.
2. **Startup (gate, response fan-in)**: api-gate opens `/service/backTopicConsumers` consumers (one Iggy connection each) in one group on the back topic and broadcasts every message to the waiting requests; ws-gate opens one consumer and dispatches by signature through `pending_requests`.
3. **Per request (gate)**: resolve the route; `public` = `GET` only (the gate sends the `Public` method itself), `open`/`signed` = `POST`/... with a JSON-RPC body. For `signed`: `API-KEY` + `PAYLOAD-SIGNATURE` headers (api) or the connection's `Authorize` (ws); public key fetched from `auth-http-service` `GetKeyById` (api caches it 60s), ed25519 signature verified over the exact body, outdated `Ts` → 409. Then publish the raw body to the service topic with `signature`/`api-key`/`http-method`/`http-path` headers and wait (30s, `BACK_MESSAGE_TIMEOUT`) for a back-topic message with the same `signature`. Unsigned requests get a gate-minted random signature.
4. **Backend service**: `run_service_consumer` → handler → reply on the back topic with the same `signature` (+ `err-response-code` on error, `response-status` on provisional replies). A worker may add the final reply later (see "Provisional replies").
5. **Gate**: maps `err-response-code` to the HTTP status / ws `ErrCode`, `response-status` to 201/202, otherwise 200, and returns the payload.

## `services/auth` specifics

Owns the `entities`/`roles` Postgres schema (`migrations/`): `entities` form a self-parented tree (`parent_id` FK to `entities.id`, root `01a01500-98d5-71fc-9038-71acb78d61c4` points at itself, seeded with role `{0}`); `roles` carry a `role_scope` enum (`AllChilds`/`FullTree`/`SelfOnly`) plus `role_service`/`role_entities`/`role_actions` text-array columns (`'*'` = wildcard); role `0` is seeded as full access. Public/private keys are stored as bare base64 (SPKI/PKCS#8 PEM armor stripped).

`internal.rs::http_handler` at `POST /internal` dispatches `internal::HttpMethod::GetKeyById { id }` → `Entity::get_by_id` (**slave** pool) → `HttpPayload::GetKeyById { id, public_key, enabled }` — internal-only, HTTP-only, never Iggy-routed. `external.rs::http_handler` at `POST /` and `stream.rs::handle_message` (Iggy) both dispatch the public `RpcMethod::CreateKey { store_private_key }` → `key::create` (ed25519 keygen + `Entity::insert` on the **master** pool, parented to the root entity from `/service/rootKey`) → `RpcPayload::CreateKey { id, public_key, private_key, enabled }` — the private key is always returned; `store_private_key` only controls whether it's also persisted. `CreateKey` is open (unauthenticated) by design: the frontend mints a key per chat session. No role-assignment endpoints exist yet.

## `services/ping` specifics

Reference/template for a minimal Iggy + RabbitMQ service — see "Cross-service RPC over Iggy" and "Provisional replies". `migrations/` defines an unused `ping` table (never queried from Rust).

## Known discrepancies vs. aspirational docs/config (worth knowing before "fixing" something that's actually just unfinished)

- **TLS is not self-signed-at-startup.** `gates/*/src/tls.rs` only load a pre-existing cert/key pair from disk (`service.tls.certPath`/`keyPath`). `rcgen` is a declared dependency of `gates/api` and `dev.json` has a `subjectAltNames` list, but no `rcgen` call exists — scaffolded, not implemented. Cert/key live at `conf/skw-api-gate.cert.pem`/`.key.pem` and must be pre-provisioned.
- **ed25519 verification lives in the gates, not in the auth service.** `gates/api/src/auth.rs` and `gates/ws/src/crypto.rs` do the `VerifyingKey::verify(...)`; the auth service only serves `GetKeyById` and `CreateKey`.
- **Replay protection is the `Ts` window only.** A signed request is accepted while its `Ts` is within 30s; the ws gate additionally refuses a signature that's still pending. A request resent within the window after it completed is accepted again. Each gate process checks on its own.
- **Scaling gates horizontally isn't supported yet**: all replicas of one gate share one back-topic consumer group, so a reply can land on a replica that isn't waiting for it (see the comments in both gates' `gate.rs`).
- **The api gate drops final replies** of provisional (201/202) requests; HTTP clients read results later (e.g. dialog `GetDialog`).

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
