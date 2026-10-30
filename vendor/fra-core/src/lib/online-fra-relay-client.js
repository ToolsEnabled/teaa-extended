'use strict';

// The hosted-relay client -- the piece the paid lane's records called "the
// item with the longest history of being unbuilt": nothing anywhere dialled
// the relay. This dials it.
//
// TRANSPORT ONLY, deliberately. The relay moves opaque frames it cannot read;
// the sealing that makes them opaque is online-fra-e2e-session.js and stays
// ABOVE this layer -- this module never imports node:crypto and never sees a
// key. It speaks exactly the admission protocol the relay's websocket adapter
// enforces:
//
//   1. connect wss://<relay>/v1/rendezvous  (TLS is the edge's business:
//      nginx terminates it in production; locally the test injects the
//      socket implementation)
//   2. ADMISSION, one of two doors, chosen by whether `proof` is supplied:
//        key door (the live edge, since 2026-08-20): the edge speaks FIRST --
//          one text frame {"challenge": nonce} -- and this client answers
//          with exactly {lease, publicKeySpki, nonce, signature}, the
//          signature being proof.sign() over the nonce bytes. The key is the
//          machine's own Ed25519 identity key, which never left the machine;
//          the lease the account server minted commits to its fingerprint.
//        certificate door (an edge that terminates mTLS): this client speaks
//          first with exactly {"lease": <lease>}, as before.
//   3. everything after: binary frames only, both directions, and EVERY frame
//      carries one leading LEG BYTE -- 0x01 machine-a, 0x02 machine-b, 0x03
//      web-client. Outbound it names the target leg; inbound it names the
//      source. The relay routes a pair as three legs over one socket each,
//      and the byte is the only address there is. It is stripped before
//      onFrame() sees the payload and added by send(); nothing sealed is
//      touched.
//   4. a lease lives at most 15 minutes; the far end closes at expiry, and the
//      caller reconnects with a FRESH lease (never the old one -- its nonce is
//      spent). This client surfaces expiry as a close; the retry policy
//      belongs to the caller, because only the caller knows whether the human
//      walked away.
//
// The WebSocket implementation is INJECTED (browser-shape: addEventListener,
// send, close, binaryType). Node >= 22 provides globalThis.WebSocket, which is
// the default; tests inject a fake; a deployment that needs client
// certificates at the socket layer injects its own. This keeps the engine's
// zero-dependency rule intact.
const { clonePlainJson, encodePlainJson, parseStrictJsonString } = require('./online-fra-strict-json');

class OnlineFraRelayClientError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OnlineFraRelayClientError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraRelayClientError(code, message); }

// The relay's admission nonce is 32 random bytes rendered base64url and nothing
// else -- see NONCE_BYTES in the relay's online-fra-web-admission.js.
// Pinning that exact shape is what keeps the key door from being a signing
// oracle on the device identity key; see the check in the admission handler.
const RELAY_CHALLENGE_BYTES = 32;
const RELAY_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

const CLOSE_NORMAL = 1000;
/* WebSocket.OPEN, spelled out rather than read off the class: the
   implementation is injected (see the header), so the constant is not reliably
   in scope, while the numeric ready states are fixed by the spec. */
const SOCKET_OPEN = 1;
const MAX_WIRE_FRAME_BYTES = 256 * 1024 + 1; // one leg byte plus the sealed-frame ceiling
const MAX_ADMISSION_BYTES = 16 * 1024;
const LEASE_SCHEMA_VERSION = 'online-fra-lease.v1';
const SAFE_ID = /^[a-z][a-z0-9_-]{2,95}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function canonicalEd25519Spki(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/.test(value)) return false;
  let der;
  try { der = Buffer.from(value, 'base64url'); } catch { return false; }
  return der.length === 44 && der.toString('base64url') === value
    && der.subarray(0, 12).toString('hex') === ED25519_SPKI_PREFIX;
}

function validProof(value) {
  return plain(value) && typeof value.sign === 'function'
    && canonicalEd25519Spki(value.publicKeySpki);
}

