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
// And the assignee is only taken when it is somebody, and a trailing "for X"
// never cuts the title. "Ring the plumber for Sam" and "buy flowers for mum"
// have the same shape and opposite meanings, so a trailing name assigns the
// task but stays in the title: on the wrong person it is still the right
// task, and the toast shows who it went to. Only phrasings that can mean
// nothing else are taken out of the title -- "for Sam to …" at the front,
// "… and give it to Sam" at the end. A name that matches nobody stays in the
// title, and the task is left unassigned for somebody to claim in the app.

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
/* "add ring the plumber to my task list", "put book the MOT on sam's to-do
   list please", and list-first: "add to the to-do list: book the MOT". The
   possessive is captured so "sam's list" can assign; anything after "list"
   is kept for the tail parser rather than defeating the match. */
const LIST_WORD = "(?:task|tasks|to[\\s-]?do|to[\\s-]?dos|todo|todos)(?:\\s+list)?";
const WHOSE = "(?:(?:the|my|our)\\s+|(\\S+?)'s\\s+)?";
const TO_LIST = new RegExp(`^(?:add|put)\\s+(.+?)\\s+(?:to|on(?:to)?)\\s+${WHOSE}${LIST_WORD}(?:[\\s,]+(.*))?$`);
const LIST_FIRST = new RegExp(`^(?:add|put)\\s+(?:to|on(?:to)?)\\s+${WHOSE}${LIST_WORD}[\\s,:-]+(.+)$`);

const POLITE = /^(?:(?:hey|ok|okay)\s+)?(?:(?:house\s*hub|hub|house)[\s,]+)?(?:(?:please|can you|could you|would you)\s+)*/;

const DAYS = { today: 0, tonight: 0, tomorrow: 1 };

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Lowercase, punctuation-light: what speech recognition hands back anyway. */
function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[‘’]/g, "'")
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

/* Who a spoken "who" means: a person, me, or nobody in particular. */
function whoIs(people, spoken) {
  const who = normalise(spoken);
  if (SELF.has(who)) return { self: true };
  if (NOBODY.has(who)) return { nobody: true };
  const person = matchPerson(people, who);
  return person ? { person } : null;
}

/* "for Sam to ring the plumber", "for tomorrow: book the MOT". A name at the
   front, followed by the task, can only be the assignee. Tries a two-word
   name before a one-word one so "for Alex Brown to …" keeps its surname out
   of the title. */
function peelHead(body, people) {
  const words = body.split(" ");
  if (words[0] !== "for" || words.length < 3) return null;
  for (const n of [2, 1]) {
    const spoken = words.slice(1, 1 + n).join(" ").replace(/[,:]+$/, "");
    let rest = words.slice(1 + n);
    if (rest[0] === "to") rest = rest.slice(1);
    if (!rest.length) continue;
    if (DAYS[spoken] !== undefined) return { rest: rest.join(" "), day: DAYS[spoken] };
    const who = whoIs(people, spoken);
    if (who) return { rest: rest.join(" "), ...who };
  }
  return null;
}

/* Peel one tail off the body. Returns what it found, or null when the tail is
   part of the title. `keep` is text that assigned the task but stays in the
   title -- see the note at the top. */
