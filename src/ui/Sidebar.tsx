import { useEffect, useState } from "react";
import { type AreaConfig, type BuildingAreas, type StoreyAreas, formatArea } from "../core/areas.ts";
import type { ElevationIssue } from "../core/building.ts";
import type { CoreIssue } from "../core/coreAlignment.ts";
import { moveNode, setWallKind, setWallLength, setWallThickness, updateSpace } from "../core/edit.ts";
import { type Pt, dist } from "../core/geometry.ts";
import { type SpaceType, type Storey, type Wall, SPACE_TYPES } from "../core/model.ts";
import { parseLength } from "../core/units.ts";
import type { Selection } from "./PlanCanvas.tsx";

/**
 * Text field for a dimension. Accepts "3.20 m", "3,2", "320 cm"; commits on
 * Enter or when focus leaves, and turns red instead of committing nonsense.
 */
export function LengthField(props: {
  label: string;
  value: number;
  min?: number;
  onCommit: (metres: number) => void;
}) {
  const shown = props.value.toFixed(2);
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(shown);
    setInvalid(false);
  }, [shown]);

  const commit = () => {
    const metres = parseLength(text);
    if (metres === null || (props.min !== undefined && metres < props.min)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(metres.toFixed(2));
    if (Math.abs(metres - props.value) > 1e-9) props.onCommit(metres);
  };

  return (
    <label className="field">
      <span>{props.label}</span>
      <span className="field__input">
        <input
          value={text}
          className={invalid ? "is-invalid" : ""}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setText(shown);
              setInvalid(false);
            }
          }}
        />
        <em>m</em>
      </span>
    </label>
  );
}

function WallPanel(props: { storey: Storey; wall: Wall; onChange: (s: Storey) => void }) {
  const { storey, wall, onChange } = props;
  const end = (key: "a" | "b", axis: "x" | "y", label: string) => (
    <LengthField
      label={label}
      value={wall[key][axis]}
      onCommit={(v) => {
        const to: Pt = { ...wall[key], [axis]: v };
        onChange(moveNode(storey, wall[key], to));
      }}
    />
  );
  return (
    <section className="panel">
      <h2>Wall</h2>
      <LengthField
        label="Length"
        value={dist(wall.a, wall.b)}
        min={0.01}
        onCommit={(v) => onChange(setWallLength(storey, wall.id, v))}
      />
      <LengthField
        label="Thickness"
        value={wall.thickness}
        min={0.01}
        onCommit={(v) => onChange(setWallThickness(storey, wall.id, v))}
      />
      <label className="field">
        <span>Kind</span>
        <select
          value={wall.kind}
          onChange={(e) => onChange(setWallKind(storey, wall.id, e.target.value as Wall["kind"]))}
        >
          <option value="exterior">exterior</option>
          <option value="interior">interior</option>
        </select>
      </label>
      <div className="field-grid">
        {end("a", "x", "Start x")}
        {end("a", "y", "Start y")}
        {end("b", "x", "End x")}
        {end("b", "y", "End y")}
      </div>
      <p className="hint">
        Length is measured from the start; the end and any walls joined to it move.
      </p>
    </section>
  );
}