function leaseAdmissionBytes(lease) {
  let safe;
  try { safe = clonePlainJson(lease, { maxBytes:MAX_ADMISSION_BYTES, maxDepth:16, maxValues:128 }).value; }
  catch { safe = null; }
  if (!plain(safe) || safe.schemaVersion !== LEASE_SCHEMA_VERSION
      || !SAFE_ID.test(safe.leaseId) || !Object.hasOwn(LEG_BYTE, safe.endpointRole)
      || !Number.isSafeInteger(safe.expiresAtMs) || safe.expiresAtMs < 1
      || typeof safe.signature !== 'string' || safe.signature.length < 1
      || safe.signature.length > 1024) {
    fail('RELAY_CLIENT_LEASE_INVALID', 'A bounded minted lease with a known endpoint role is required.');
  }
  let wire;
  try { wire = encodePlainJson({ lease:safe }, { maxBytes:MAX_ADMISSION_BYTES, maxDepth:16, maxValues:128 }).toString('utf8'); }
  catch { fail('RELAY_CLIENT_LEASE_INVALID', 'The minted lease is not serializable.'); }
  return Object.freeze({ lease:safe, wire });
}

/**
 * Dial the relay once, with one lease. Resolves to a live connection:
 *   { send(bytes), close(), closed: Promise<{code, reason}> }
 *
 * options:
 *   url         wss://host/v1/rendezvous (or ws:// under an injected local edge)
 *   lease       the minted lease object (sent verbatim as the admission frame)
 *   onFrame     (Buffer) => void   -- every binary frame from the peer
 *   WebSocketImpl  optional; defaults to globalThis.WebSocket
 *   admissionTimeoutMs  optional, default 10_000 -- matches the adapter's own
 */
const LEG_BYTE = Object.freeze({ 'machine-a': 0x01, 'machine-b': 0x02, 'web-client': 0x03 });
const LEG_ROLE = Object.freeze({ 0x01: 'machine-a', 0x02: 'machine-b', 0x03: 'web-client' });

