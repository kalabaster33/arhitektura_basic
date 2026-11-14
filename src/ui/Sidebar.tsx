import { useEffect, useState } from "react";
import {
  type ApartmentInfo,
  apartmentOfSpace,
  assignSpace,
  createApartment,
  deleteApartment,
  renameApartment,
} from "../core/apartments.ts";
import {
  type AreaConfig,
  type BuildingAreas,
  type SpaceAreas,
  type StoreyAreas,
  type StoreyAreasByApartment,
  formatArea,
} from "../core/areas.ts";
import { type ElevationIssue, moveBuilding } from "../core/building.ts";
import type { PlanIssue } from "../core/checks.ts";
import type { CoreIssue } from "../core/coreAlignment.ts";
import { moveNode, setWallKind, setWallLength, setWallThickness, updateSpace } from "../core/edit.ts";
import { type Pt, dist } from "../core/geometry.ts";
import {
  type Opening,
  type OpeningKind,
  type Project,
  type SpaceType,
  type Storey,
  type Wall,
  SPACE_TYPES,
} from "../core/model.ts";
import { deleteOpening, moveOpening, updateOpening } from "../core/openings.ts";
import {
  type SiteAnalysis,
  type SiteIssue,
  type SiteRules,
  clearBoundary,
  deleteBoundaryCorner,
  insertBoundaryCorner,
  moveBoundaryCorner,
  setSetback,
  setSiteLimits,
} from "../core/site.ts";
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

function OpeningPanel(props: { storey: Storey; opening: Opening; onChange: (s: Storey) => void }) {
  const { storey, opening, onChange } = props;
  const wall = storey.walls.find((w) => w.id === opening.wallId);
  return (
    <section className="panel">
      <h2>{opening.kind === "door" ? "Door" : "Window"}</h2>
      <label className="field">
        <span>Kind</span>
        <select
          value={opening.kind}
          onChange={(e) =>
            onChange(updateOpening(storey, opening.id, { kind: e.target.value as OpeningKind }))
          }
        >
          <option value="door">door</option>
          <option value="window">window</option>
        </select>
      </label>
      <div className="field-grid">
        <LengthField
          label="Width"
          value={opening.width}
          min={0.01}
          onCommit={(v) => onChange(updateOpening(storey, opening.id, { width: v }))}
        />
        <LengthField
          label="Height"
          value={opening.height}
          min={0.01}
          onCommit={(v) => onChange(updateOpening(storey, opening.id, { height: v }))}
        />
        <LengthField
          label="From wall start to centre"
          value={opening.offset}
          min={0}
          onCommit={(v) => onChange(moveOpening(storey, opening.id, v))}
        />
        {opening.kind === "window" && (
          <LengthField
            label="Sill height"
            value={opening.sill}
            min={0}
            onCommit={(v) => onChange(updateOpening(storey, opening.id, { sill: v }))}
          />
        )}
      </div>
      <button onClick={() => onChange(deleteOpening(storey, opening.id))}>
        Delete {opening.kind}
      </button>
      <p className="hint">
        {wall ? `On a ${dist(wall.a, wall.b).toFixed(2)} m ${wall.kind} wall. ` : ""}
        Drag it along the wall, or type a distance. It stops at joining walls and at other
        openings; a width that fits nowhere on the wall is not applied.
      </p>
    </section>
  );
}

const NEW_APARTMENT = "__new";

function SpacePanel(props: { storey: Storey; spaceId: string; onChange: (s: Storey) => void }) {
  const { storey, onChange } = props;
  const space = storey.spaces.find((s) => s.id === props.spaceId);
  if (!space) return null;
  const apartment = apartmentOfSpace(storey, space.id);
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
      <label className="field">
        <span>Apartment</span>
        <select
          value={apartment?.id ?? ""}
          onChange={(e) => {
            const value = e.target.value;
            onChange(
              value === NEW_APARTMENT
                ? createApartment(storey, [space.id]).storey
                : assignSpace(storey, space.id, value || null),
            );
          }}
        >
          <option value="">none (common area)</option>
          {storey.apartments.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value={NEW_APARTMENT}>New apartment…</option>
        </select>
      </label>
      <p className="hint">Bounded by {space.wallIds.length} walls. Move any of them to resize it.</p>
    </section>
  );
}

