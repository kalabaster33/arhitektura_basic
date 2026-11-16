import { useState } from "react";
import { type AreaConfig, formatArea } from "../core/areas.ts";
import { type ColumnConfig, proposeColumns } from "../core/columns.ts";
import { formatLatLon } from "../core/geo.ts";
import { type CoreElement, type CoreKind, type Project, type Stage, type Storey, STAGES } from "../core/model.ts";
import {
  type StructureStatus,
  clearFootprint,
  coreRect,
  removeCoreElement,
  ringArea,
  ringPerimeter,
  setAllErkerEdges,
  setErkerDepth,
  setColumns,
  setErkerEdge,
  setStructureThickness,
  stageBlocker,
  updateCoreElement,
  upperOutline,
} from "../core/structure.ts";
import { LengthField } from "./Sidebar.tsx";

export const STAGE_LABEL: Record<Stage, string> = {
  lot: "Lot",
  outline: "Building outline",
  erker: "Erker and floors",
  core: "Entrance and core",
  apartments: "Apartments",
};

/** The steps of the workflow across the top: where the project is and what opens next. */
export function Stepper(props: { project: Project; onStage: (stage: Stage) => void }) {
  const { project } = props;
  const index = STAGES.indexOf(project.stage);
  const next = STAGES[index + 1];
  const nextBlocker = next ? stageBlocker(project, next) : null;
  return (
    <nav className="stepper" aria-label="Steps">
      <ol>
        {STAGES.map((stage, i) => {
          const blocker = stageBlocker(project, stage);
          return (
            <li key={stage}>
              <button
                className={stage === project.stage ? "is-active" : ""}
                aria-current={stage === project.stage ? "step" : undefined}
                disabled={blocker !== null}
                title={blocker ?? undefined}
                onClick={() => props.onStage(stage)}
              >
                <span className="stepper__number">{i + 1}</span>
                {STAGE_LABEL[stage]}
              </button>
            </li>
          );
        })}
      </ol>
      {next && (
        <>
          {nextBlocker && <span className="stepper__blocker">{nextBlocker}</span>}
          <button
            className="stepper__next"
            disabled={nextBlocker !== null}
            title={nextBlocker ?? undefined}
            onClick={() => props.onStage(next)}
          >
            Next: {STAGE_LABEL[next]} →
          </button>
        </>
      )}
    </nav>
  );
}

/** Step 1: where the plot is on the earth. The plot itself is in the Site panel below. */
export function LocationPanel(props: {
  project: Project;
  showMap: boolean;
  onPickOnMap: () => void;
  onShowMap: (show: boolean) => void;
  onChange: (project: Project) => void;
}) {
  const { location } = props.project.site;
  return (
    <section className="panel">
      <h2>
        Location <small>{location ? "set" : "not set · optional"}</small>
      </h2>
      {location ? (
        <>
          <table className="figures">
            <tbody>
              <tr>
                <th>Origin of the plan</th>
                <td>{formatLatLon(location)}</td>
              </tr>
            </tbody>
          </table>
          <label className="check">
            <input type="checkbox" checked={props.showMap} onChange={(e) => props.onShowMap(e.target.checked)} />
            Show the map under the plan
          </label>
          <div className="button-row location__buttons">
            <button onClick={props.onPickOnMap}>Change on map…</button>
            <button
              onClick={() => props.onChange({ ...props.project, site: { ...props.project.site, location: null } })}
            >
              Remove location
            </button>
          </div>
          <p className="hint">
            The cross on the plan (x 0, y 0) is this place. Draw the plot over the map with the Plot
            tool. The map follows the north direction set in the Site panel.
          </p>
        </>
      ) : (
        <>
          <div className="button-row">
            <button className="is-active" onClick={props.onPickOnMap}>
              Pinpoint on map…
            </button>
          </div>
          <p className="hint">
            Point at the place of the plot on a map and the map is shown under the plan, at scale, so
            the plot sits in its real spot. You can also skip this and just draw.
          </p>
        </>
      )}
    </section>
  );
}

