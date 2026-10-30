'use strict';

// The direct road: a WebRTC data channel between the customer's two machines,
// negotiated over the relay's sealed frames, carrying the SAME sealed
// envelopes the relay road carries. We are changing the road, not the
// envelope.
//
// werift (pure-JS WebRTC; owner-approved 2026-08-19, pinned exact) is loaded
// LAZILY and only here: the engine works without it -- transport selection
// simply reports the direct road unavailable and stays on the relay, which is
// the fallback behaving as designed, not an error. The relay repo never sees
// this module; the browser uses its native stack with byte-identical
// signalling.
//
// The data channel is configured for ORDERED, RELIABLE delivery -- agent
// traffic is request/response, not media -- and the channel label is pinned so
// both ends refuse a surprise channel.

const { createDirectSignalling } = require('./online-fra-direct-signalling');
const { parseStrictJsonString } = require('./online-fra-strict-json');

const CHANNEL_LABEL = 'online-fra-frames.v1';
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const MAX_CONNECT_TIMEOUT_MS = 60_000;
const MAX_DIRECT_FRAME_BYTES = 256 * 1024;
const MAX_ICE_SERVERS = 16;

class OnlineFraDirectTransportError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OnlineFraDirectTransportError';
    this.code = code;
  }
}

function fail(code, message) { throw new OnlineFraDirectTransportError(code, message); }

function loadWebRtc(inject) {
  if (inject) return inject;
  try { return require('werift'); }
  catch (error) {
    // A missing optional package establishes unavailability. Any other load
    // failure (for example, a broken package or one of its dependencies
    // failing to initialize) did not establish that answer and must surface.
    if (error && error.code === 'MODULE_NOT_FOUND' &&
        /^Cannot find module 'werift'(?:\r?\n|$)/.test(error.message)) return null;
    throw error;
  }
}

/** Is the direct road even possible on this installation? */
function directTransportAvailable({ webRtc } = {}) {
  const loaded = loadWebRtc(webRtc);
  return Boolean(loaded && typeof loaded.RTCPeerConnection === 'function');
}

function normalizeIceServers(value) {
  if (!Array.isArray(value) || value.length > MAX_ICE_SERVERS) {
    fail('DIRECT_TRANSPORT_OPTIONS_INVALID', 'iceServers must be a bounded array.');
  }
  return value.map(server => {
    if (!server || typeof server !== 'object' || Array.isArray(server)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(server))
        || Object.keys(server).some(key => !['urls', 'username', 'credential'].includes(key))) {
      fail('DIRECT_TRANSPORT_OPTIONS_INVALID', 'Each ICE server must use only urls, username and credential.');
    }
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8
        || urls.some(url => typeof url !== 'string' || url.length < 1 || url.length > 2048
          || !/^(?:stun|stuns|turn|turns):[^\s\x00-\x1f\x7f]+$/i.test(url))) {
      fail('DIRECT_TRANSPORT_OPTIONS_INVALID', 'Each ICE server needs bounded STUN or TURN URLs.');
    }
    for (const key of ['username', 'credential']) {
      if (server[key] !== undefined && (typeof server[key] !== 'string' || server[key].length > 1024
          || /[\r\n\0]/.test(server[key]))) {
        fail('DIRECT_TRANSPORT_OPTIONS_INVALID', `ICE ${key} must be a bounded string.`);
      }
    }
    return Object.freeze({
      urls: typeof server.urls === 'string' ? server.urls : Object.freeze([...urls]),
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential })
    });
  });
}

/**
 * Attempt the direct road. Resolves to a live channel:
 *   { send(bytes), close(), onFrame set via options, closed: Promise }
 * or REJECTS with a named code -- and every rejection is a signal to stay on
 * the relay road, never to give up the session.
 *
 * options:
 *   role        'machine-a' (offers) | 'machine-b' (answers)
 *   sendFrame   sealed-frame sender over the relay (the signalling path)
 *   onFrame     (Buffer) => void, frames arriving over the direct channel
 *   iceServers  e.g. [{ urls: 'stun:stun.l.google.com:19302' }]; [] on a LAN
 *   webRtc      injected implementation (tests); defaults to werift
 *   timeoutMs   negotiation ceiling, default 20s
 *
 * RETURNS SYNCHRONOUSLY: { signalling, opened }. The caller pumps inbound
 * relay frames through signalling.handleFrame() FROM THE MOMENT THIS RETURNS
 * (treating `false` returns as application traffic) and awaits `opened` for
 * the live channel. This shape is forced by the bootstrap: the answering
 * side's offer arrives over the relay BEFORE any channel exists, so a design
 * that only exposed signalling on the resolved promise could never receive
 * it -- the first draft of this module had exactly that deadlock, and its
 * own test found it.
 */
