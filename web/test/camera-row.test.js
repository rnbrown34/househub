// camera-row.test.js — the Cameras row on Today shows what the household chose.
//
// Both faults this guards against were found in review before release, and
// neither was visible in the pure tests, because each lived in which endpoint
// the component asked rather than in any logic:
//
//   - reading Home Assistant's raw entity list put cameras the household had
//     hidden "from the Home tab and displays" on the hallway tablet, under
//     Home Assistant's names instead of theirs;
//   - reading only Home Assistant emptied the row for a household that runs
//     CamWatch, which was the one place CamWatch cameras appeared at all.
//
// So this renders the real component against a stand-in session.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");

let JSDOM, esbuild;
try { ({ JSDOM } = await import("jsdom")); } catch { /* reported below */ }
try { esbuild = await import("esbuild"); } catch { /* reported below */ }

const ready = Boolean(JSDOM && esbuild);
const needs = { skip: ready ? false : "needs jsdom and esbuild" };

let dom = null;
if (ready) {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event",
                   "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    if (dom.window[k] !== undefined) {
      Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

/* The session the component sees. Each test sets globalThis.__cams. */
const MOCK_SESSION = `
const c = () => globalThis.__cams;
const ask = (name, v) => { c().asked.push(name); return v instanceof Error ? Promise.reject(v) : Promise.resolve(v); };
export const isDisplay = () => Boolean(c().display);
export const homeDevices = () => ask("homeDevices", c().devices);
export const homeEntities = () => ask("homeEntities", c().entities);
export const listCameras = () => ask("listCameras", c().camwatch);
export const cameraUrl = (id) => (c().display ? "api/display/home/camera/" : "api/households/h/home/camera/") + id + ".jpg";
export const cameraSnapshotUrl = (id) => (c().display ? "api/display/cameras/snapshot/" : "api/households/h/cameras/snapshot/") + id + ".jpg";
export const homeControl = () => Promise.resolve({});
export const snapshot = () => ({});
export const request = () => Promise.resolve(null);
`;

let built = null;
async function load() {
  if (built) return built;
  const dir = mkdtempSync(join(WEB, "node_modules", ".hh-camera-"));
  const mock = join(dir, "session.js");
  writeFileSync(mock, MOCK_SESSION);
  const real = resolve(WEB, "src/lib/session.js");
  const out = join(dir, "bundle.mjs");
  await esbuild.build({
    stdin: {
      contents: `export { default as SecondBlock, SecondBlockSettings } from ${JSON.stringify(join(WEB, "src/components/SecondBlock.jsx"))};`,
      resolveDir: WEB, loader: "jsx",
    },
    bundle: true, format: "esm", platform: "node", jsx: "automatic", outfile: out, logLevel: "error",
    external: ["react", "react-dom", "react/jsx-runtime", "*.woff2", "*.css"],
    loader: { ".js": "jsx" }, mainFields: ["module", "main"], define: { "import.meta.env": "{}" },
    plugins: [{
      name: "mock-session",
      setup(b) {
        b.onResolve({ filter: /session\.js$/ }, (args) =>
          (resolve(args.resolveDir, args.path) === real ? { path: mock } : null));
      },
    }],
  });
  built = await import(pathToFileURL(out).href);
  return built;
}

const T = { bg: "#111", panel: "#222", panelAlt: "#333", line: "#444", ink: "#eee", faint: "#999", brand: "#2f6f4f" };
const HA_UNCONFIGURED = Object.assign(new Error("Home Assistant is not set up"), { status: 503 });
const NOT_CONNECTED = Object.assign(new Error("CamWatch is not connected"), { status: 404 });

/** Render the Today row and return its text and images once loading settles. */
async function renderRow(cams, picks = []) {
  globalThis.__cams = { asked: [], ...cams };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { SecondBlock } = await load();
  const el = dom.window.document.getElementById("root");
  el.innerHTML = "";
  const root = createRoot(el);
  const data = { secondBlock: { all: { kind: "camera", picks } } };
  await act(async () => { root.render(React.createElement(SecondBlock, { data, update: () => {}, filter: "all", theme: T })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const imgs = [...el.querySelectorAll("img")].map((i) => ({ alt: i.getAttribute("alt"), src: i.getAttribute("src") }));
  const text = el.textContent;
  await act(async () => { root.unmount(); });
  return { text, imgs, asked: globalThis.__cams.asked };
}

test("a household with only CamWatch still sees its cameras on Today", needs, async () => {
  const { imgs, text } = await renderRow({
    display: true,
    devices: HA_UNCONFIGURED,
    camwatch: [{ id: "cw-driveway", name: "Driveway" }, { id: "cw-porch", name: "Porch" }],
  }, ["cw-driveway", "cw-porch"]);
  assert.deepEqual(imgs.map((i) => i.alt), ["Driveway", "Porch"], text);
  assert.ok(imgs[0].src.startsWith("api/display/cameras/snapshot/cw-driveway.jpg"));
});

test("Home Assistant cameras come with the household's names, and hidden ones stay off", needs, async () => {
  // The devices endpoint is what applies "Hide" and the household's names; the
  // raw entity list does neither. The component must ask the former.
  const { imgs, asked } = await renderRow({
    display: true,
    devices: { entities: [{ entityId: "camera.front_door", name: "Front door", domain: "camera" }] },
    entities: [
      { entityId: "camera.front_door", name: "Reolink E1 Pro", domain: "camera" },
      { entityId: "camera.kids_bedroom", name: "Kids Bedroom", domain: "camera" },
    ],
    camwatch: NOT_CONNECTED,
  });
  assert.deepEqual(imgs.map((i) => i.alt), ["Front door"]);
  assert.ok(!asked.includes("homeEntities"), "the raw entity list carries hidden cameras and must not be read");
  assert.ok(imgs[0].src.startsWith("api/display/home/camera/camera.front_door.jpg"));
});

test("a chosen camera that has gone away is reported, not replaced by every camera", needs, async () => {
  const { imgs, text } = await renderRow({
    devices: { entities: [
      { entityId: "camera.garden", name: "Garden", domain: "camera" },
      { entityId: "camera.hall", name: "Hall", domain: "camera" },
    ] },
    camwatch: NOT_CONNECTED,
  }, ["camera.old_driveway"]);
  assert.deepEqual(imgs, [], "nothing the household did not choose");
  assert.match(text, /chosen for this row are not available/);
});

test("both sources together, each shown from its own endpoint", needs, async () => {
  const { imgs } = await renderRow({
    devices: { entities: [{ entityId: "camera.garden", name: "Garden", domain: "camera" }] },
    camwatch: [{ id: "cw-porch", name: "Porch" }],
  });
  assert.deepEqual(imgs.map((i) => i.alt), ["Garden", "Porch"]);
  assert.ok(imgs[0].src.startsWith("api/households/h/home/camera/camera.garden.jpg"));
  assert.ok(imgs[1].src.startsWith("api/households/h/cameras/snapshot/cw-porch.jpg"));
});

test("nothing connected says so, in words that fit a shared screen", needs, async () => {
  const { text } = await renderRow({ display: true, devices: HA_UNCONFIGURED, camwatch: NOT_CONNECTED });
  assert.match(text, /No cameras to show on this screen/);
});

test("the lights row reads the devices view too, so hidden lights stay off Today", needs, async () => {
  globalThis.__cams = {
    asked: [],
    devices: { entities: [{ entityId: "light.hall", name: "Hall", domain: "light", state: "on" }] },
    entities: [
      { entityId: "light.hall", name: "Hall ceiling (Hue)", domain: "light", state: "on" },
      { entityId: "light.bedroom", name: "Bedroom", domain: "light", state: "off" },
    ],
  };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { SecondBlock } = await load();
  const el = dom.window.document.getElementById("root");
  el.innerHTML = "";
  const root = createRoot(el);
  const data = { secondBlock: { all: { kind: "devices", picks: [] } } };
  try {
    await act(async () => { root.render(React.createElement(SecondBlock, { data, update: () => {}, filter: "all", theme: T })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const names = [...el.querySelectorAll("button")].map((b) => b.textContent);
    assert.equal(names.length, 1, names.join(" | "));
    assert.match(names[0], /^Hall/);
    assert.ok(!globalThis.__cams.asked.includes("homeEntities"));
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a stale camera selection can be put back to 'show all' from the picker", needs, async () => {
  globalThis.__cams = {
    asked: [],
    devices: { entities: [{ entityId: "camera.garden", name: "Garden", domain: "camera" }] },
    camwatch: NOT_CONNECTED,
  };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { SecondBlockSettings } = await load();
  const box = { data: { secondBlock: { all: { kind: "camera", picks: ["camera.old_driveway"] } } } };
  const update = (fn) => { box.data = fn({ ...box.data }); };
  const el = dom.window.document.getElementById("root");
  el.innerHTML = "";
  const root = createRoot(el);
  const render = async () => act(async () => {
    root.render(React.createElement(SecondBlockSettings, { data: box.data, update, theme: T, people: [] }));
  });
  try {
    await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.match(el.textContent, /None of the chosen ones are available/);
    const showAll = [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === "Show all");
    assert.ok(showAll, "there is a way back to all");
    await act(async () => { showAll.click(); });
    assert.deepEqual(box.data.secondBlock.all, { kind: "camera", picks: [] });
  } finally {
    await act(async () => { root.unmount(); });
  }
});
