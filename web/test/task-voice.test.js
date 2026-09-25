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

test("a name after 'for' assigns it, when it is somebody here", () => {
  const got = parse("add a task to book the mot for sam");
  assert.equal(got.title, "Book the mot");
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
    assert.equal(got.title, "Ring the plumber", said);
    assert.equal(got.date, "2026-09-26", said);
  }
  assert.equal(parse("add a task ring the plumber tomorrow for sam").personId, "p-sam");
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
  const t = V.taskFromCommand(parse("add a task ring the plumber for sam"), () => `id${++n}`);
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
