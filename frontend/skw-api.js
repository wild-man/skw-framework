// Minimal api-gate client: JSON-RPC bodies `{"Ts", "Method", "Params"}` POSTed to `/{service}/{topicType}`.
// Signed requests carry `API-KEY` (entity id) + `PAYLOAD-SIGNATURE` (base64 ed25519 signature of the exact body bytes).
// Plus a ws-gate client (`WsGate`) speaking the same bodies as `Data` of `{"Signature", "Uri", "Data"}` frames.

const HEADER_API_KEY = "API-KEY";
const HEADER_PAYLOAD_SIGNATURE = "PAYLOAD-SIGNATURE";

// PKCS#8 v1 prefix of an ed25519 private key; followed by the 32-byte seed
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const PKCS8_SEED_OFFSET = PKCS8_ED25519_PREFIX.length;
const ED25519_SEED_LEN = 32;

export class GateError extends Error {
  constructor(status, body) {
    super(`gate responded ${status}${body ? `: ${body}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/// JSON-RPC gate body; this exact string is what gets signed and sent.
export function gateBody(method, params = {}) {
  return JSON.stringify({ Ts: new Date().toISOString(), Method: method, Params: params });
}

/// An entity key from `CreateKey`, able to sign request bodies.
export class ApiKey {
  constructor(id, privateKey, cryptoKey) {
    this.id = id;
    this.privateKey = privateKey;
    this.cryptoKey = cryptoKey;
  }

  /// `privateKey` is the auth service's bare base64 PKCS#8 DER. Its layout (v1 or v2 with the public key)
  /// varies, while WebCrypto reliably imports only v1, so the key is rebuilt from its seed.
  static async import(id, privateKey) {
    const der = base64ToBytes(privateKey);
    const seed = der.slice(PKCS8_SEED_OFFSET, PKCS8_SEED_OFFSET + ED25519_SEED_LEN);
    if (seed.length !== ED25519_SEED_LEN) {
      throw new Error("private key is not an ed25519 PKCS#8 key");
    }

    const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...seed]);
    const cryptoKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    return new ApiKey(id, privateKey, cryptoKey);
  }

  async sign(body) {
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, this.cryptoKey, new TextEncoder().encode(body));
    return bytesToBase64(signature);
  }
}

export class ApiGate {
  constructor(url) {
    this.url = url.replace(/\/+$/, "");
  }

  /// Open (unauthenticated) request.
  async open(service, method, params) {
    return this.post(`/${service}/open`, gateBody(method, params), {});
  }

  /// Signed request on behalf of `apiKey`.
  async signed(service, apiKey, method, params) {
    const body = gateBody(method, params);
    const headers = {
      [HEADER_API_KEY]: apiKey.id,
      [HEADER_PAYLOAD_SIGNATURE]: await apiKey.sign(body),
    };
    return this.post(`/${service}/signed`, body, headers);
  }

  /// Resolves to the parsed reply payload, rejects with `GateError` on a non-2xx status.
  async post(path, body, headers) {
    const resp = await fetch(this.url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });

    const text = await resp.text();
    if (!resp.ok) {
      throw new GateError(resp.status, text);
    }
    return text ? JSON.parse(text) : null;
  }
}

// ws gate closes the connection with this code when it refuses credentials
const WS_CLOSE_POLICY = 1008;

/// ws-gate client, one connection (`wss://host:port/ws/`). Signed topics need a prior `authorize(apiKey)`,
/// after which every frame's `Signature` is the ed25519 signature of its `Data`. Replies
/// `{"Signature", "Status", "ErrorMsg", "ErrCode", "Payload"}` are matched to requests by `Signature`.
/// A request settles on its first reply: a provisional one (`Status` 201/202) resolves it, and the
/// final reply that follows under the same `Signature` is ignored (logged as an unexpected frame).
/// A signed frame with an outdated `Ts` (> 30s from the gate clock) is rejected with `ErrCode` 409.
/// Server pings are answered by the browser itself, which keeps the connection alive.
export class WsGate {
  constructor(socket) {
    this.socket = socket;
    this.apiKey = null;
    // request signature -> { resolve, reject }; the Authorize reply carries no signature, see `authorizing`
    this.pending = new Map();
    this.authorizing = null;
    /// called with a `GateError` (policy close) or `Error` once the connection is gone
    this.onclose = null;

    socket.addEventListener("message", (e) => this.onMessage(e.data));
    socket.addEventListener("close", (e) => this.onClose(e));
  }

  /// Resolves once the connection is open. A browser hides the failure reason (TLS, refused, ...).
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const fail = () => reject(new Error(`ws connection to ${url} failed`));
      socket.addEventListener("error", fail, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.removeEventListener("error", fail);
          resolve(new WsGate(socket));
        },
        { once: true },
      );
    });
  }

  /// Authorizes the connection as `apiKey`; rejects with `GateError(403)` if the gate refuses it.
  async authorize(apiKey) {
    const data = gateBody("Authorize", { ApiKey: apiKey.id });
    const signature = await apiKey.sign(data);
    const reply = new Promise((resolve, reject) => (this.authorizing = { resolve, reject }));
    this.send(null, data, signature);
    await reply;
    this.apiKey = apiKey;
  }

  /// Open (unauthenticated) request; `Signature` is just a request id here.
  async open(service, method, params) {
    const data = gateBody(method, params);
    return this.request(`/${service}/open`, data, crypto.randomUUID());
  }

  /// Signed request on behalf of the authorized key.
  async signed(service, method, params) {
    if (!this.apiKey) {
      throw new Error("ws connection is not authorized");
    }
    const data = gateBody(method, params);
    return this.request(`/${service}/signed`, data, await this.apiKey.sign(data));
  }

  close() {
    this.socket.close();
  }

  /// Resolves to the reply payload, rejects with `GateError` when the reply carries an `ErrCode`.
  request(uri, data, signature) {
    const reply = new Promise((resolve, reject) => this.pending.set(signature, { resolve, reject }));
    this.send(uri, data, signature);
    return reply;
  }

  /// `data` is embedded verbatim: the gate verifies the signature over these exact bytes.
  send(uri, data, signature) {
    const uriPart = uri === null ? "" : `,"Uri":${JSON.stringify(uri)}`;
    this.socket.send(`{"Signature":${JSON.stringify(signature)}${uriPart},"Data":${data}}`);
  }

  onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      console.error("ws gate sent a non-json frame", text, e);
      return;
    }

    if (msg.Authorized === true && this.authorizing) {
      this.authorizing.resolve();
      this.authorizing = null;
      return;
    }

    const waiting = this.pending.get(msg.Signature);
    if (!waiting) {
      // pushes and replies nobody waits for (yet) are not handled
      console.debug("unexpected ws frame", msg);
      return;
    }
    this.pending.delete(msg.Signature);
    if (msg.ErrCode) {
      waiting.reject(new GateError(msg.ErrCode, msg.ErrorMsg));
    } else {
      waiting.resolve(msg.Payload ?? null);
    }
  }

  onClose(e) {
    const err = e.code === WS_CLOSE_POLICY ? new GateError(403, e.reason) : new Error(`ws connection closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`);

    this.authorizing?.reject(err);
    this.authorizing = null;
    for (const waiting of this.pending.values()) {
      waiting.reject(err);
    }
    this.pending.clear();
    this.onclose?.(err);
  }
}
