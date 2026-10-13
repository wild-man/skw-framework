# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workspace layout

Cargo workspace (edition 2024, resolver 3). Members: `libs/*`, `gates/*`, `services/*`.

- **`libs/shared`** (crate `skw-lib-shared`) — the foundation every service builds on: global `AppContext` (`APP`), config loading, Postgres pools, Iggy message bus, **RabbitMQ client (`rabbitmq.rs`, via `lapin`) and Redis client (`redis.rs`)**, JSON-RPC/HTTP glue, migrations. `AppContext` now eagerly holds a `postgres`/`iggy`/`rabbitmq`/`redis` quad (each typestate `Loaded`, `.connect()`'d lazily per-binary as needed). Ships two generic consumer-loop helpers: `iggy::rpc::run_service_consumer` (Iggy request/reply, used by every HTTP/WS-routed backend service) and `rabbitmq::run_task_consumer` + `RabbitMqPublisher` (fire-and-forget background task queues, manual ack/nack). Read this crate first.
- **`libs/http-protos`** (crate `skw-lib-http-protos`) — per-domain **Iggy** wire contracts, i.e. request/reply shapes routed through a gate. Each domain gets a submodule (`ping.rs`, `auth.rs::internal`) defining its method/payload enums, plus the shared `JsonRpcServiceRequest<T>` envelope (implements `skw-lib-shared`'s `RpcMessageTrait`) and the `impl_try_from_iggy_message!` / `impl_try_from_string!` macros that wire a domain's method enum into the Iggy transport. Naming is inconsistent across domains: `auth.rs::internal` still calls its enums `HttpMethod`/`HttpPayload`; `ping.rs` was renamed to `RpcMethod`/`RpcPayload` (now also has a `Public {}` variant used for gate-side liveness/no-auth requests) — don't assume one name pattern when adding a new domain. Depends on `skw-lib-shared`; **`skw-lib-shared` must never depend back on this crate** (would be a cycle) — see "Cross-service RPC over Iggy" below for how that boundary is bridged.
- **`libs/task-protos`** (crate `skw-lib-task-protos`) — per-domain **RabbitMQ** task payloads, the queue-side counterpart to `http-protos`'s Iggy-side contracts. No macros/traits, just plain `Serialize`/`Deserialize` structs consumed via `serde_json` (not Iggy headers). Currently just `ping::PingTask { message: String }`.
- **`gates/api`** (crate `skw-api-gate`, binary `api-gate`) — `ntex` HTTPS gateway, one-shot-per-request. TLS-terminates using cert/key files loaded from disk, does ed25519 request-signature verification, routes each HTTP request to the right Iggy topic based on the first path segment, and fans responses back to the right waiting request via a `tokio::sync::broadcast` channel filtered by signature. See "Request flow" below.
- **`gates/ws`** (crate `ws`, binary `ws`) — a second, WebSocket-based gateway, sibling to `gates/api`, sharing the same Iggy stream/back-topic/`topicsMap` convention but authenticating once per **connection** instead of once per **request**: every frame is a `WsRequest` `{"Signature", "Uri", "Data": {"Ts","Method","Params"}}` (PascalCase, `deny_unknown_fields`); frames to `public`/`open` topic uris need no authorization (their `Signature` is just a client request id; the gate mints its own correlation id via `skw_random_signature()`), while `signed` topics require a prior `Authorize {ApiKey}` frame (no `Uri`; checked + signature-verified against the auth service's `GetKeyById`, same scheme as `gates/api/src/auth.rs`, reply `{"Authorized": true}`), after which every frame is signed and verified locally against the now-cached public key. Tracks per-connection heartbeats (ping/pong; idle connections past `clientTimeoutSecs` are dropped) and, instead of `gates/api`'s broadcast-and-filter, keeps two `DashMap`s — `pending_requests` (keyed by request signature, O(1) reply delivery + its own timeout watchdog mirroring `gates/api`'s 30s `BACK_MESSAGE_TIMEOUT`) and `connections` (keyed by connection id, enabling not-yet-used server-initiated push messages via `IGGY_HEADER_TARGET_WS_CONNECTION_ID`). Joins the shared back topic under its own consumer-group name (`consumer-ws-{back_topic}`) so it doesn't split partitions with `gates/api`'s `consumer-{back_topic}` group. **Not yet added to `docker-compose.yml`** — currently run manually.
- **`services/auth`** (crate `skw-auth-http-service`) — owns the Postgres `entities`/`roles` schema (still namespaced under the `skw-auth-service` Postgres schema and `auth-<VERSION>` Iggy topic — those are keyed off `/service/name` in `dev.json`/`local.json`, which wasn't renamed alongside the crate/container), split across two binaries: `auth-http-service` (`src/main.rs`, axum) serves `GetKeyById` at `POST /internal` (used by both gates to fetch an entity's public key + `enabled` flag) and `CreateKey` at `POST /` (public HTTP, direct); `auth-stream-service` (`src/stream.rs`) is an Iggy consumer via `run_service_consumer`, exposing the same public `CreateKey` method so it's also reachable through `gates/api`/`gates/ws`'s `/auth/...` routing once a gate's `topicsMap` has an `auth` entry. The two binaries share keypair-generation/persistence logic via `src/keygen.rs`. Does **not** perform signature verification itself (see discrepancies below) — that still lives in the gateway.
- **`services/ping`** (crate `skw-ping-service`) — reference implementation of an Iggy- and RabbitMQ-driven backend service, now with three real binaries plus `migrate`:
  - `ping-stream-service` (`stream.rs`) — the Iggy consumer via `run_service_consumer`; also connects to Redis and `INCR`s `ping:count` on every `Ping` call. Run as **two replicas** in `docker-compose.yml` (`skw-ping-stream-service`, `skw-ping-stream-service-1`), both depending on `skw-redis`.
  - `ping-mq-service` (`mq.rs`) — a RabbitMQ task consumer via `run_task_consumer`, draining the `ping-task` queue (queue names/prefetch read from `/rabbitmq/queues` config), `INCR`ing `mq:count` in Redis, and randomly `Nack{requeue: true}`-ing ~20% of tasks to exercise retry. **Not yet added to `docker-compose.yml`.**
  - `ping-http-service` (`http.rs`) — still an empty unused stub binary.
- **`services/test`** (crate `skw-test-service`) — integration-test tooling, two binaries plus a small shared `lib.rs` (`cfg/services.json` + config helpers). Developer's responsibility beforehand: infra (iggy/postgres/redis/rabbitmq) running, `cargo build` done, migrations applied (`cargo run --bin migrate -- up` per crate) — `run` neither builds nor migrates.
  - `cargo run --bin run` (`src/bin/run.rs`) — reads `cfg/services.json` (ordered array of `{bin, config, listens}`; `bin` resolved to its crate via `cargo metadata`) and spawns the prebuilt `target/debug/<bin>` services in array order (CWD = their crate dir, `ENV=local`, config passed via `SKW_CONFIG_FILE=services/test/cfg/<...>`), waiting for the bind port of `listens: true` entries. Order matters: gates create the Iggy topics, so stream consumers must come after them. Every child's stdout/stderr line is re-printed with a `[bin]` prefix. Children run in their own process group; Ctrl-C/SIGTERM on `run` SIGTERMs them all (SIGKILL after 10s).
  - `cargo run --bin test [-- <libtest args>]` (`src/bin/test/main.rs`) — checks `api-gate`/`ws` are up, then runs `cargo test --bin test`, i.e. the `#[cfg(test)]` modules of the `test` binary itself. Tests talk to the system **only over HTTP/WebSocket via `api-gate` or `ws`**. Gates are **providers** behind `gate::Gate` (`gate/api.rs` = `ApiGate`, stateless HTTP; `gate/ws.rs` = `WsGate`, one connection per client): shared scenarios are written once as `async fn name<G: Gate>()` in `tests/*.rs` and listed in `for_all_gates!`, which generates `…::api::name` and `…::ws::name` tests (filter with `-- ::ws::`). Replies are normalized to `GateReply { status, error_msg, payload }` — HTTP status / ws `ErrCode` / ws close 1008 → 403 — so assertions are identical across gates. Credentials (incl. deliberately broken ones) are `gate::Auth` (`None`, `Key`, `SignedByOther`, `TamperedBody`, `UnknownKey`). Keys come from `keys::main_key()`/`other_key()`, created once per test process. Transport-specific cases live in `tests/api_only.rs` / `tests/ws_only.rs`.
  - Add a service = add a `services.json` entry + its config copy in `cfg/`.

Every service/gate crate has its own `dev.json` (loaded relative to CWD, see Configuration below) and its own nested `.git` (these subtrees are separate repos, not submodules of the outer one — no shared history). Local infra now also includes RabbitMQ (`skw-rabbitmq`, management UI on `:15672`) and Redis (`skw-redis`, ACL-authenticated) containers alongside Postgres/Iggy.

## Commands

```bash
cargo build                       # build all; --release for prod profile
cargo fmt                         # rustfmt.toml present (max_width=300, edition 2024)
cargo clippy --all-targets

# Run a service/gate — MUST cd into the crate dir first (see config gotcha below)
cd services/auth && cargo run --bin auth-http-service    # axum: GetKeyById (/internal), CreateKey (/)
cd services/auth && cargo run --bin auth-stream-service   # Iggy consumer: CreateKey, routable via a gate's topicsMap
cd services/ping && cargo run --bin ping-stream-service   # the real ping worker (Iggy consumer)
cd services/ping && cargo run --bin ping-http-service      # empty stub, does nothing
cd gates/api      && cargo run --bin api-gate

# Dev-only helper binaries in gates/api
cd gates/api && cargo run --bin sign       # signs a hardcoded Ping payload with the seeded root key, prints base64 signature
cd gates/api && cargo run --bin testback   # publishes a fake backend response straight onto the back topic, for testing the gateway's response fan-in without a real service

# Migrations (sqlx) — also run from the crate dir; takes up|down as argv[1]
cd services/auth && cargo run --bin migrate -- up
cd services/ping && cargo run --bin migrate -- up
cd services/auth && cargo run --bin migrate -- down   # reverts last migration

# Local infra (postgres, iggy, iggy-web-ui, redis) + containerized gate/auth
docker compose up
```

Note: `services/auth` and `services/ping` both produce a binary literally named `migrate` — building `--workspace` triggers a (currently harmless) Cargo "output filename collision" warning; build/run them one crate at a time if you need both.

Integration tests: `cd services/test && cargo run --bin run` in one terminal, `cargo run --bin test` in another (see `services/test` above). `services/auth/tests/requests.hurl` exists but is empty.

`skw-lib-shared` honors `SKW_CONFIG_FILE=<path>`: if set, the config is read from that file instead of `./{ENV}.json` (CWD is still the base for `./migrations` and relative paths).

## Configuration (critical gotcha)

`skw_lib_shared::APP` is a `LazyLock<AppContext>` initialized on first deref via `init_by_env()`. It reads `./{ENV}.json` **from the process's current working directory** (`ENV` env var, default `"dev"`). Migrations likewise resolve `./migrations` relative to that same path. **Therefore binaries must be launched from their own crate directory** (where `dev.json` and `migrations/` live), not the workspace root — otherwise config loading panics.

Config access is fail-fast: `APP.config.expect_str/expect_string/expect_u32/expect_u64/expect_bool/...` panic on missing/wrong-typed keys; `.get(path)` returns `Option<&Value>` for optional config. Values are addressed by JSON Pointer paths (e.g. `/iggy/url`).

Each `dev.json` has an `/envOverrides` object mapping a JSON-pointer-into-the-config → an env var name. At startup any present env var overwrites the value at that pointer (type-preserving). This is how the Docker setup injects `POSTGRES_MASTER_URL`, `IGGY_URL`, `SERVICE_BIND_ADDRESS`, etc.

## Shared-library architecture (`libs/shared`)

Leans heavily on the **typestate pattern** (`PhantomData<S>` + marker structs) to make lifecycle stages compile-checked:

- `Config<ConfigNew>` → `.load()` → `Config<ConfigReady>` → `.override_values_from_env()`.
- `PostgresPools<Loaded>` → `.connect().await` → `PostgresPools<Connected>` (only the `Connected` state exposes `.master()`/`.slave()`).
- `Iggy<Loaded>` → `.connect().await` → `Iggy<Connected>` (only `Connected` exposes `.inner() -> Arc<IggyClient>`).

`AppContext` (the `APP` singleton) bundles the loaded-but-not-yet-connected `config`, `postgres`, and `iggy`; services call `.connect()` in `main` to get usable pools/clients. `AppError` is the crate-wide error enum (`thiserror`, `From` conversions for Postgres/Iggy/Reqwest/Migrate/ServiceHttp/Serde errors).

**Postgres**: master/slave `PgPool`s. `after_connect` optionally runs `CREATE SCHEMA`/`SET search_path` per service (`createServiceSchema` / `setSearchPathByService` config flags under `/postgres/master` and `/postgres/slave`) so each service is namespaced to its own Postgres schema named after `/service/name`. Migrations use sqlx's `Migrator` against the master pool.

**Iggy** (message bus, `libs/shared/src/iggy.rs`): the low-level typestate client wrapper plus `TopicConfig` (parsed from a JSON object with `customName`/`partitionsCount`/`compressionAlgorithm`/`messageExpiry`/`maxTopicSize`). Naming helpers in `lib.rs`, all reading from config, no args needed for the common case: `skw_get_stream_name()` (`"{iggy.streamPrefix}-{crate VERSION}"`), `skw_get_stream_topic_name()` (derived from `/service/name`, stripped of `skw-`/`-service`), `skw_get_back_topic_name()` (`"gate-back-{VERSION}"`, shared by every service), `skw_get_consumer_name(topic)`.

**Cross-service RPC over Iggy** (`libs/shared/src/iggy_rpc.rs`): `run_service_consumer::<Req, H, Fut, Resp>(handler)` is the generic consumer-group loop every backend service (currently only `services/ping`) should use instead of hand-rolling it. It connects, builds the consumer group on the service's own topic and a producer on the shared back topic, and per message: converts `ReceivedMessage` into `Req` (a type implementing the shared `RpcMessage` trait — `type Method`, `fn signature(&self)`, `fn into_result(self) -> Result<Method, ServiceHttpError>`), calls your `handler(method) -> Result<Resp, ServiceHttpError>`, serializes the result, and republishes it on the back topic carrying the original `signature` header (or a `response-code` header + empty body on error).

Because `skw-lib-shared` cannot depend on `skw-lib-http-protos` (cycle), the bridge is a **blanket impl**: `libs/http-protos/src/lib.rs` implements `RpcMessage` for `JsonRpcServiceRequest<T>` (legal under the orphan rule since `JsonRpcServiceRequest` is local to that crate). Concretely, a new service's `stream.rs` should look like:
```rust
run_service_consumer::<JsonRpcServiceRequest<HttpMethod>, _, _, _>(handle_message).await?;
// (turbofish on Req is mandatory — it only appears via trait bounds, type inference can't find it)
async fn handle_message(method: HttpMethod) -> Result<HttpPayload, ServiceHttpError> { ... }
```
See `services/ping/src/stream.rs` for the full reference example — that file is deliberately tiny (a handler + `main`); anything more than domain logic in a service's `stream.rs` is a sign it should move into `libs/shared`.

**`prelude`** re-exports the curated public surface (`prelude::axum::*`, `prelude::iggy::*` — includes `run_service_consumer`/`RpcMessage` plus the whole `iggy::prelude`, `prelude::postgres::*`, `prelude::jsonrpc::*`, `prelude::log::*`, `prelude::tools::*` — the `skw_get_*` helpers, `prelude::consts::*`). Service code imports `skw_lib_shared::prelude::*` (or specific submodules) rather than reaching into crate internals.

**JSON-RPC / HTTP glue** (`libs/shared/src/jsonrpc.rs`): `ServiceHttpError` (`NotFound`/`Forbidden`/`BadRequest`/`UnprocessableEntity`, has a `Display` used both as an HTTP-status mapping and as the Iggy `response-code` header value), `JsonRpcResponse<REQ,RESP>`/`JsonRpcErrorResponse<REQ>` for axum handlers, `internal_http_request()` for one internal service calling another over plain HTTP (used by the gateway to call the auth service).

## Cross-cutting request flow: gateway ↔ Iggy ↔ service

This is the actual live architecture (`gates/api` + any Iggy-consuming service), worth understanding end-to-end before touching either side:

1. **Startup (gate)**: `gates/api/src/main.rs::init_iggy` creates the shared Iggy stream and the shared back topic, then reads `/topicsMap` from `dev.json` (`{"ping": {"partitionsCount": 10, "messageExpiry": 31, ...}}`) — one entry per backend service. For each entry it creates that service's dedicated topic and an Iggy producer for it, collected into `RoutesMap { map: HashMap<service_name, Arc<IggyProducer>> }` (keyed by the **first HTTP path segment**, e.g. `POST /ping` → key `"ping"`).
2. **Startup (gate, response fan-in)**: `gate.rs::GateState::new` opens one consumer group on the shared back topic and spawns a background task that loops forever, broadcasting every received message (via `tokio::sync::broadcast::Sender<IggyReceivedMessage>`, capacity 10 000) to all currently-subscribed request handlers.
3. **Per-request (gate)**: `catch_all` (the gateway's only route — everything is a catch-all, no per-endpoint routing) resolves the path-segment → producer via `routes_map`; for mutating methods it validates the body parses as `JsonRpcGateHttpRequest`, calls `auth::check_auth_key_and_request_signature` (reads `API-KEY` + `PAYLOAD-SIGNATURE` headers, fetches the entity's public key from `skw-auth-http-service` via `internal_http_request(HttpMethod::GetKeyById)`, verifies the ed25519 signature locally), then publishes the raw body to the service's Iggy topic with `signature`/`api-key`/`method` headers, subscribes to the broadcast channel, and waits (30s timeout) for a message whose `signature` header matches — this string doubles as the request/response correlation ID.
4. **Backend service**: consumes its own topic via `run_service_consumer` (see above), runs domain logic, republishes on the shared back topic with the same `signature` header (+ `response-code` header on error).
5. **Gate**: the waiting `catch_all` call sees its correlation ID pass through the broadcast stream, maps `service_error` (if any) to an HTTP status, and returns the payload as the HTTP response body.

## `services/auth` specifics

Owns the `entities`/`roles` Postgres schema (`migrations/`): `entities` form a self-parented tree (`parent_id` FK to `entities.id`, root `01a01500-98d5-71fc-9038-71acb78d61c4` points at itself, seeded with role `{0}`); `roles` carry a `role_scope` enum (`AllChilds`/`FullTree`/`SelfOnly`) plus `role_service`/`role_entities`/`role_actions` text-array columns (`'*'` = wildcard) for authorization; role `0` is seeded as full-access-to-everything. Public/private keys are stored as bare base64 (SPKI/PKCS#8 PEM armor stripped).

`internal.rs::http_handler` at `POST /internal` dispatches `HttpMethod::GetKeyById { id }` → `Entity::get_by_id` (reads the **slave** pool) → `HttpPayload::GetKeyById { id, public_key, enabled }` — this method is internal-only, HTTP-only, never Iggy-routed (no `impl_try_from_iggy_message!` on `auth::internal::HttpMethod`). `external.rs::http_handler` at `POST /` (axum, `auth-http-service`) and `stream.rs::handle_message` (Iggy, `auth-stream-service`) both dispatch the top-level (public) `HttpMethod::CreateKey { store_private_key }` → `keygen::create_key` (ed25519 keygen + `Entity::insert` on the **master** pool, always parented to/created-by the seeded root entity read from `/service/rootKey` config) → `HttpPayload::CreateKey { id, public_key, private_key, enabled }` — the private key is always returned to the caller; `store_private_key` only controls whether it's also persisted to the `private_key` column. No role-assignment endpoints exist yet, despite the schema supporting them. `main.rs` has two commented-out routes (`/register`, `/check_signature`) whose handler functions don't exist anywhere in the crate — dead/aspirational, not "logic written but disabled".

## `services/ping` specifics

Reference/template for a minimal Iggy-consuming service — see "Cross-service RPC over Iggy" above. `migrations/` defines an unused `ping` table (never queried from Rust) and currently has a SQL syntax bug (trailing comma before the closing paren in the `up` migration) — don't copy that migration as a template.

## Known discrepancies vs. aspirational docs/config (worth knowing before "fixing" something that's actually just unfinished)

- **TLS is not self-signed-at-startup.** `gates/api/src/tls.rs` only loads a pre-existing cert/key pair from disk (paths in `dev.json`'s `service.tls.certPath`/`keyPath`). `rcgen` is a declared dependency and `dev.json` has a `subjectAltNames` list that looks exactly like input for `rcgen::generate_simple_self_signed`, but no such call exists anywhere — the feature is scaffolded, not implemented. Cert/key currently live at `conf/skw-api-gate.cert.pem`/`.key.pem` and must be pre-provisioned.
- **ed25519 verification lives in the gateway, not in `skw-auth-http-service`.** `gates/api/src/auth.rs` does the actual `VerifyingKey::verify(...)` call; `skw-auth-http-service`/`skw-auth-stream-service` only serve the public-key lookup (`GetKeyById`) and key creation (`CreateKey`). There is no commented-out verification code inside `services/auth` — that idea doesn't match the current code.
- **`ed25519-dalek`/`base64`/`rand` are unused dependencies in `services/auth`'s `Cargo.toml`** (leftover from being copy-pasted off `services/ping`'s `Cargo.toml`, which needed them at the time).

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
