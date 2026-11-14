import { useEffect, useReducer } from "react";
import editorDefaults from "../config/editorDefaults.json";
import type { Project } from "../core/model.ts";
import { createSampleProject, parseProject, serializeProject } from "../core/project.ts";

const STORAGE_KEY = "arhitektura.project";
const HISTORY_LIMIT = 200;

interface State {
  project: Project;
  past: Project[];
  future: Project[];
}

type Action =
  /** record: false replaces the current state without an undo step (mid-drag). */
  | { type: "set"; project: Project; record: boolean }
  | { type: "load"; project: Project }
  | { type: "undo" }
  | { type: "redo" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set":
      if (!action.record) return { ...state, project: action.project };
      return {
        project: action.project,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
      };
    case "load":
      return { project: action.project, past: [], future: [] };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future],
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { project: next, past: [...state.past, state.project], future: rest };
    }
  }
}

function initialState(): State {
  let project: Project | null = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) project = parseProject(saved);
  } catch {
    project = null; // unreadable autosave: start from the sample instead
  }
  return {
    project: project ?? createSampleProject(editorDefaults.wallThickness),
    past: [],
    future: [],
  };
}

export function useProjectStore() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeProject(state.project));
    } catch {
      // Storage full or blocked: the project still lives in memory.
    }
  }, [state.project]);

  return {
    project: state.project,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    set: (project: Project, record = true) => dispatch({ type: "set", project, record }),
    load: (project: Project) => dispatch({ type: "load", project }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
  };
}
