// task-voice.test.js — what people say to add a task, and what it should mean.
//
// Same rule as the timer tests: every phrase is one somebody would really say,
// in the lowercase, unpunctuated form speech recognition hands back, and the
// household never has to learn a phrasing.

import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../src/lib/task-voice.js";

const PEOPLE = [
  { id: "p-ryan", name: "Ryan" },
  { id: "p-sam", name: "Sam" },
  { id: "p-alex", name: "Alex Brown" },
];
const NOW = new Date(2026, 8, 25, 10, 0); // Friday 25 September 2026
const parse = (s) => V.parseTaskCommand(s, PEOPLE, { now: NOW });

test("the plain case, in the several ways people start it", () => {
  for (const said of [
    "add a task to ring the plumber",
    "add task ring the plumber",
    "new task ring the plumber",
    "create a to-do ring the plumber",
    "add a todo ring the plumber",
    "task ring the plumber",
    "hey hub add a task ring the plumber",
    "can you add a task to ring the plumber please",
    "add ring the plumber to my to-do list",
    "put ring the plumber on the task list",
    "add ring the plumber to tasks",
  ]) {
    const got = parse(said);
    assert.ok(got, said);
    assert.equal(got.title.toLowerCase(), "ring the plumber", said);
    assert.equal(got.date, "2026-09-25", said);
  }
});

test("nothing without the word task or to-do: a stray sentence is not a task", () => {
  for (const said of [
    "ring the plumber",
    "add milk",
    "set a timer for 10 minutes",
    "stop the pasta timer",
    "add a task",
    "",
  ]) {
    assert.equal(parse(said), null, said);
  }
});

test("a name after 'for' assigns it, when it is somebody here, and stays in the title", () => {
  // "Ring the plumber for Sam" and "buy flowers for mum" have the same shape
  // and opposite meanings; keeping the words means a wrong guess still leaves
  // the right task on the list.
  const got = parse("add a task to book the mot for sam");
  assert.equal(got.title, "Book the mot for sam");
  assert.equal(got.personId, "p-sam");
  assert.equal(got.assigned, "person");

  for (const said of [
    "add a task book the mot assign it to sam",
    "add a task book the mot assigned to sam",
    "add a task book the mot give it to sam",
    "add a task book the mot for sam's",
  ]) {
    assert.equal(parse(said).personId, "p-sam", said);
  }
});

test("a first name finds a person entered with a surname", () => {
  assert.equal(parse("add a task tidy your room for alex").personId, "p-alex");
  assert.equal(parse("add a task tidy your room for alex brown").personId, "p-alex");
});

test("'for somebody who is not here' stays in the title, unassigned", () => {
  const got = parse("add a task buy flowers for mum");
  assert.equal(got.title, "Buy flowers for mum");
  assert.equal(got.personId, "");
  assert.equal(got.assigned, "");
});

test("'for me' and 'for anyone' are answers, not part of the title", () => {
  const me = parse("add a task post the letter for me");
  assert.equal(me.title, "Post the letter");
  assert.equal(me.assigned, "self");
  assert.equal(me.personId, "");

  const anyone = parse("add a task post the letter for anyone");
  assert.equal(anyone.title, "Post the letter");
  assert.equal(anyone.assigned, "nobody");
  assert.equal(anyone.personId, "");
});

test("tomorrow moves the date, in either order with a name", () => {
  for (const said of [
    "add a task ring the plumber tomorrow",
    "add a task ring the plumber for tomorrow",
    "add a task ring the plumber for sam tomorrow",
    "add a task ring the plumber tomorrow for sam",
  ]) {
    const got = parse(said);
    assert.equal(got.title.replace(/ for sam$/, ""), "Ring the plumber", said);
    assert.equal(got.date, "2026-09-26", said);
  }
  assert.equal(parse("add a task ring the plumber tomorrow for sam").personId, "p-sam");
  assert.equal(parse("add a task ring the plumber for sam tomorrow").title, "Ring the plumber for sam");
});

test("an ambiguous first name assigns nobody rather than guessing", () => {
  const twins = [{ id: "a", name: "Sam Hale" }, { id: "b", name: "Sam Jones" }];
  const got = V.parseTaskCommand("add a task water the plants for sam", twins, { now: NOW });
  assert.equal(got.personId, "");
  assert.equal(got.title, "Water the plants for sam");
});

test("the household's own capitalisation survives when it was typed", () => {
  assert.equal(parse("Add a task: book the MOT").title, "Book the MOT");
});

test("the task it builds has the shape the task editor writes", () => {
  let n = 0;
  const t = V.taskFromCommand(parse("add a task for sam to ring the plumber"), () => `id${++n}`);
  assert.deepEqual(t, {
    id: "id1", title: "Ring the plumber", date: "2026-09-25", personId: "p-sam",
    alert: null, steps: [], note: "", done: false,
  });
});

test("task words that a stop command would also match still make a task", () => {
  // The screen checks tasks before stop commands; these are why.
  for (const said of [
    "add a task to clear the gutters",
    "add a task turn off the outside tap",
    "add a task stop the milk delivery",
  ]) {
    assert.ok(parse(said), said);
  }
});

