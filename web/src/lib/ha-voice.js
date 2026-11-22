// ha-voice.js — hearing a spoken command that was heard somewhere else.
//
// The microphone in the browser (TimersPanel's push-to-talk) only works if you
// are standing at the screen. Satellite microphones around the house solve
// that, and they change the architecture completely: the audio arrives at Home
// Assistant, the transcript exists in Home Assistant, and the display that has
// to act on it is a browser in another room that heard nothing.
//
// So something has to carry the transcript. The obvious route -- satellite to
// HA to the HouseHub server to the display -- is the one route this app cannot
// take. The server holds ciphertext and no key by design; a transcript passing
// through it would be the household's own words, in the clear, on the one
// machine the entire design exists to keep them off. "Set a timer for the
// pasta" is not sensitive, but the endpoint that carries it would not know
// that, and a general-purpose plaintext command channel is exactly the kind of
// hole that gets widened later by somebody in a hurry.
//
// The route taken instead is direct. The display holds a WebSocket to the
// household's own Home Assistant, on the household's own network, and Home
// Assistant fires an event at it. The transcript goes satellite -> HA ->
// browser and is encrypted before it is stored. The HouseHub server is not in
// the path and learns nothing, which is the same guarantee everything else in
// the document already has.
//
// What this costs is a Home Assistant token in a browser, which is discussed
// at length in docs/VOICE.md and is not a small thing: Home Assistant has no
// scoped tokens, so it is a house-controlling credential sitting on a screen
// anybody can walk up to. The mitigation is a second, dedicated Home Assistant
// user whose token is the only one displays ever receive, and turning voice on
// per display rather than everywhere.

/** The event a Home Assistant automation fires. See docs/VOICE.md. */
export const VOICE_EVENT = "househub_voice";

/* Home Assistant's WebSocket handshake, in the order it happens:
     server: { type: "auth_required" }
     client: { type: "auth", access_token }
     server: { type: "auth_ok" } | { type: "auth_invalid" }
     client: { id, type: "subscribe_events", event_type }
   Everything after that arrives as { type: "event", event: { data } }. */

/** ws:// for an http:// Home Assistant, wss:// for https://. */
export function wsUrlFor(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (/^wss?:\/\//i.test(raw)) return `${raw}/api/websocket`;
  return `${raw.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:")}/api/websocket`;
}

/**
 * Whether a fired event is meant for this screen.
 *
 * An event with no target is for whichever screens are listening -- an "every
 * display" broadcast, which is what a household with one wall tablet will
 * always produce. A named target is matched case-insensitively against the
 * display's own name, because the name is typed twice (once in HouseHub, once
 * in a Home Assistant automation) and expecting those to match exactly is how
 * this feature ends up silently doing nothing.
 */
export function isForThisScreen(eventData, screenName) {
  const target = String(eventData?.display || eventData?.target || "").trim();
  if (!target) return true;
  const mine = String(screenName || "").trim();
  if (!mine) return false;
  return target.toLowerCase() === mine.toLowerCase();
}

/** The spoken text out of an event, whatever the automation called the field. */
export const textOf = (eventData) =>
  String(eventData?.text || eventData?.command || eventData?.transcript || "").trim();

/**
 * Whether an event carries a command in fields rather than a sentence.
 *
 * A Siri Shortcut has already asked "what's the task?" and "who's it for?" as
 * separate questions, so it can send them as separate fields -- and a field
 * cannot be misparsed the way a sentence can. Free text still works; this is
 * the better path when the sender can use it.
 *
 *   { task: "Ring the plumber", person: "Sam" }       person may be "later"
 *   { timer: "10 minutes", label: "pasta" }           or timer: 600 (seconds)
 */
export const isStructured = (eventData) =>
  Boolean(String(eventData?.task ?? "").trim() || String(eventData?.timer ?? "").trim());

/**
 * A row id for something a relayed command creates, the same on every screen.
 *
 * Every screen that hears one broadcast must write the same row, so the merge
 * collapses them -- hence Home Assistant's context id. But one automation or
 * script run gives every event it fires the same context id, so the id alone
 * would make "Bins out" and "Feed the cat" from one run the same row, and the
 * second would vanish. The command's own content is folded in: the same
 * command heard twice is one row, two different commands are two.
 *
 * Returns "" when the event had no context id, and the caller then makes an
 * ordinary random id, as for a command spoken at the screen.
 */
export function relayKey(eventId, text, fields = {}) {
  if (!eventId) return "";
  const canon = JSON.stringify([
    String(text || ""), fields.task ?? "", fields.person ?? "", fields.when ?? "",
    fields.timer ?? "", fields.label ?? "", fields.display ?? fields.target ?? "",
  ]);
  let h = 5381;
  for (let i = 0; i < canon.length; i++) h = ((h * 33) ^ canon.charCodeAt(i)) >>> 0;
  return `${eventId}-${h.toString(36)}`;
}

/**
 * Hold a subscription to one household's Home Assistant.
 *
 * `makeSocket` is injected so this can be driven by a fake in tests; in the app
 * it is `(url) => new WebSocket(url)`.
 *
 * Reconnects with a backoff, because the realistic failure here is not a bug
 * but a wall tablet that has been awake for three weeks across two router
 * reboots. A voice control that silently stops working after the first blip is
 * worse than none, since nobody discovers it until they need it.
 */
export function connectVoice({
  url, token, screenName = "", onCommand, onState,
  makeSocket = (u) => new WebSocket(u),
  retryMs = 2000, maxRetryMs = 60000,
} = {}) {
  const target = wsUrlFor(url);
  let sock = null, closed = false, retry = retryMs, timer = null, nextId = 1;

  const say = (state, detail) => { try { onState && onState(state, detail); } catch (e) { /* caller's problem */ } };

  const open = () => {
    if (closed) return;
    let s;
    try { s = makeSocket(target); } catch (e) { return schedule(); }
    sock = s;

    s.onopen = () => say("connecting");

    s.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }

      if (msg.type === "auth_required") {
        s.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }
      if (msg.type === "auth_invalid") {
        // Not worth retrying: a rejected token will be rejected again, and a
        // reconnect loop against it just fills Home Assistant's log.
        closed = true;
        say("unauthorised", msg.message || "Home Assistant rejected the token.");
        try { s.close(); } catch (e) { /* already gone */ }
        return;
      }
      if (msg.type === "auth_ok") {
        retry = retryMs;
        s.send(JSON.stringify({ id: nextId++, type: "subscribe_events", event_type: VOICE_EVENT }));
        say("listening");
        return;
      }
      if (msg.type === "event") {
        const data = msg.event?.data || {};
        if (!isForThisScreen(data, screenName)) return;
        const text = textOf(data);
        /* Home Assistant stamps every event with a context id. It is passed on
           so that every screen that hears one broadcast command can give what
           it creates the same id -- which the document merge then collapses to
           one row, instead of one task per listening screen. */
        const eventId = String(msg.event?.context?.id || "");
        if (text || isStructured(data)) {
          try { onCommand && onCommand(text, data, { eventId }); } catch (e) { /* caller's problem */ }
        }
      }
    };

    s.onerror = () => say("error");
    s.onclose = () => { sock = null; if (!closed) { say("offline"); schedule(); } };
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(open, retry);
    retry = Math.min(maxRetryMs, Math.round(retry * 1.8));
  };

  open();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      try { sock && sock.close(); } catch (e) { /* already gone */ }
      sock = null;
    },
  };
}