function connectOnlineFraRelay({ url, lease, onFrame, proof, WebSocketImpl, admissionTimeoutMs = 10_000,
  allowInsecureLoopback = false } = {}) {
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
  const loopback = parsedUrl && ['127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
  const transportAllowed = parsedUrl && (parsedUrl.protocol === 'wss:'
    || (allowInsecureLoopback === true && loopback && parsedUrl.protocol === 'ws:'));
  if (!transportAllowed || parsedUrl.username || parsedUrl.password
      || parsedUrl.pathname !== '/v1/rendezvous' || parsedUrl.search || parsedUrl.hash
      || parsedUrl.toString() !== url) {
    fail('RELAY_CLIENT_URL_INVALID', 'The relay URL must be the exact wss:// origin plus /v1/rendezvous; ws:// is limited to an explicitly enabled literal loopback test endpoint.');
  }
  if (typeof allowInsecureLoopback !== 'boolean'
      || !Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs < 1 || admissionTimeoutMs > 60_000) {
    fail('RELAY_CLIENT_OPTIONS_INVALID', 'Relay client security and timeout options are invalid.');
  }
  if (typeof onFrame !== 'function') fail('RELAY_CLIENT_OPTIONS_INVALID', 'onFrame is required.');
  if (proof !== undefined && !validProof(proof)) {
    fail('RELAY_CLIENT_OPTIONS_INVALID', 'proof must carry a canonical Ed25519 public key and sign(nonceBytes), or be absent for the certificate door.');
  }
  const checkedAdmission = leaseAdmissionBytes(lease);
  lease = checkedAdmission.lease;
  const admissionWire = checkedAdmission.wire;
  const ownLeg = LEG_BYTE[lease.endpointRole];
  const Impl = WebSocketImpl || globalThis.WebSocket;
  if (typeof Impl !== 'function') fail('RELAY_CLIENT_OPTIONS_INVALID', 'No WebSocket implementation available; inject one.');

  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new Impl(url);
      if (!socket || typeof socket.addEventListener !== 'function'
          || typeof socket.send !== 'function' || typeof socket.close !== 'function') throw new Error('surface');
      socket.binaryType = 'arraybuffer';
    } catch {
      reject(new OnlineFraRelayClientError('RELAY_CLIENT_SOCKET_INVALID', 'The WebSocket implementation could not create a usable connection.'));
      return;
    }

    let settled = false;
    let admitted = false;
    let closing = false;
    /* IN-PLACE LEASE RENEWAL, v1. One renewal in flight at a time; the relay
       answers on the same socket with a fresh challenge, then {renewed} or
       {renewalRefused}. A relay that predates this protocol ignores text after
       admission, so the only signal of "unsupported" is silence: the caller gets
       a timeout and falls back to the close-and-redial it has always done.
       Nothing here changes what happens on the socket unless renew() is called. */
    let renewal = null;
    let closeSettler;
    const closed = new Promise(resolveClosed => { closeSettler = resolveClosed; });

    const rejectAdmission = (code, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(admissionTimer);
      reject(new OnlineFraRelayClientError(code, message));
      try { socket.close(); } catch { /* already dead */ }
    };

    // The adapter enforces its own admission timeout server-side; this one
    // exists so a black-holed connection fails HERE with a named code instead
    // of hanging a caller forever.
    const admissionTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { socket.close(); } catch { /* already dead */ }
        reject(new OnlineFraRelayClientError('RELAY_CLIENT_ADMISSION_TIMEOUT', 'The relay did not answer the admission frame in time.'));
      }
    }, admissionTimeoutMs);
    if (admissionTimer.unref) admissionTimer.unref();

    const connection = Object.freeze({
      /**
       * Send one sealed payload to one leg of the pair. `to` is the target
       * role; a machine talking to its peer names the peer's role, a machine
       * answering the browser names 'web-client', a browser names either
       * machine. The leg byte is prepended here and nowhere else.
       */
      send(bytes, { to } = {}) {
        /* THE MIRROR OF online-fra-web-client.mjs sendTo, AND FOR THE SAME
           REASON. A send on a CLOSING or CLOSED socket discards the frame and
           reports it to a callback nobody passed, rather than throwing -- so
           the shell's `catch { socket gone }` around every call site here was
           decorative, a dropped hello looked exactly like a delivered one, and
           the shell went on to install a session and log that a browser was
           connected when nothing had left this machine. Refusing by name makes
           those catches the real handlers they were written to be. */
        if (closing || socket.readyState !== SOCKET_OPEN) fail('RELAY_CLIENT_CLOSED', 'The relay connection closed.');
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
            || bytes.byteLength >= MAX_WIRE_FRAME_BYTES) {
          fail('RELAY_CLIENT_FRAME_INVALID', 'Frames must be nonempty bounded binary values; seal first.');
        }
        const target = LEG_BYTE[to];
        if (target === undefined || target === ownLeg) fail('RELAY_CLIENT_FRAME_INVALID', 'send() needs a target leg other than this endpoint\'s own: machine-a, machine-b or web-client.');
        const framed = new Uint8Array(bytes.byteLength + 1);
        framed[0] = target;
        framed.set(bytes, 1);
        socket.send(framed);
      },
      // Unlike the internal cleanup closes above, this is the caller's request:
      // a synchronous WebSocket failure means the request could not be
      // established, so preserve that observable distinction by letting it
      // propagate rather than returning as though close had been initiated.
      close() {
        if (closing) return;
        closing = true;
        try { socket.close(CLOSE_NORMAL); }
        catch (error) { closing = false; throw error; }
      },
      closed,
      /* Re-admit this SAME socket with a fresh lease, so the legs riding on it
         (the browser's above all) outlive the lease that admitted it. Resolves
         {leaseId, expiresAtMs} from the relay's own answer. */
      renew({ lease: freshLease, proof: renewProof, timeoutMs = 10_000 } = {}) {
        if (closing || socket.readyState !== SOCKET_OPEN) return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
        let checkedRenewal;
        try { checkedRenewal = leaseAdmissionBytes(freshLease); }
        catch (error) { return Promise.reject(error); }
        if (!validProof(renewProof)) return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_PROOF_FAILED', 'Renewal needs a canonical Ed25519 key proof.'));
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
          return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_OPTIONS_INVALID', 'The renewal timeout is invalid.'));
        }
        if (renewal) return Promise.reject(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_BUSY', 'A renewal is already in flight on this connection.'));
        return new Promise((resolveRenewal, rejectRenewal) => {
          const finish = (error, value) => {
            if (!renewal || renewal.timer === null) return;
            clearTimeout(renewal.timer);
            renewal = null;
            if (error) rejectRenewal(error); else resolveRenewal(value);
          };
          const timer = setTimeout(() => finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_TIMEOUT', 'The relay did not answer the renewal; it may not support renewing a lease in place.')), timeoutMs);
          if (timer.unref) timer.unref();
          renewal = { lease: checkedRenewal.lease, proof: renewProof, timer, finish, signed: false };
          try { socket.send(encodePlainJson({ renew:'request' }, { maxBytes:256, maxDepth:2, maxValues:4 }).toString('utf8')); } catch {
            finish(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
          }
        });
      }
    });
    const settleAdmitted = () => {
      // The adapter sends nothing on success -- admission is silent, and the
      // first evidence of it is the connection staying open. Resolve on the
      // next tick after the admission frame: a refused one closes immediately,
      // and the 'close' handler below wins the race by settling first.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(admissionTimer);
        resolve(connection);
      }, 0);
    };

    socket.addEventListener('open', () => {
      // SET BEFORE THE SEND, not after. This flag means "we got far enough to
      // present a lease", which is what separates a refusal from an
      // unreachable relay -- and a transport whose send() closes SYNCHRONOUSLY
      // on a bad lease (the local edge does exactly this) would otherwise run
      // the close handler while the flag was still false and report a refusal
      // as unreachable. Observed, not imagined: the acceptance test caught it.
      admitted = true;
      if (proof) return; // the key door: the edge speaks first; see 'message'
      // The certificate door: the one and only text frame this client sends.
      try { socket.send(admissionWire); } catch {
        rejectAdmission('RELAY_CLIENT_ADMISSION_SEND_FAILED', 'The admission frame could not be sent to the relay.');
        return;
      }
      settleAdmitted();
    });

    let challenged = false;
    socket.addEventListener('message', event => {
      let data;
      try { data = event && event.data; } catch { return; }
      if (typeof data === 'string') {
        // Exactly one text frame is ever expected on the key door before
        // admission: the challenge. After admission, text is parsed ONLY while
        // a renewal this client started is in flight (see renew()); any other
        // text is dropped rather than parsed, because parsing unexpected input
        // from the network is how clients grow holes.
        if (renewal && settled) {
          let answer;
          if (Buffer.byteLength(data, 'utf8') > MAX_ADMISSION_BYTES) {
            renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_RESPONSE_INVALID', 'The relay sent an oversized renewal response.'));
            return;
          }
          try { answer = parseStrictJsonString(data, {
            maxBytes:MAX_ADMISSION_BYTES, maxDepth:16, maxValues:2048,
          }); } catch {
            renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_RESPONSE_INVALID', 'The relay sent an unreadable renewal response.'));
            return;
          }
          if (typeof answer.challenge === 'string' && answer.renewal === true) {
            if (!exactKeys(answer, ['challenge', 'expiresAtMs', 'renewal'])
                || !Number.isSafeInteger(answer.expiresAtMs) || answer.expiresAtMs < 1) {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_RESPONSE_INVALID', 'The relay sent an invalid renewal challenge.'));
              return;
            }
            /* RENEWAL IS NOT A SIGNING SERVICE EITHER (security review 1.0.50 H2).
             *
             * This branch kept the floor the admission handler below dropped --
             * `length >= 16`, no ceiling, no format -- and signed every such
             * challenge that arrived while a renewal was in flight, with the same
             * device identity key that signs E2E handshake leases. A relay could
             * hand it canonical lease bytes carrying its own X25519 ephemeral and
             * stockpile forged hellos, several per renewal window. The admission
             * rule applies here unchanged (an honest relay's renewal nonce is the
             * same 32 random bytes, base64url), and a renewal signs AT MOST ONCE:
             * a further challenge inside the same renewal is ignored, exactly as a
             * second admission challenge is. */
            if (renewal.signed) return;
            let challengeBytes = null;
            if (RELAY_CHALLENGE_RE.test(answer.challenge)) {
              try { challengeBytes = Buffer.from(answer.challenge, 'base64url'); } catch { challengeBytes = null; }
            }
            if (!challengeBytes || challengeBytes.length !== RELAY_CHALLENGE_BYTES
                || challengeBytes.toString('base64url') !== answer.challenge) {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_CHALLENGE_INVALID',
                'The relay offered a renewal challenge that is not a single fresh nonce; nothing was signed.'));
              return;
            }
            renewal.signed = true;
            let signature;
            try { signature = renewal.proof.sign(challengeBytes); } catch {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_PROOF_FAILED', 'The relay renewal challenge could not be signed.'));
              return;
            }
            let wire;
            if (signature instanceof Uint8Array && signature.length === 64) wire = Buffer.from(signature).toString('base64url');
            else if (typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature)
              && Buffer.from(signature, 'base64url').length === 64
              && Buffer.from(signature, 'base64url').toString('base64url') === signature) wire = signature;
            else {
              if (signature && typeof signature.then === 'function') Promise.resolve(signature).catch(() => {});
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_PROOF_FAILED', 'The relay renewal proof was not a canonical Ed25519 signature.'));
              return;
            }
            try {
              socket.send(encodePlainJson({ renew: renewal.lease, publicKeySpki: renewal.proof.publicKeySpki,
                nonce: answer.challenge, signature: wire }, {
                maxBytes:MAX_ADMISSION_BYTES, maxDepth:16, maxValues:128,
              }).toString('utf8'));
            } catch {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
            }
            return;
          }
          if (exactKeys(answer, ['renewed'])) {
            if (!renewal.signed || !exactKeys(answer.renewed, ['leaseId', 'expiresAtMs'])
                || !SAFE_ID.test(answer.renewed.leaseId)
                || !Number.isSafeInteger(answer.renewed.expiresAtMs)
                || answer.renewed.leaseId !== renewal.lease.leaseId
                || answer.renewed.expiresAtMs !== renewal.lease.expiresAtMs) {
              renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_RESPONSE_INVALID', 'The relay renewal acknowledgement does not match the fresh signed lease.'));
              return;
            }
            renewal.finish(null, Object.freeze({ leaseId: answer.renewed.leaseId, expiresAtMs: answer.renewed.expiresAtMs }));
            return;
          }
          if (exactKeys(answer, ['renewalRefused']) && exactKeys(answer.renewalRefused, ['code'])
              && ERROR_CODE.test(answer.renewalRefused.code)) {
            const code = answer.renewalRefused.code;
            renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_REFUSED', `The relay refused to renew the lease (${code}).`));
            return;
          }
          renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_RENEWAL_RESPONSE_INVALID', 'The relay sent an unexpected renewal response.'));
          return;
        }
        if (!proof || challenged || settled) return;
        let challenge;
        if (Buffer.byteLength(data, 'utf8') > MAX_ADMISSION_BYTES) {
          rejectAdmission('RELAY_CLIENT_CHALLENGE_INVALID', 'The relay offered an oversized admission challenge; nothing was signed.');
          return;
        }
        try { challenge = parseStrictJsonString(data, {
          maxBytes:MAX_ADMISSION_BYTES, maxDepth:16, maxValues:2048,
        }); } catch {
          rejectAdmission('RELAY_CLIENT_CHALLENGE_INVALID', 'The relay offered an unreadable admission challenge; nothing was signed.');
          return;
        }
        const challengeKeys = Object.keys(challenge || {});
        if (!plain(challenge) || typeof challenge.challenge !== 'string'
            || (!(challengeKeys.length === 1 && challengeKeys[0] === 'challenge')
              && !exactKeys(challenge, ['challenge', 'expiresAtMs']))
            || (Object.hasOwn(challenge, 'expiresAtMs')
              && (!Number.isSafeInteger(challenge.expiresAtMs) || challenge.expiresAtMs < 1))) {
          rejectAdmission('RELAY_CLIENT_CHALLENGE_INVALID', 'The relay offered an invalid admission challenge; nothing was signed.');
          return;
        }
        /* THE KEY DOOR IS NOT A SIGNING SERVICE.
         *
         * This checked `length < 16` -- a FLOOR with no ceiling and no format --
         * and then signed whatever arrived with the device identity key. That is
         * the same key that signs E2E handshake leases, so the relay could send a
         * canonical lease carrying ITS OWN X25519 ephemeral as the "challenge",
         * collect a valid signature over it, present the result to the peer as a
         * hello, and hold both halves of a session the product promises it cannot
         * read. Proved end to end: a forged hello was accepted and a sealed frame
         * was recovered in cleartext.
         *
         * An honest relay's nonce is 32 random bytes rendered base64url --
         * always exactly 43 characters (NONCE_BYTES in the relay's
         * online-fra-web-admission.js). Pinning that shape costs it nothing and
         * leaves no room for a forgery: a canonical lease is several hundred bytes
         * and cannot be squeezed into 32. One-sided by construction, so a patched
         * endpoint still admits against an unpatched relay. */
        if (!RELAY_CHALLENGE_RE.test(challenge.challenge)) {
          rejectAdmission('RELAY_CLIENT_CHALLENGE_INVALID',
            'The relay offered a challenge that is not a single fresh nonce; nothing was signed.');
          return;
        }
        let challengeBytes;
        try { challengeBytes = Buffer.from(challenge.challenge, 'base64url'); } catch { challengeBytes = null; }
        if (!challengeBytes || challengeBytes.length !== RELAY_CHALLENGE_BYTES
            || challengeBytes.toString('base64url') !== challenge.challenge) {
          rejectAdmission('RELAY_CLIENT_CHALLENGE_INVALID',
            'The relay offered a challenge that is not a single fresh nonce; nothing was signed.');
          return;
        }
        challenged = true;
        let signature;
        try { signature = proof.sign(challengeBytes); } catch {
          rejectAdmission('RELAY_CLIENT_PROOF_FAILED', 'The relay challenge could not be signed.');
          return;
        }
        let wire;
        if (signature instanceof Uint8Array && signature.length === 64) wire = Buffer.from(signature).toString('base64url');
        else if (typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature)
          && Buffer.from(signature, 'base64url').length === 64
          && Buffer.from(signature, 'base64url').toString('base64url') === signature) wire = signature;
        else {
          if (signature && typeof signature.then === 'function') Promise.resolve(signature).catch(() => {});
          rejectAdmission('RELAY_CLIENT_PROOF_FAILED', 'The relay proof was not a canonical Ed25519 signature.');
          return;
        }
        try {
          socket.send(encodePlainJson({ lease, publicKeySpki: proof.publicKeySpki,
            nonce: challenge.challenge, signature: wire }, {
            maxBytes:MAX_ADMISSION_BYTES, maxDepth:16, maxValues:128,
          }).toString('utf8'));
        } catch {
          rejectAdmission('RELAY_CLIENT_ADMISSION_SEND_FAILED', 'The admission frame could not be sent to the relay.');
          return;
        }
        settleAdmitted();
        return;
      }
      let raw;
      try {
        if (data instanceof ArrayBuffer) raw = Buffer.from(data);
        else if (ArrayBuffer.isView(data)) raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        else return;
      } catch { return; }
      // The leg byte is the address and is consumed here; a frame with no
      // payload after it, or a source the leg table does not know, is noise.
      if (raw.length < 2 || raw.length > MAX_WIRE_FRAME_BYTES) return;
      const from = LEG_ROLE[raw[0]];
      if (!from || raw[0] === ownLeg) return;
      try { onFrame(raw.subarray(1), { from }); } catch { /* a caller's throw must not kill the socket */ }
    });

    socket.addEventListener('close', event => {
      clearTimeout(admissionTimer);
      if (renewal) renewal.finish(new OnlineFraRelayClientError('RELAY_CLIENT_CLOSED', 'The relay connection closed.'));
      closeSettler({ code: event.code, reason: String(event.reason || '') });
      if (!settled) {
        settled = true;
        reject(new OnlineFraRelayClientError(
          admitted ? 'RELAY_CLIENT_REFUSED' : 'RELAY_CLIENT_UNREACHABLE',
          admitted ? 'The relay refused the lease.' : 'The relay could not be reached.'
        ));
      }
    });

    socket.addEventListener('error', () => { /* the close event carries the outcome */ });
  });
}

module.exports = Object.freeze({ OnlineFraRelayClientError, connectOnlineFraRelay, LEG_BYTE, LEG_ROLE });