/* ------------------------------------------ fields, from a Siri Shortcut --- */

test("a task from separate fields, with each answer to 'who's it for'", () => {
  const f = (fields) => V.taskFromFields(fields, PEOPLE, { now: NOW });

  const sam = f({ task: "ring the plumber", person: "Sam" });
  assert.deepEqual(sam, { title: "Ring the plumber", personId: "p-sam", assigned: "person", date: "2026-09-25" });

  for (const later of ["later", "Decide later", "nobody", "anyone", "skip"]) {
    const t = f({ task: "ring the plumber", person: later });
    assert.equal(t.personId, "", later);
    assert.equal(t.assigned, "nobody", later);
  }

  const blank = f({ task: "ring the plumber" });
  assert.equal(blank.personId, "");
  assert.equal(blank.assigned, "");

  // A name nobody here has: the task still gets made, unassigned.
  const stranger = f({ task: "ring the plumber", person: "Grandma" });
  assert.equal(stranger.personId, "");
  assert.equal(stranger.title, "Ring the plumber");
});

test("fields are tidied the way dictation leaves them", () => {
  const f = (fields) => V.taskFromFields(fields, PEOPLE, { now: NOW });
  assert.equal(f({ task: "to ring the plumber." }).title, "Ring the plumber");
  assert.equal(f({ task: "  book   the MOT " }).title, "Book the MOT");
  assert.equal(f({ task: "post it", when: "tomorrow" }).date, "2026-09-26");
  assert.equal(f({ task: "   " }), null);
  assert.equal(f({}), null);
});

/* --------------------------------------- found in review before release --- */

test("a name straight after 'add a task' assigns it, which is how people say it", () => {
  for (const said of [
    "add a task for sam to ring the plumber",
    "new task for sam: ring the plumber",
    "add a task for sam, ring the plumber",
  ]) {
    const got = parse(said);
    assert.equal(got.title, "Ring the plumber", said);
    assert.equal(got.personId, "p-sam", said);
  }
  assert.equal(parse("add a task for alex brown to tidy up").title, "Tidy up");
  assert.equal(parse("add a task for alex brown to tidy up").personId, "p-alex");

  const later = parse("add a task for tomorrow to ring the plumber");
  assert.equal(later.title, "Ring the plumber");
  assert.equal(later.date, "2026-09-26");
});

test("an earlier 'for' in the title does not hide the assignee at the end", () => {
  const got = parse("add a task to pay for swimming for sam");
  assert.equal(got.title, "Pay for swimming for sam");
  assert.equal(got.personId, "p-sam");
  // and with no person at the end, the title is untouched and nobody assigned
  const none = parse("add a task to look for the passports");
  assert.equal(none.title, "Look for the passports");
  assert.equal(none.personId, "");
});

test("'give it to' and 'assign it to' never leave a dangling 'and'", () => {
  for (const said of [
    "add a task to wrap the present and give it to sam",
    "add a task to wrap the present and assign it to sam",
  ]) {
    const got = parse(said);
    assert.equal(got.title, "Wrap the present", said);
    assert.equal(got.personId, "p-sam", said);
  }
});

test("to-do list phrasings people actually use are tasks, not near-misses", () => {
  // Each of these used to miss the task grammar and fall through to the stop
  // parser, which silenced a running timer on "clear" or "off".
  const cases = [
    ["add clear the gutters to sam's to-do list", "Clear the gutters", "p-sam", "2026-09-25"],
    ["add turn off the outside tap to my to-do list please", "Turn off the outside tap", "", "2026-09-25"],
    ["add to my to-do list clear the gutters", "Clear the gutters", "", "2026-09-25"],
    ["put switch off the router on the to-do list for tomorrow", "Switch off the router", "", "2026-09-26"],
  ];
  for (const [said, title, personId, date] of cases) {
    const got = parse(said);
    assert.ok(got, said);
    assert.equal(got.title, title, said);
    assert.equal(got.personId, personId, said);
    assert.equal(got.date, date, said);
  }
});

test("a curly apostrophe from dictation reads like a straight one", () => {
  assert.equal(parse("add clear the gutters to sam’s to-do list").personId, "p-sam");
});

test("a name at the front counts only when the task plainly follows it", () => {
  // Found in the second review: a bare "for Sam" at the front took sentences
  // that are about Sam, not for Sam, and cut them in half.
  const both = parse("add a task for sam and alex to tidy the garage");
  assert.equal(both.title, "For sam and alex to tidy the garage");
  assert.equal(both.personId, "");

  const birthday = parse("add a task for sam's birthday buy a cake");
  assert.equal(birthday.title, "For sam's birthday buy a cake");
  assert.equal(birthday.personId, "");

  const noTo = parse("add a task for sam ring the plumber");
  assert.equal(noTo.title, "For sam ring the plumber", "without 'to' it is left whole, to assign in the app");
  assert.equal(noTo.personId, "");
});