/** Step 2: the outline of the ground floor and the area of the base. */
export function OutlinePanel(props: {
  project: Project;
  buildingId: string;
  config: AreaConfig;
  onChange: (project: Project) => void;
}) {
  const { project, buildingId } = props;
  const { structure } = project.site.buildings.find((b) => b.id === buildingId)!;
  const f = (v: number) => formatArea(v, props.config);
  const drawn = structure.footprint.length >= 3;
  return (
    <section className="panel">
      <h2>
        Building outline <small>{drawn ? `${structure.footprint.length} corners` : "not drawn yet"}</small>
      </h2>
      {drawn ? (
        <>
          <table className="figures">
            <tbody>
              <tr>
                <th>Area of the base</th>
                <td>
                  <strong>{f(ringArea(structure.footprint))} m²</strong>
                </td>
              </tr>
              <tr>
                <th>Perimeter</th>
                <td>{ringPerimeter(structure.footprint).toFixed(2)} m</td>
              </tr>
            </tbody>
          </table>
          <LengthField
            label="Thickness of the outside walls"
            value={structure.wallThickness}
            min={0.01}
            onCommit={(v) => props.onChange(setStructureThickness(project, buildingId, { wallThickness: v }))}
          />
          <div className="button-row">
            <button
              onClick={() => {
                if (!window.confirm("Remove the outline and draw it again? Undo brings it back.")) return;
                props.onChange(clearFootprint(project, buildingId));
              }}
            >
              Draw again
            </button>
          </div>
          <p className="hint">
            Drag a corner to reshape the outline; the area follows. The outline is the outside face
            of the ground floor walls, so the area of the base is the area you drew.
          </p>
        </>
      ) : (
        <p className="hint">
          Click the corners of the ground floor on the plan, one after the other. Click the first
          corner again, or press Enter, to close the outline. Hold Shift for a straight edge. The
          area of the base is shown as you draw.
        </p>
      )}
    </section>
  );
}