function SpacePanel(props: { storey: Storey; spaceId: string; onChange: (s: Storey) => void }) {
  const { storey, onChange } = props;
  const space = storey.spaces.find((s) => s.id === props.spaceId);
  if (!space) return null;
  return (
    <section className="panel">
      <h2>Room</h2>
      <label className="field">
        <span>Name</span>
        <input
          value={space.name}
          onChange={(e) => onChange(updateSpace(storey, space.id, { name: e.target.value }))}
        />
      </label>
      <label className="field">
        <span>Type</span>
        <select
          value={space.type}
          onChange={(e) =>
            onChange(updateSpace(storey, space.id, { type: e.target.value as SpaceType }))
          }
        >
          {SPACE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">Bounded by {space.wallIds.length} walls. Move any of them to resize it.</p>
    </section>
  );
}

export function AreaTable(props: {
  storey: Storey;
  areas: StoreyAreas;
  buildingAreas: BuildingAreas;
  config: AreaConfig;
  onSelectStorey: (storeyId: string) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const { areas, config, selection } = props;
  const f = (v: number) => formatArea(v, config);
  return (
    <section className="panel">
      <h2>
        Areas <small>{props.storey.name} · m²</small>
      </h2>
      {areas.spaces.length === 0 ? (
        <p className="hint">No rooms yet. A room appears as soon as walls close around it.</p>
      ) : (
        <table className="areas">
          <thead>
            <tr>
              <th>Room</th>
              <th>Net</th>
              <th>Useful</th>
              <th>Gross</th>
            </tr>
          </thead>
          <tbody>
            {areas.spaces.map((row) => (
              <tr
                key={row.spaceId}
                className={
                  selection?.kind === "space" && selection.id === row.spaceId ? "is-selected" : ""
                }
                onClick={() => props.onSelect({ kind: "space", id: row.spaceId })}
              >
                <td>
                  {row.name}
                  {row.type !== "room" && <small>{row.type}</small>}
                </td>
                <td>{f(row.net)}</td>
                <td>{f(row.useful)}</td>
                <td>{f(row.gross)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Storey</td>
              <td>{f(areas.totals.net)}</td>
              <td>{f(areas.totals.useful)}</td>
              <td>{f(areas.totals.gross)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {props.buildingAreas.storeys.length > 1 && (
        <table className="areas areas--building">
          <thead>
            <tr>
              <th>Building</th>
              <th>Net</th>
              <th>Useful</th>
              <th>Gross</th>
            </tr>
          </thead>
          <tbody>
            {props.buildingAreas.storeys
              .slice()
              .reverse()
              .map((row) => (
                <tr
                  key={row.storeyId}
                  className={row.storeyId === props.storey.id ? "is-selected" : ""}
                  onClick={() => props.onSelectStorey(row.storeyId)}
                >
                  <td>{row.name}</td>
                  <td>{f(row.totals.net)}</td>
                  <td>{f(row.totals.useful)}</td>
                  <td>{f(row.totals.gross)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{f(props.buildingAreas.totals.net)}</td>
              <td>{f(props.buildingAreas.totals.useful)}</td>
              <td>{f(props.buildingAreas.totals.gross)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      <p className="hint">
        Net: to the {config.net.boundary === "wallInnerFace" ? "inside wall faces" : "wall centrelines"}.
        Useful: net × type factor. Room gross: to the{" "}
        {config.gross.space === "wallCentreline" ? "wall centrelines" : "inside wall faces"}. Storey
        gross: to the{" "}
        {config.gross.storey === "wallOuterFace" ? "outside wall faces" : "wall centrelines"}.
      </p>
      <p className="hint hint--warn">
        Area definitions are placeholders — to be verified by a licensed engineer
        (src/config/areaDefinitions.json).
      </p>
    </section>
  );
}

export function PropertiesPanel(props: {
  storey: Storey;
  selection: Selection;
  onChange: (s: Storey) => void;
}) {
  const { storey, selection, onChange } = props;
  if (selection?.kind === "wall") {
    const wall = storey.walls.find((w) => w.id === selection.id);
    if (wall) return <WallPanel storey={storey} wall={wall} onChange={onChange} />;
  }
  if (selection?.kind === "space") {
    return <SpacePanel storey={storey} spaceId={selection.id} onChange={onChange} />;
  }
  return (
    <section className="panel">
      <h2>Properties</h2>
      <p className="hint">
        Select a wall to type its length, thickness or coordinates. Select a room to name it.
      </p>
    </section>
  );
}

const signed = (v: number) => `${v < 0 ? "\u2212" : "+"}${Math.abs(v).toFixed(2)}`;

export function StoreysPanel(props: {
  /** Lowest first. */
  storeys: Storey[];
  activeId: string;
  /** Number of warnings per storey id. */
  warningCount: Map<string, number>;
  canRestack: boolean;
  onSelect: (storeyId: string) => void;
  onAdd: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onRestack: () => void;
  onUpdate: (patch: Partial<Pick<Storey, "name" | "elevation" | "height">>) => void;
}) {
  const active = props.storeys.find((s) => s.id === props.activeId)!;
  return (
    <section className="panel">
      <h2>
        Storeys <small>{props.storeys.length}</small>
      </h2>
      <ul className="storeys">
        {props.storeys
          .slice()
          .reverse()
          .map((s) => (
            <li key={s.id}>
              <button
                className={s.id === props.activeId ? "is-active" : ""}
                onClick={() => props.onSelect(s.id)}
              >
                <span>{s.name}</span>
                {(props.warningCount.get(s.id) ?? 0) > 0 && (
                  <span className="badge" title="Warnings on this storey">
                    {props.warningCount.get(s.id)}
                  </span>
                )}
                <span className="level">{signed(s.elevation)} m</span>
              </button>
            </li>
          ))}
      </ul>
      <div className="button-row">
        <button onClick={props.onAdd} title="Add an empty storey on top">
          Add storey
        </button>
        <button onClick={props.onCopy} title="Copy this storey to the top of the building">
          Copy storey
        </button>
        <button onClick={props.onDelete} disabled={props.storeys.length <= 1}>
          Delete
        </button>
      </div>
      <label className="field">
        <span>Name</span>
        <input value={active.name} onChange={(e) => props.onUpdate({ name: e.target.value })} />
      </label>
      <div className="field-grid">
        <LengthField
          label="Elevation"
          value={active.elevation}
          onCommit={(v) => props.onUpdate({ elevation: v })}
        />
        <LengthField
          label="Floor-to-floor height"
          value={active.height}
          min={0.01}
          onCommit={(v) => props.onUpdate({ height: v })}
        />
      </div>
      {props.canRestack && (
        <button onClick={props.onRestack} title="Set each elevation to the top of the storey below">
          Restack elevations
        </button>
      )}
    </section>
  );
}

export function WarningsPanel(props: {
  coreIssues: CoreIssue[];
  elevationIssues: ElevationIssue[];
  storeyCount: number;
  hasCore: boolean;
  tolerance: number;
  onOpenCore: (issue: CoreIssue) => void;
  onOpenStorey: (storeyId: string) => void;
}) {
  const total = props.coreIssues.length + props.elevationIssues.length;
  return (
    <section className="panel">
      <h2>
        Core &amp; levels{" "}
        <small>{total === 0 ? "no warnings" : `${total} warning${total > 1 ? "s" : ""}`}</small>
      </h2>
      {total === 0 ? (
        props.storeyCount < 2 ? (
          <p className="hint">Add or copy a storey to check the core from floor to floor.</p>
        ) : props.hasCore ? (
          <p className="ok">Stairs, elevators and shafts line up on every floor.</p>
        ) : (
          <p className="hint">
            No core yet. Set the type of a room to stair, elevator or shaft and it is checked
            against the floors above and below.
          </p>
        )
      ) : (
        <ul className="warnings">
          {props.elevationIssues.map((issue) => (
            <li key={`e-${issue.storeyId}`}>
              <button onClick={() => props.onOpenStorey(issue.storeyId)}>{issue.message}</button>
            </li>
          ))}
          {props.coreIssues.map((issue) => (
            <li key={`c-${issue.storeyId}-${issue.spaceId}-${issue.otherStoreyId}`}>
              <button onClick={() => props.onOpenCore(issue)}>{issue.message}</button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Dashed outlines on the plan are the core of the floors above and below: green where it
        lines up, red where it does not. Tolerance {props.tolerance.toFixed(2)} m
        (src/config/coreAlignment.json, to be verified by a licensed engineer).
      </p>
    </section>
  );
}