function connectDirectTransport({ role, sendFrame, onFrame, iceServers = [], webRtc, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const rtc = loadWebRtc(webRtc);
  if (!rtc || typeof rtc.RTCPeerConnection !== 'function') {
    fail('DIRECT_TRANSPORT_UNAVAILABLE', 'No WebRTC implementation is installed; the relay road carries the session.');
  }
  if ((role !== 'machine-a' && role !== 'machine-b') || typeof sendFrame !== 'function'
      || typeof onFrame !== 'function' || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > MAX_CONNECT_TIMEOUT_MS) {
    fail('DIRECT_TRANSPORT_OPTIONS_INVALID', 'The direct transport role, callbacks or timeout are invalid.');
  }
  const normalizedIceServers = normalizeIceServers(iceServers);
  let peer;
  try { peer = new rtc.RTCPeerConnection({ iceServers: normalizedIceServers }); }
  catch { fail('DIRECT_TRANSPORT_SETUP_FAILED', 'The WebRTC peer could not be created; the relay road carries the session.'); }
  const event = value => value && typeof value.subscribe === 'function';
  if (!event(peer.onIceCandidate) || !event(peer.onDataChannel)) {
    try { peer.close(); } catch { /* setup is already refused */ }
    fail('DIRECT_TRANSPORT_SETUP_FAILED', 'The WebRTC implementation does not provide the required event surface.');
  }

  let signalling = null;
  let phase = 'opening';
  let channel = null;
  let channelOpen = false;
  let resolveOpened;
  let rejectOpened;
  let resolveClosed;
  let closedDone = false;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const opened = new Promise((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
  const finishClosed = reason => {
    if (closedDone) return;
    closedDone = true;
    resolveClosed(Object.freeze({ reason }));
  };
  const closePeer = () => {
    try {
      const result = peer.close();
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch { /* failure is already represented by the transport refusal */ }
  };
  let timer = null;
  const refuseOpening = (code, message, reason, tellPeer = true) => {
    if (phase !== 'opening') return;
    phase = 'failed';
    clearTimeout(timer);
    if (tellPeer && signalling && !signalling.isAbandoned()) {
      try { signalling.abandon(reason); } catch { /* peer notification is not cleanup */ }
    }
    closePeer();
    finishClosed('negotiation-refused');
    rejectOpened(new OnlineFraDirectTransportError(code, message));
  };
  const refuseLiveChannel = reason => {
    if (phase === 'opening') {
      refuseOpening('DIRECT_TRANSPORT_FRAME_INVALID', 'The direct road received an invalid frame; the relay road carries the session.', reason);
      return;
    }
    if (phase !== 'open') return;
    phase = 'closed';
    channelOpen = false;
    finishClosed(reason);
    try { channel?.close(); } catch { /* close the peer below */ }
    closePeer();
  };

  function wireChannel(dataChannel) {
    if (!dataChannel || dataChannel.label !== CHANNEL_LABEL) {
      try { dataChannel?.close(); } catch { /* refused channel */ }
      return;
    }
    // Exactly one correctly labelled channel belongs to a transport. A second
    // one must not feed duplicate ciphertext into the ordered session.
    if (channel !== null) { try { dataChannel.close(); } catch { /* duplicate refused */ } return; }
    if (!event(dataChannel.onMessage) || !event(dataChannel.stateChanged) || typeof dataChannel.send !== 'function') {
      try { dataChannel.close(); } catch { /* malformed channel */ }
      refuseOpening('DIRECT_TRANSPORT_SETUP_FAILED', 'The WebRTC data channel does not provide the required event surface.', 'channel-unusable');
      return;
    }
    channel = dataChannel;
    dataChannel.onMessage.subscribe(data => {
      let bytes = null;
      try {
        if (data instanceof Uint8Array) bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
      } catch { bytes = null; }
      if (!bytes || bytes.length < 1 || bytes.length > MAX_DIRECT_FRAME_BYTES) {
        refuseLiveChannel('frame-refused');
        return;
      }
      try { onFrame(Buffer.from(bytes)); } catch { /* caller's throw must not kill the channel */ }
    });
    dataChannel.stateChanged.subscribe(state => {
      if (state === 'open' && phase === 'opening') {
        phase = 'open';
        channelOpen = true;
        clearTimeout(timer);
        resolveOpened(Object.freeze({
          send(bytes) {
            if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
                || bytes.byteLength > MAX_DIRECT_FRAME_BYTES) {
              fail('DIRECT_TRANSPORT_FRAME_INVALID', 'Frames must be nonempty bounded binary values; seal first.');
            }
            if (phase !== 'open' || !channelOpen) {
              fail('DIRECT_TRANSPORT_NOT_OPEN', 'The direct road is no longer open; use the relay road.');
            }
            dataChannel.send(Buffer.from(bytes));
          },
          // This is caller-requested, not best-effort cleanup: synchronous
          // close failures surface, and sending is fenced from this point.
          close() {
            if (phase === 'open') { phase = 'closing'; channelOpen = false; }
            return peer.close();
          },
          closed,
          signalling
        }));
      }
      if (state === 'closed') {
        channelOpen = false;
        if (phase === 'opening') {
          refuseOpening('DIRECT_TRANSPORT_CLOSED', 'The direct road closed before it opened; the relay road carries the session.', 'channel-closed', false);
        } else {
          phase = 'closed';
          finishClosed('channel-closed');
        }
      }
    });
  }

  try {
    signalling = createDirectSignalling({
      role,
      sendFrame,
      handlers: {
        offer: async sdp => {
          if (phase !== 'opening') return;
          try {
            await peer.setRemoteDescription({ type: 'offer', sdp });
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            if (phase === 'opening') signalling.sendAnswer(peer.localDescription.sdp);
          } catch { refuseOpening('DIRECT_TRANSPORT_NEGOTIATION_FAILED', 'The direct offer could not be used; the relay road carries the session.', 'offer-unusable'); }
        },
        answer: async sdp => {
          if (phase !== 'opening') return;
          try { await peer.setRemoteDescription({ type: 'answer', sdp }); }
          catch { refuseOpening('DIRECT_TRANSPORT_NEGOTIATION_FAILED', 'The direct answer could not be used; the relay road carries the session.', 'answer-unusable'); }
        },
        candidate: async payload => {
          if (phase !== 'opening' && phase !== 'open') return;
          try { await peer.addIceCandidate(parseStrictJsonString(payload, {
            maxBytes:16 * 1024, maxDepth:12, maxValues:256,
          })); }
          catch { /* one bad candidate costs itself; ICE keeps trying the rest */ }
        },
        abandon: () => refuseOpening('DIRECT_TRANSPORT_ABANDONED', 'The peer abandoned the direct road; the relay road carries the session.', 'peer-abandoned', false)
      }
    });
    peer.onIceCandidate.subscribe(candidate => {
      if (phase !== 'opening' || signalling.isAbandoned()) return;
      try {
        if (candidate) signalling.sendCandidate(JSON.stringify(candidate.toJSON ? candidate.toJSON() : candidate));
        else signalling.sendCandidatesDone();
      } catch { refuseOpening('DIRECT_TRANSPORT_NEGOTIATION_FAILED', 'The local ICE candidate could not be signalled; the relay road carries the session.', 'candidate-failed'); }
    });
    peer.onDataChannel.subscribe(incoming => wireChannel(incoming));
    for (const stateEvent of [peer.connectionStateChange, peer.iceConnectionStateChange]) {
      if (event(stateEvent)) stateEvent.subscribe(state => {
        if (state === 'failed') {
          if (phase === 'opening') refuseOpening('DIRECT_TRANSPORT_NEGOTIATION_FAILED', 'The direct road failed to negotiate; the relay road carries the session.', 'peer-failed');
          else refuseLiveChannel('peer-failed');
        } else if (state === 'closed' && phase !== 'failed') {
          if (phase === 'opening') refuseOpening('DIRECT_TRANSPORT_CLOSED', 'The direct road closed before it opened; the relay road carries the session.', 'peer-closed', false);
          else { phase = 'closed'; channelOpen = false; finishClosed('peer-closed'); }
        }
      });
    }
  } catch (error) {
    closePeer();
    if (error instanceof OnlineFraDirectTransportError) throw error;
    fail('DIRECT_TRANSPORT_SETUP_FAILED', 'The direct transport could not install its event handlers.');
  }

  // An injected implementation is allowed to synchronously replay its current
  // state while a handler subscribes.  Such a replay can refuse the opening
  // above; do not then leave a newly-created timeout behind for a transport
  // that is already terminal.
  if (phase === 'opening') {
    timer = setTimeout(() => refuseOpening('DIRECT_TRANSPORT_TIMEOUT',
      'The direct road did not open in time; the relay road carries the session.', 'negotiation-timeout'), timeoutMs);
    if (timer.unref) timer.unref();
  }

  if (role === 'machine-a') {
    try { wireChannel(peer.createDataChannel(CHANNEL_LABEL, { ordered: true })); }
    catch { refuseOpening('DIRECT_TRANSPORT_SETUP_FAILED', 'The ordered data channel could not be created; the relay road carries the session.', 'channel-create-failed'); }
    if (phase === 'opening') {
      Promise.resolve().then(() => peer.createOffer())
        .then(offer => peer.setLocalDescription(offer))
        .then(() => { if (phase === 'opening') signalling.sendOffer(peer.localDescription.sdp); })
        .catch(() => refuseOpening('DIRECT_TRANSPORT_NEGOTIATION_FAILED', 'The direct offer could not be created; the relay road carries the session.', 'offer-failed'));
    }
  }
  // A rejection with nobody yet awaiting must not crash the process; the
  // caller attaches when it attaches, and the code arrives intact.
  opened.catch(() => {});
  return Object.freeze({ signalling, opened });
}

module.exports = Object.freeze({
  CHANNEL_LABEL, MAX_CONNECT_TIMEOUT_MS, MAX_DIRECT_FRAME_BYTES, OnlineFraDirectTransportError,
  directTransportAvailable, connectDirectTransport
});