function peelTail(body, people) {
  // "for tomorrow" before bare "tomorrow", or the "for" is left in the title.
  let m = body.match(/^(.*?)[\s,]+(?:due|by|for)\s+(today|tonight|tomorrow)$/);
  if (m && m[1]) return { rest: m[1], day: DAYS[m[2]] };
  m = body.match(/^(.*?)[\s,]+(today|tonight|tomorrow)$/);
  if (m && m[1]) return { rest: m[1], day: DAYS[m[2]] };

  // "… and give it to Sam", "… assigned to Sam": unambiguous, so cut,
  // together with the "and" that would otherwise dangle.
  // Greedy, so the LAST "for"/"give it to" is the one tried: "pay for
  // swimming for Sam" is about Sam, not "swimming for Sam".
  m = body.match(/^(.*?)(?:[\s,]+and)?[\s,]+(?:assign(?:ed)?\s+(?:it\s+)?to|give\s+(?:it\s+)?to)\s+(\S+(?:\s+\S+)?)$/);
  if (m && m[1]) {
    const who = whoIs(people, m[2]);
    if (who) return { rest: m[1], ...who };
  }

  m = body.match(/^(.*)[\s,]+for\s+(\S+(?:\s+\S+)?)$/);
  if (!m || !m[1]) return null;
  const who = whoIs(people, m[2]);
  if (!who) return null;
  // "for me" and "for anyone" are answers, not part of what the task is.
  if (who.self || who.nobody) return { rest: m[1], ...who };
  return { rest: m[1], keep: ` for ${m[2]}`, ...who };
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

  let body = null, whose = "";
  const list = said.match(TO_LIST);
  const first = list ? null : said.match(LIST_FIRST);
  if (list) { body = [list[1], list[3]].filter(Boolean).join(" "); whose = list[2] || ""; }
  else if (first) { body = first[2]; whose = first[1] || ""; }
  else {
    for (const re of LEADS) {
      const m = said.match(re);
      if (m) { body = m[1]; break; }
    }
  }
  if (body === null) return null;
  body = body.replace(/[\s,]+please$/, "").replace(/^[\s,:-]+|[\s,:-]+$/g, "");

  let personId = "", assigned = "", day = 0, kept = "";
  const take = (found) => {
    if (found.day !== undefined) day = found.day;
    if (found.person) { personId = found.person.id; assigned = "person"; }
    if (found.self) assigned = "self";
    if (found.nobody) assigned = "nobody";
  };

  // "sam's to-do list" says whose it is.
  const owner = whose ? matchPerson(people, whose) : null;
  if (owner) take({ person: owner });

  const head = peelHead(body, people);
  if (head) { take(head); body = head.rest; }

  // Up to three tails, so "for Sam tomorrow" and "tomorrow for Sam" both work.
  for (let i = 0; i < 3; i++) {
    const tail = peelTail(body, people);
    if (!tail) break;
    body = tail.rest.replace(/[\s,]+$/g, "");
    if (tail.keep) kept = tail.keep + kept;
    take(tail);
  }

  const title = titleFrom(raw, body + kept).slice(0, 120);
  if (!title) return null;

  const d = new Date(now);
  d.setDate(d.getDate() + day);
  return { title, personId, assigned, date: ymd(d) };
}

/* Answers to "who's it for?" that mean "not decided yet". */
const LATER = new Set(["", "later", "decide later", "nobody", "no one", "none",
  "anyone", "anybody", "everyone", "everybody", "whoever", "skip", "unassigned"]);

/**
 * A task from separate fields, as a Siri Shortcut sends it.
 *
 * Same result shape as parseTaskCommand. A person that matches nobody leaves
 * the task unassigned rather than failing: the task is what was asked for,
 * and who does it can be sorted out in the app.
 */
export function taskFromFields({ task, person, when } = {}, people = [], { now = new Date() } = {}) {
  const words = String(task ?? "").replace(/\s+/g, " ").trim()
    .replace(/^(?:to\s+)/i, "").replace(/[.!?]+$/, "");
  if (!words) return null;
  const title = (words[0].toUpperCase() + words.slice(1)).slice(0, 120);

  const who = normalise(person);
  let personId = "", assigned = "";
  if (!LATER.has(who)) {
    const p = matchPerson(people, who);
    if (p) { personId = p.id; assigned = "person"; }
  } else if (who) assigned = "nobody";

  const d = new Date(now);
  d.setDate(d.getDate() + (DAYS[normalise(when)] || 0));
  return { title, personId, assigned, date: ymd(d) };
}

/** The document's task shape, as TaskModal would have written it. */
export function taskFromCommand(cmd, uid) {
  return {
    id: uid(), title: cmd.title, date: cmd.date, personId: cmd.personId || "",
    alert: null, steps: [], note: "", done: false,
  };
}