/** Step 3: how far the floors above project, and on which sides. */
export function ErkerPanel(props: {
  project: Project;
  buildingId: string;
  config: AreaConfig;
  onChange: (project: Project) => void;
}) {
  const { project, buildingId } = props;
  const building = project.site.buildings.find((b) => b.id === buildingId)!;
  const { structure } = building;
  const { depth, edges } = structure.erker;
  const f = (v: number) => formatArea(v, props.config);
  const base = ringArea(structure.footprint);
  const upper = ringArea(upperOutline(structure));
  const on = edges.filter(Boolean).length;
  return (
    <section className="panel">
      <h2>
        Erker <small>{depth > 0 && on > 0 ? `${depth.toFixed(2)} m on ${on} of ${edges.length} sides` : "none"}</small>
      </h2>
      <LengthField
        label="Largest projection (0 for no erker)"
        value={depth}
        min={0}
        onCommit={(v) => props.onChange(setErkerDepth(project, buildingId, v))}
      />
      <h3>Sides with the erker</h3>
      <ul className="sides">
        {structure.footprint.map((a, i) => {
          const b = structure.footprint[(i + 1) % structure.footprint.length];
          return (
            <li key={i}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={edges[i] === true}
                  onChange={(e) => props.onChange(setErkerEdge(project, buildingId, i, e.target.checked))}
                />
                Side {i + 1} <small>{Math.hypot(b.x - a.x, b.y - a.y).toFixed(2)} m</small>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="button-row">
        <button onClick={() => props.onChange(setAllErkerEdges(project, buildingId, true))}>All sides</button>
        <button onClick={() => props.onChange(setAllErkerEdges(project, buildingId, false))}>No side</button>
      </div>
      <table className="figures">
        <tbody>
          <tr>
            <th>Area of the base</th>
            <td>{f(base)} m²</td>
          </tr>
          <tr>
            <th>Area of a floor above</th>
            <td>
              {f(upper)} m² {upper > base && <small>+{f(upper - base)} m²</small>}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        The erker is drawn on every storey above the ground floor: add storeys below and open one to
        see it. On the ground floor it is the dashed line. Click a side on the plan, or tick it
        here, to switch its erker on or off.
      </p>
      <p className="hint hint--warn">
        How far and on which sides a building may project comes from the planning conditions of the
        plot — to be verified by a licensed engineer.
      </p>
    </section>
  );
}

const CORE_NAME: Record<CoreKind, string> = { hall: "Hall", stair: "Stairs", elevator: "Elevator" };

function CoreRow(props: { element: CoreElement; index: number; onResize: (a: CoreElement["a"], b: CoreElement["b"]) => void; onRemove: () => void }) {
  const { min, max } = coreRect(props.element);
  return (
    <li>
      <div className="core-list__head">
        <strong>
          {CORE_NAME[props.element.kind]}
          {props.index > 0 ? ` ${props.index + 1}` : ""}
        </strong>
        <button onClick={props.onRemove} title="Remove it from every storey">
          Remove
        </button>
      </div>
      <div className="field-grid">
        <LengthField
          label="Width (x)"
          value={max.x - min.x}
          min={0.5}
          onCommit={(v) => props.onResize(min, { x: min.x + v, y: max.y })}
        />
        <LengthField
          label="Length (y)"
          value={max.y - min.y}
          min={0.5}
          onCommit={(v) => props.onResize(min, { x: max.x, y: min.y + v })}
        />
      </div>
    </li>
  );
}

/** Step 4: the entrance, the hall, the stairs and the elevator. */
export function CorePanel(props: {
  project: Project;
  buildingId: string;
  status: StructureStatus;
  onChange: (project: Project) => void;
}) {
  const { project, buildingId, status } = props;
  const { structure } = project.site.buildings.find((b) => b.id === buildingId)!;
  const seen: Record<CoreKind, number> = { hall: 0, stair: 0, elevator: 0 };
  const item = (done: boolean, text: string, optional = false) => (
    <li className={done ? "is-done" : optional ? "is-optional" : ""}>
      <span aria-hidden="true">{done ? "✓" : "○"}</span> {text}
    </li>
  );
  return (
    <section className="panel">
      <h2>Entrance and core</h2>
      <ul className="checklist">
        {item(status.entrances > 0, status.entrances > 1 ? `Entrance × ${status.entrances}` : "Entrance")}
        {item(status.halls > 0, "Hall")}
        {item(status.stairs > 0, "Stairs")}
        {item(status.elevators > 0, "Elevator (optional)", true)}
      </ul>
      {structure.core.length > 0 && (
        <ul className="core-list">
          {structure.core.map((c) => (
            <CoreRow
              key={c.id}
              element={c}
              index={seen[c.kind]++}
              onResize={(a, b) => props.onChange(updateCoreElement(project, buildingId, c.id, a, b))}
              onRemove={() => props.onChange(removeCoreElement(project, buildingId, c.id))}
            />
          ))}
        </ul>
      )}
      <LengthField
        label="Thickness of the core walls"
        value={structure.coreWallThickness}
        min={0.01}
        onCommit={(v) => props.onChange(setStructureThickness(project, buildingId, { coreWallThickness: v }))}
      />
      <p className="hint">
        Entrance: choose the tool and click an outside wall of the ground floor. Hall, Stairs and
        Elevator: choose the tool and drag a rectangle; it is drawn on every storey so the core lines
        up from floor to floor. Sizes are to the wall centrelines. The entrance door can be dragged
        along its wall with Select, and removed with Delete.
      </p>
    </section>
  );
}

/**
 * Columns: a grid proposed from the walls between the apartments of one
 * storey, the same on every storey. Doors and windows are kept clear of them.
 */
export function ColumnsPanel(props: {
  project: Project;
  buildingId: string;
  /** The storey the grid is read from. */
  storey: Storey;
  config: ColumnConfig;
  disabled?: boolean;
  onChange: (project: Project) => void;
}) {
  const { project, buildingId, storey } = props;
  const building = project.site.buildings.find((b) => b.id === buildingId)!;
  const count = building.structure.columns?.length ?? 0;
  const [width, setWidth] = useState(props.config.width);
  const [depth, setDepth] = useState(props.config.depth);
  const [maxSpan, setMaxSpan] = useState(props.config.maxSpan);
  const [note, setNote] = useState<string | null>(null);

  const propose = () => {
    const proposed = proposeColumns(building, storey, { ...props.config, width, depth, maxSpan });
    if (proposed.length === 0) {
      setNote("No columns could be placed: draw the building outline first.");
      return;
    }
    const doorsBefore = building.storeys.reduce((n, s) => n + s.openings.length, 0);
    const next = setColumns(project, buildingId, proposed);
    const doorsAfter = next.site.buildings.find((b) => b.id === buildingId)!.storeys.reduce((n, s) => n + s.openings.length, 0);
    const lost = doorsBefore - doorsAfter;
    setNote(
      lost > 0
        ? `${proposed.length} columns placed. ${lost} door${lost > 1 ? "s or windows" : " or window"} had no room left beside a column and ${lost > 1 ? "were" : "was"} removed.`
        : `${proposed.length} columns placed on every storey.`,
    );
    props.onChange(next);
  };
  const clear = () => {
    setNote(null);
    props.onChange(setColumns(project, buildingId, []));
  };

  return (
    <section className="panel">
      <h2>Columns</h2>
      <p className="hint">
        {count > 0 ? `${count} columns, the same on every storey.` : "No columns yet."} The grid is read from the
        walls between the apartments of {storey.name}, the outside walls and the core.
      </p>
      <LengthField label="Column width (x)" value={width} min={0.05} onCommit={setWidth} />
      <LengthField label="Column depth (y)" value={depth} min={0.05} onCommit={setDepth} />
      <LengthField label="Largest span" value={maxSpan} min={1} onCommit={setMaxSpan} />
      <button className="is-active" disabled={props.disabled} onClick={propose}>
        {count > 0 ? "Propose the grid again" : "Propose columns"}
      </button>{" "}
      {count > 0 && (
        <button disabled={props.disabled} onClick={clear}>
          Remove all columns
        </button>
      )}
      {note && <p className="hint">{note}</p>}
      <p className="hint hint--warn">
        A first grid to work from, not a structural design — to be verified by a licensed engineer.
      </p>
    </section>
  );
}