export function AreaTable(props: {
  storey: Storey;
  areas: StoreyAreas;
  byApartment: StoreyAreasByApartment;
  buildingAreas: BuildingAreas;
  config: AreaConfig;
  onSelectStorey: (storeyId: string) => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const { areas, byApartment, config, selection } = props;
  const f = (v: number) => formatArea(v, config);
  const roomRow = (row: SpaceAreas) => (
    <tr
      key={row.spaceId}
      className={selection?.kind === "space" && selection.id === row.spaceId ? "is-selected" : ""}
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
  );
  const grouped = byApartment.apartments.length > 0;
  const groups = [
    ...byApartment.apartments.map((a) => ({ key: a.apartmentId, name: a.name, group: a })),
    { key: "common", name: "Common area", group: byApartment.common },
  ].filter((g) => g.group.spaces.length > 0);
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
          {grouped ? (
            groups.map((g) => (
              <tbody key={g.key}>
                <tr className="areas__group">
                  <th scope="rowgroup">{g.name}</th>
                  <td>{f(g.group.totals.net)}</td>
                  <td>{f(g.group.totals.useful)}</td>
                  <td>{f(g.group.totals.gross)}</td>
                </tr>
                {g.group.spaces.map(roomRow)}
              </tbody>
            ))
          ) : (
            <tbody>{areas.spaces.map(roomRow)}</tbody>
          )}
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
        {grouped && " Apartment and common-area gross: the sum of their rooms' gross."}
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
  if (selection?.kind === "opening") {
    const opening = storey.openings.find((o) => o.id === selection.id);
    if (opening) return <OpeningPanel storey={storey} opening={opening} onChange={onChange} />;
  }
  if (selection?.kind === "space") {
    return <SpacePanel storey={storey} spaceId={selection.id} onChange={onChange} />;
  }
  return (
    <section className="panel">
      <h2>Properties</h2>
      <p className="hint">
        Select a wall to type its length, thickness or coordinates. Select a door or window to
        size it. Select a room to name it and put it in an apartment.
      </p>
    </section>
  );
}

export function ApartmentsPanel(props: {
  storey: Storey;
  infos: ApartmentInfo[];
  byApartment: StoreyAreasByApartment;
  config: AreaConfig;
  colorOf: (apartmentId: string) => string;
  /** Per apartment id: why a layout cannot be generated for it. Absent when it can. */
  layoutBlockers: Map<string, string>;
  /** The last attempt to generate a layout that found none. */
  layoutError: { apartmentId: string; reason: string } | null;
  /** True while a generated layout is being previewed. */
  previewing: boolean;
  onGenerate: (apartmentId: string) => void;
  selection: Selection;
  onChange: (s: Storey, record?: boolean) => void;
  onSelect: (s: Selection) => void;
}) {
  const { storey, selection, onChange } = props;
  const selectedRoom =
    selection?.kind === "space" ? storey.spaces.find((s) => s.id === selection.id) : undefined;
  return (
    <section className="panel">
      <h2>
        Apartments <small>{storey.name}</small>
      </h2>
      {storey.apartments.length > 0 && (
        <ul className="apartments">
          {storey.apartments.map((a) => {
            const info = props.infos.find((i) => i.apartmentId === a.id);
            const net = props.byApartment.apartments.find((x) => x.apartmentId === a.id)?.totals.net ?? 0;
            const rooms = a.spaceIds.length;
            const entrances = info?.entrances.length ?? 0;
            const blocker = props.layoutBlockers.get(a.id);
            const failed = props.layoutError?.apartmentId === a.id ? props.layoutError.reason : null;
            return (
              <li key={a.id}>
                <button
                  className="swatch"
                  style={{ background: props.colorOf(a.id) }}
                  title="Select the first room of this apartment"
                  aria-label={`Select ${a.name}`}
                  disabled={rooms === 0}
                  onClick={() => props.onSelect({ kind: "space", id: a.spaceIds[0] })}
                />
                <input
                  value={a.name}
                  aria-label="Apartment name"
                  onChange={(e) => onChange(renameApartment(storey, a.id, e.target.value), false)}
                />
                <button
                  title="Delete the apartment; its rooms stay"
                  aria-label={`Delete ${a.name}`}
                  onClick={() => onChange(deleteApartment(storey, a.id))}
                >
                  ×
                </button>
                <small>
                  {rooms === 0 ? "no rooms yet" : `${rooms} room${rooms > 1 ? "s" : ""}`} ·{" "}
                  {formatArea(net, props.config)} m² net
                  {rooms > 0 && (
                    <>
                      {" · "}
                      <span className={entrances === 0 ? "is-bad" : ""}>
                        {entrances === 0
                          ? "no entrance"
                          : `${entrances} entrance${entrances > 1 ? "s" : ""}`}
                      </span>
                      {(info?.pieces ?? 1) > 1 && <span className="is-bad"> · rooms not adjoining</span>}
                    </>
                  )}
                </small>
                {!props.previewing && (
                  <div className="apartments__layout">
                    <button
                      disabled={blocker !== undefined}
                      onClick={() => props.onGenerate(a.id)}
                    >
                      Generate layout
                    </button>
                    {(blocker ?? failed) && (
                      <small className={failed && !blocker ? "is-bad" : ""}>
                        {blocker ? `Not possible yet: ${blocker}` : `No layout found: ${failed}`}
                      </small>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button
        onClick={() => onChange(createApartment(storey, selectedRoom ? [selectedRoom.id] : []).storey)}
      >
        {selectedRoom ? `New apartment from "${selectedRoom.name}"` : "New apartment"}
      </button>
      <p className="hint">
        Select a room and choose its apartment in the Room panel. A room is in one apartment at
        most; rooms in none count as common area.
      </p>
      <p className="hint">
        Generate layout proposes a living room, a bedroom and a bathroom, with a corridor where
        needed, and shows up to three options to choose from. It needs an entrance door and an
        exterior wall, and does not add windows.
      </p>
      <p className="hint hint--warn">
        Room sizes for generated layouts are placeholders — to be verified by a licensed engineer
        (src/config/layoutRules.json).
      </p>
    </section>
  );
}

export function PlanChecksPanel(props: {
  storey: Storey;
  issues: PlanIssue[];
  onOpen: (issue: PlanIssue) => void;
}) {
  const { issues } = props;
  return (
    <section className="panel">
      <h2>
        Doors &amp; daylight{" "}
        <small>
          {issues.length === 0 ? "no warnings" : `${issues.length} warning${issues.length > 1 ? "s" : ""}`}
        </small>
      </h2>
      {issues.length === 0 ? (
        props.storey.spaces.length === 0 ? (
          <p className="hint">Nothing to check until the storey has rooms.</p>
        ) : (
          <p className="ok">No door, daylight or entrance warnings on this storey.</p>
        )
      ) : (
        <ul className="warnings">
          {issues.map((issue) => (
            <li key={`${issue.kind}-${issue.apartmentId ?? issue.spaceId}`}>
              <button onClick={() => props.onOpen(issue)}>{issue.message}</button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Checked on this storey: a door for every room, a window in an exterior wall for rooms that
        need daylight, an entrance for every apartment. Which room types each rule covers is set
        in src/config/roomChecks.json (to be verified by a licensed engineer).
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

/**
 * Text field for a number that may be left empty. Accepts a decimal comma;
 * commits on Enter or when focus leaves, and turns red instead of committing
 * nonsense.
 */
function OptionalNumberField(props: {
  label: string;
  value: number | null;
  unit?: string;
  decimals: number;
  placeholder: string;
  onCommit: (value: number | null) => void;
}) {
  const shown = props.value === null ? "" : props.value.toFixed(props.decimals);
  const [text, setText] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(shown);
    setInvalid(false);
  }, [shown]);

  const commit = () => {
    const trimmed = text.trim();
    const value = trimmed === "" ? null : Number(trimmed.replace(",", "."));
    if (value !== null && !(Number.isFinite(value) && value > 0)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (trimmed !== shown) props.onCommit(value);
  };

  return (
    <label className="field">
      <span>{props.label}</span>
      <span className="field__input">
        <input
          value={text}
          placeholder={props.placeholder}
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
        {props.unit && <em>{props.unit}</em>}
      </span>
    </label>
  );
}

/** Two distances and a button: shifts the whole building by what was typed. */
function MoveBuildingForm(props: { onMove: (delta: Pt) => void }) {
  const [dx, setDx] = useState("0");
  const [dy, setDy] = useState("0");
  const x = parseLength(dx);
  const y = parseLength(dy);
  const ready = x !== null && y !== null && (x !== 0 || y !== 0);
  const move = () => {
    if (x !== null && y !== null && ready) props.onMove({ x, y });
  };
  const field = (label: string, text: string, set: (v: string) => void, bad: boolean) => (
    <label className="field">
      <span>{label}</span>
      <span className="field__input">
        <input
          value={text}
          className={bad ? "is-invalid" : ""}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") move();
          }}
        />
        <em>m</em>
      </span>
    </label>
  );
  return (
    <>
      <div className="field-grid">
        {field("Move by x", dx, setDx, x === null)}
        {field("Move by y", dy, setDy, y === null)}
      </div>
      <button disabled={!ready} onClick={move}>
        Move building
      </button>
    </>
  );
}

export function SitePanel(props: {
  project: Project;
  buildingId: string;
  analysis: SiteAnalysis;
  rules: SiteRules;
  config: AreaConfig;
  siteToolActive: boolean;
  selection: Selection;
  onChange: (project: Project) => void;
  onSelect: (s: Selection) => void;
  onUseSiteTool: () => void;
}) {
  const { project, analysis: a, selection, onChange } = props;
  const { boundary, setbacks, limits } = project.site;
  const f = (v: number) => formatArea(v, props.config);
  const bad = (kind: SiteIssue["kind"]) => a.issues.some((i) => i.kind === kind);
  const edge = selection?.kind === "siteEdge" && boundary[selection.index] ? selection.index : null;
  const corner = selection?.kind === "siteCorner" && boundary[selection.index] ? selection.index : null;
  const count = a.issues.length;
  return (
    <section className="panel">
      <h2>
        Site{" "}
        <small>
          {!a.hasPlot ? "no plot yet" : count === 0 ? "no warnings" : `${count} warning${count > 1 ? "s" : ""}`}
        </small>
      </h2>
      {count > 0 && (
        <ul className="warnings">
          {a.issues.map((issue) => (
            <li key={issue.kind}>
              <button onClick={props.onUseSiteTool}>{issue.message}</button>
            </li>
          ))}
        </ul>
      )}
      {a.hasPlot && count === 0 && <p className="ok">The building is inside the setbacks and the limits.</p>}
      {!a.hasPlot && (
        <p className="hint">
          {props.siteToolActive
            ? "Click the corners of the plot on the plan. Click the first corner again, or press Enter, to close it."
            : "No plot is drawn. Choose the Site tool and click the corners of the plot on the plan."}
        </p>
      )}
      <table className="figures">
        <tbody>
          {a.hasPlot && (
            <>
              <tr>
                <th>Plot area</th>
                <td>{f(a.plotArea)} m²</td>
              </tr>
              <tr>
                <th>Buildable area</th>
                <td>{f(a.buildableArea)} m²</td>
              </tr>
            </>
          )}
          <tr>
            <th>Building footprint</th>
            <td>{f(a.footprintArea)} m²</td>
          </tr>
          {a.coverage !== null && (
            <tr>
              <th>Site coverage</th>
              <td className={bad("coverage") ? "is-bad" : ""}>
                {(a.coverage * 100).toFixed(1)} %
                {limits.maxCoverage !== null && <small>max {(limits.maxCoverage * 100).toFixed(1)} %</small>}
              </td>
            </tr>
          )}
          <tr>
            <th>Gross floor area</th>
            <td>{f(a.grossFloorArea)} m²</td>
          </tr>
          {a.floorAreaRatio !== null && (
            <tr>
              <th>Floor area ratio</th>
              <td className={bad("floorAreaRatio") ? "is-bad" : ""}>
                {a.floorAreaRatio.toFixed(2)}
                {limits.maxFloorAreaRatio !== null && <small>max {limits.maxFloorAreaRatio.toFixed(2)}</small>}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {a.hasPlot && (
        <>
          <div className="field-grid">
            <OptionalNumberField
              label="Max coverage"
              unit="%"
              decimals={1}
              placeholder="no limit"
              value={limits.maxCoverage === null ? null : limits.maxCoverage * 100}
              onCommit={(v) => onChange(setSiteLimits(project, { maxCoverage: v === null ? null : v / 100 }))}
            />
            <OptionalNumberField
              label="Max floor area ratio"
              decimals={2}
              placeholder="no limit"
              value={limits.maxFloorAreaRatio}
              onCommit={(v) => onChange(setSiteLimits(project, { maxFloorAreaRatio: v }))}
            />
          </div>

          {edge !== null && (
            <>
              <h3>
                Edge {edge + 1} · {dist(boundary[edge], boundary[(edge + 1) % boundary.length]).toFixed(2)} m long
              </h3>
              <LengthField
                label="Setback"
                value={setbacks[edge] ?? 0}
                min={0}
                onCommit={(v) => onChange(setSetback(project, edge, v))}
              />
              <div className="button-row">
                <button
                  title="Give every edge of the plot this setback"
                  onClick={() => {
                    let next = project;
                    boundary.forEach((_, i) => (next = setSetback(next, i, setbacks[edge] ?? 0)));
                    onChange(next);
                  }}
                >
                  Use for all edges
                </button>
                <button
                  title="Add a corner in the middle of this edge"
                  onClick={() => {
                    onChange(insertBoundaryCorner(project, edge));
                    props.onSelect({ kind: "siteCorner", index: edge + 1 });
                  }}
                >
                  Add corner
                </button>
              </div>
            </>
          )}

          {corner !== null && (
            <>
              <h3>Corner {corner + 1}</h3>
              <div className="field-grid">
                <LengthField
                  label="x"
                  value={boundary[corner].x}
                  onCommit={(v) => onChange(moveBoundaryCorner(project, corner, { ...boundary[corner], x: v }))}
                />
                <LengthField
                  label="y"
                  value={boundary[corner].y}
                  onCommit={(v) => onChange(moveBoundaryCorner(project, corner, { ...boundary[corner], y: v }))}
                />
              </div>
              <div className="button-row">
                <button
                  disabled={deleteBoundaryCorner(project, corner) === project}
                  title="Remove this corner; its two edges become one"
                  onClick={() => {
                    onChange(deleteBoundaryCorner(project, corner));
                    props.onSelect(null);
                  }}
                >
                  Delete corner
                </button>
              </div>
            </>
          )}

          {edge === null && corner === null && (
            <p className="hint">
              {props.siteToolActive
                ? "Click an edge to set its setback, or a corner to type its position. Drag a corner to reshape the plot; drag the building to move it."
                : "Choose the Site tool to change the plot, its setbacks or the position of the building."}
            </p>
          )}

          <h3>Position of the building</h3>
          <MoveBuildingForm onMove={(delta) => onChange(moveBuilding(project, props.buildingId, delta))} />

          <div className="button-row site-delete">
            <button
              onClick={() => {
                if (!window.confirm("Delete the plot outline and its setbacks? Undo brings them back.")) return;
                onChange(clearBoundary(project));
                props.onSelect(null);
              }}
            >
              Delete plot
            </button>
          </div>
        </>
      )}

      <p className="hint">
        Dashed green line: the buildable area, the plot less the setback of each edge. Dotted
        outline: the building footprint to the outside wall faces,{" "}
        {props.rules.footprint === "allStoreys" ? "all storeys seen from above" : "lowest storey only"}.
        Coverage: footprint ÷ plot area. Floor area ratio: gross floor area of all storeys ÷ plot
        area.
      </p>
      <p className="hint hint--warn">
        Setbacks and limits come from the planning conditions of the plot. The starting values and
        the footprint definition are placeholders — to be verified by a licensed engineer
        (src/config/siteRules.json).
      </p>
    </section>
  );
}
