// task-voice.js — turning "add a task to ring the plumber for Sam" into a task.
//
// The same shape as timer-voice.js and for the same reasons: pure, so it can be
// tested without a microphone, and shared, so the push-to-talk button on the
// screen and a command relayed from Home Assistant or Siri read one grammar.
//
// Two things make a task command different from a timer one.
//
// It needs an explicit trigger. A timer is recognisable by its duration; a task
// is just words, and "ring the plumber" said near a listening screen must not
// become a task by accident. So nothing here fires without "task" or "to-do"
// (or "…to my list") in the sentence.
//
// And the assignee is only taken when it is somebody. "Buy flowers for mum" is
// a task about mum unless mum is a person in this household; stripping any
// trailing "for X" would eat half the titles people actually say. A name that
// matches nobody stays in the title, and the task is left unassigned for
// somebody to claim in the app.

/* Words that mean "nobody in particular" when they follow "for". Said aloud,
   "for anyone" is a real answer to "who's it for", and it should not end up in
   the title. */
const NOBODY = new Set([
  "anyone", "anybody", "everyone", "everybody", "nobody", "no one", "noone",
  "whoever", "us", "all of us", "the house", "the household", "later",
]);
const SELF = new Set(["me", "myself"]);

/* The ways into a task command, tried in order. Each captures the rest of the
   sentence as the body. Leading politeness is dropped first so these can stay
   anchored at the start. */
const LEADS = [
  // "add a task to ring the plumber", "new to-do: book the MOT", "create task call mum"
  /^(?:add|create|make|new|put|start)\s+(?:(?:a|an|another|new|one)\s+)*(?:task|to[\s-]?do|todo|reminder task)\b[\s,:-]*(?:to\s+|called\s+|named\s+|saying\s+|that\s+says\s+)?(.*)$/,
  // "task: book the MOT", "to-do ring the plumber"
  /^(?:task|to[\s-]?do|todo)\b[\s,:-]+(.*)$/,
];
/* "add ring the plumber to my task list", "put book the MOT on the to-do list" */
const TO_LIST = /^(?:add|put)\s+(.+?)\s+(?:to|on(?:to)?)\s+(?:the\s+|my\s+|our\s+)?(?:task|tasks|to[\s-]?do|to[\s-]?dos|todo|todos)(?:\s+list)?$/;

const POLITE = /^(?:(?:hey|ok|okay)\s+)?(?:(?:house\s*hub|hub|house)[\s,]+)?(?:(?:please|can you|could you|would you)\s+)*/;

const DAYS = { today: 0, tonight: 0, tomorrow: 1 };

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Lowercase, punctuation-light: what speech recognition hands back anyway. */
function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which person a spoken name means, or null.
 *
 * Matches the whole name or the first name, ignoring case, because the name is
 * typed once in HouseHub and spoken however people say it. A possessive or a
 * plural "s" is allowed ("sam's"), since dictation adds them unasked.
 */
export function matchPerson(people, spoken) {
  const want = normalise(spoken).replace(/'s$|s'$/, "");
  if (!want) return null;
  const list = people || [];
  const full = list.find((p) => normalise(p.name) === want);
  if (full) return full;
  const first = list.filter((p) => normalise(p.name).split(" ")[0] === want);
  return first.length === 1 ? first[0] : null;
}

/* Peel one trailing "for Sam" / "tomorrow" / "for anyone" off the body. Returns
   what it found, or null when the tail is part of the title. */
function peelTail(body, people) {
  // "for tomorrow" before bare "tomorrow", or the "for" is left in the title.
  let m = body.match(/^(.*?)[\s,]+(?:due|by|for)\s+(today|tonight|tomorrow)$/);
  if (m && m[1]) return { rest: m[1], day: DAYS[m[2]] };
  m = body.match(/^(.*?)[\s,]+(today|tonight|tomorrow)$/);
  if (m && m[1]) return { rest: m[1], day: DAYS[m[2]] };

  m = body.match(/^(.*?)[\s,]+(?:for|assign(?:ed)?\s+(?:it\s+)?to|give\s+(?:it\s+)?to)\s+(.+)$/);
  if (!m || !m[1]) return null;
  const who = m[2].trim();
  if (SELF.has(who)) return { rest: m[1], self: true };
  if (NOBODY.has(who)) return { rest: m[1], nobody: true };
  const person = matchPerson(people, who);
  return person ? { rest: m[1], person } : null;
}

/* "Ring the plumber" rather than "ring the plumber": the wall shows it. Takes
   the household's own capitalisation where the raw text had any, as the timer
   parser does, and otherwise capitalises the first letter. */
function titleFrom(raw, body) {
  const words = body.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const hit = String(raw).match(new RegExp(words.join("[\\s,]+"), "i"));
  const text = (hit ? hit[0] : body).replace(/\s+/g, " ").replace(/^[\s,:-]+|[\s,:-]+$/g, "");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

/**
 * A spoken task, or null when the sentence is not asking for one.
 *
 *   { title, personId, assigned, date }
 *
 * `assigned` is "person" when a name was said, "self" for "for me" (resolved
 * by the caller, which knows who is holding the screen), "nobody" when the
 * speaker said so, and "" when nobody was mentioned at all.
 *
 * `date` defaults to today. An undated task never appears on the Today view,
 * and a voice command whose result is invisible reads as a voice command that
 * failed.
 */
export function parseTaskCommand(text, people = [], { now = new Date() } = {}) {
  const raw = String(text || "").trim();
  const said = normalise(raw).replace(POLITE, "");
  if (!said) return null;

  let body = null;
  const list = said.match(TO_LIST);
  if (list) body = list[1];
  else {
    for (const re of LEADS) {
      const m = said.match(re);
      if (m) { body = m[1]; break; }
    }
  }
  if (body === null) return null;
  body = body.replace(/[\s,]+please$/, "").replace(/^[\s,:-]+|[\s,:-]+$/g, "");

  let personId = "", assigned = "", day = 0;
  // Up to two tails, so "for Sam tomorrow" and "tomorrow for Sam" both work.
  for (let i = 0; i < 2; i++) {
    const tail = peelTail(body, people);
    if (!tail) break;
    body = tail.rest.replace(/[\s,]+$/g, "");
    if (tail.day !== undefined) day = tail.day;
    if (tail.person) { personId = tail.person.id; assigned = "person"; }
    if (tail.self) assigned = "self";
    if (tail.nobody) assigned = "nobody";
  }

  const title = titleFrom(raw, body).slice(0, 120);
  if (!title) return null;

  const d = new Date(now);
  d.setDate(d.getDate() + day);
  return { title, personId, assigned, date: ymd(d) };
}

/** The document's task shape, as TaskModal would have written it. */
export function taskFromCommand(cmd, uid) {
  return {
    id: uid(), title: cmd.title, date: cmd.date, personId: cmd.personId || "",
    alert: null, steps: [], note: "", done: false,
  };
}
