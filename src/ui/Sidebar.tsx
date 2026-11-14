import { useEffect, useState } from "react";
import { type AreaConfig, type StoreyAreas, formatArea } from "../core/areas.ts";
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
  config: AreaConfig;
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
