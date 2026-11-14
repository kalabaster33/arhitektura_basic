import { useEffect, useMemo, useRef, useState } from "react";
import areaDefinitions from "../config/areaDefinitions.json";
import editorDefaults from "../config/editorDefaults.json";
import { computeStoreyAreas, formatArea, parseAreaConfig } from "../core/areas.ts";
import { deleteWall } from "../core/edit.ts";
import type { Storey, WallKind } from "../core/model.ts";
import {
  createProject,
  getActiveStorey,
  parseProject,
  replaceStorey,
  serializeProject,
} from "../core/project.ts";
import { linkSpaces } from "../core/spaces.ts";
import { PlanCanvas, type Selection, type Tool } from "./PlanCanvas.tsx";
import { AreaTable, LengthField, PropertiesPanel } from "./Sidebar.tsx";
import { useProjectStore } from "./useProjectStore.ts";

const areaConfig = parseAreaConfig(areaDefinitions);

export function App() {
  const store = useProjectStore();
  const { project } = store;
  const storey = getActiveStorey(project);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [wallKind, setWallKind] = useState<WallKind>("exterior");
  const [thickness, setThickness] = useState(editorDefaults.wallThickness);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const linked = useMemo(() => linkSpaces(storey), [storey]);
  const areas = useMemo(() => computeStoreyAreas(storey, areaConfig), [storey]);
  const netById = useMemo(() => new Map(areas.spaces.map((s) => [s.spaceId, s.net])), [areas]);

  const setStorey = (next: Storey, record = true) => store.set(replaceStorey(project, next), record);

  // Latest values for the keyboard handler, which is attached once.
  const live = useRef({ store, storey, selection, setStorey });
  live.current = { store, storey, selection, setStorey };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const { store, storey, selection, setStorey } = live.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        store.redo();
      } else if (!mod && key === "v") setTool("select");
      else if (!mod && key === "w") setTool("wall");
      else if (e.key === "Escape") setSelection(null);
      else if ((e.key === "Delete" || e.key === "Backspace") && selection?.kind === "wall") {
        e.preventDefault();
        setStorey(deleteWall(storey, selection.id));
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const save = () => {
    const blob = new Blob([serializeProject(project)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${project.name.replace(/[^\w-]+/g, "_") || "project"}.arh.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const open = async (file: File | undefined) => {
    if (!file) return;
    try {
      store.load(parseProject(await file.text()));
      setSelection(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const newProject = () => {
    if (storey.walls.length > 0 && !window.confirm("Start an empty project? The current plan is replaced (save it first to keep it).")) {
      return;
    }
    store.load(createProject("Untitled project", editorDefaults.snapStep));
    setSelection(null);
  };

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">Arhitektura</strong>
        <input
          className="project-name"
          value={project.name}
          aria-label="Project name"
          onChange={(e) => store.set({ ...project, name: e.target.value }, false)}
        />
        <div className="group" role="group" aria-label="Tool">
          <button className={tool === "select" ? "is-active" : ""} onClick={() => setTool("select")} title="Select and move (V)">
            Select
          </button>
          <button className={tool === "wall" ? "is-active" : ""} onClick={() => setTool("wall")} title="Draw walls (W)">
            Wall
          </button>
        </div>
        <label className="inline">
          New walls
          <select value={wallKind} onChange={(e) => setWallKind(e.target.value as WallKind)}>
            <option value="exterior">exterior</option>
            <option value="interior">interior</option>
          </select>
        </label>
        <div className="inline-field">
          <LengthField
            label="Thickness"
            value={thickness[wallKind]}
            min={0.01}
            onCommit={(v) => setThickness({ ...thickness, [wallKind]: v })}
          />
        </div>
        <div className="inline-field">
          <LengthField
            label="Snap"
            value={project.grid.snap}
            min={0.001}
            onCommit={(v) => store.set({ ...project, grid: { snap: v } }, false)}
          />
        </div>
        <span className="spacer" />
        <div className="group">
          <button onClick={store.undo} disabled={!store.canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button onClick={store.redo} disabled={!store.canRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
        </div>
        <div className="group">
          <button onClick={newProject}>New</button>
          <button onClick={() => fileInput.current?.click()}>Open…</button>
          <button onClick={save}>Save JSON</button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            void open(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </header>

      {error && (
        <div className="error" role="alert">
          Could not open the file: {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <main className="workspace">
        <div className="canvas-wrap">
          <PlanCanvas
            storey={storey}
            faceBySpaceId={linked.faceBySpaceId}
            areaLabel={(id) => `${formatArea(netById.get(id) ?? 0, areaConfig)} m²`}
            tool={tool}
            selection={selection}
            snapStep={project.grid.snap}
            wallThickness={thickness[wallKind]}
            wallKind={wallKind}
            onChange={setStorey}
            onSelect={setSelection}
          />
          <p className="status">
            {tool === "wall"
              ? "Click to place wall ends · Shift keeps it straight · Esc or right-click ends the run"
              : "Drag a wall or its end points · drag empty space to pan · wheel to zoom · Delete removes the selected wall"}
          </p>
        </div>
        <aside className="sidebar">
          <PropertiesPanel storey={storey} selection={selection} onChange={(s) => setStorey(s)} />
          <AreaTable
            storey={storey}
            areas={areas}
            config={areaConfig}
            selection={selection}
            onSelect={setSelection}
          />
        </aside>
      </main>
    </div>
  );
}
