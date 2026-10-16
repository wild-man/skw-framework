// Minimal api-gate client: JSON-RPC bodies `{"Ts", "Method", "Params"}` POSTed to `/{service}/{topicType}`.
// Signed requests carry `API-KEY` (entity id) + `PAYLOAD-SIGNATURE` (base64 ed25519 signature of the exact body bytes).

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
