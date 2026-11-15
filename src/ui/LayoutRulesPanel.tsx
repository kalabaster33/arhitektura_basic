/**
 * Editor for the rules the layout generator works to: least size of each kind
 * of room, which rooms open into, lie near or keep away from which, and how
 * far it may be to walk. The edited rules are saved with the project; without
 * them the config (src/config/layoutRules.json) applies.
 */
import { useEffect, useState } from "react";
import { parseLayoutRules } from "../core/autoLayout.ts";
import type { LayoutRulesDoc } from "../core/model.ts";
import {
  ADJACENCY_KINDS,
  type AdjacencyKind,
  RULE_ROOMS,
  type RuleRoom,
  SIZED_ROOMS,
  type SizedRoom,
} from "../roomSubdivision.ts";

type Rule = LayoutRulesDoc["adjacency"][number];

const SIZE_LABEL: Record<SizedRoom, string> = {
  living: "Living room",
  mainBedroom: "Bedroom (first, double)",
  bedroom: "Bedroom (other)",
  kitchen: "Kitchen (separate)",
  bathroom: "Bathroom",
  wc: "WC",
  storage: "Storage",
  corridor: "Corridor",
};

const ROOM_LABEL: Record<RuleRoom, string> = {
  living: "Living room",
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  wc: "WC",
  storage: "Storage",
  corridor: "Corridor / hall",
  entrance: "Entrance door",
};

const VERB: Record<AdjacencyKind, string> = {
  opensTo: "opens into",
  notOpensTo: "does not open into",
  near: "is near",
  adjacent: "shares a wall with",
  apart: "shares no wall with",
};

/** Rooms that have a door of their own, and so can have a door rule. */
const WITH_DOOR: RuleRoom[] = ["bedroom", "kitchen", "bathroom", "wc", "storage"];

/** "Bathroom does not open into living room" */
function autoText(r: Pick<Rule, "a" | "b" | "rule">): string {
  const a = ROOM_LABEL[r.a as RuleRoom] ?? r.a;
  const b = (ROOM_LABEL[r.b as RuleRoom] ?? r.b).toLowerCase();
  return `${a} ${VERB[r.rule as AdjacencyKind] ?? r.rule} ${b === "entrance door" ? "the entrance" : b}`;
}

const WALK_FIELDS: { key: string; label: string; unit: string; scale?: number; step: number; title: string }[] = [
  { key: "maxWalk", label: "Longest walk to a room", unit: "m", step: 0.5, title: "From the entrance door to a room's door" },
  { key: "nearDistance", label: "Counts as near within", unit: "m", step: 0.5, title: "For the 'is near' rules" },
  { key: "maxCorridorShare", label: "Corridors at most", unit: "%", scale: 100, step: 1, title: "Share of the apartment" },
  { key: "walkWeight", label: "Weight of short walks", unit: "", step: 0.25, title: "0 ignores walking distance" },
  { key: "nightZone", label: "Weight of night zone", unit: "", step: 0.25, title: "Bedrooms away from the entrance; 0 ignores it" },
];

function Num(props: {
  value: number;
  step: number;
  label: string;
  onChange: (v: number) => void;
  title?: string;
}) {
  return (
    <input
      type="number"
      step={props.step}
      min={0}
      value={Number.isFinite(props.value) ? props.value : ""}
      aria-label={props.label}
      title={props.title}
      onChange={(e) => props.onChange(e.target.value === "" ? NaN : Number(e.target.value))}
    />
  );
}

export function LayoutRulesPanel(props: {
  /** The rules in force: the project's own, or the config's. */
  doc: LayoutRulesDoc;
  /** The project has rules of its own. */
  own: boolean;
  /** Why the project's own rules could not be used, if so. */
  error?: string;
  /** The config file's whole content, to check edits against. */
  config: unknown;
  /** New rules for the project; null goes back to the config's. */
  onChange: (doc: LayoutRulesDoc | null) => void;
}) {
  const [draft, setDraft] = useState(props.doc);
  const [problem, setProblem] = useState<string | null>(null);
  const incoming = JSON.stringify(props.doc);
  // Undo, a reset or another project replace what is being edited.
  useEffect(() => {
    setDraft(JSON.parse(incoming));
    setProblem(null);
  }, [incoming]);

  const change = (next: LayoutRulesDoc) => {
    setDraft(next);
    try {
      parseLayoutRules({ ...(props.config as object), ...next });
      setProblem(null);
      props.onChange(next);
    } catch (e) {
      setProblem(e instanceof Error ? e.message.replace(/^Layout rules: /, "") : String(e));
    }
  };

  const setSize = (kind: SizedRoom, key: "minArea" | "minWidth", v: number) =>
    change({ ...draft, rooms: { ...draft.rooms, [kind]: { ...draft.rooms[kind], [key]: v } } });

  const setRule = (i: number, patch: Partial<Rule>) => {
    const old = draft.adjacency[i];
    const next = { ...old, ...patch };
    // A text the user has not written themself follows the rule.
    if (("a" in patch || "b" in patch || "rule" in patch) && old.text === autoText(old)) next.text = autoText(next);
    if (next.hard === false) delete next.hard;
    change({ ...draft, adjacency: draft.adjacency.map((r, j) => (j === i ? next : r)) });
  };

  const addRule = () => {
    const rule: Rule = { a: "bedroom", b: "bathroom", rule: "near", weight: 1, text: "" };
    rule.text = autoText(rule);
    change({ ...draft, adjacency: [...draft.adjacency, rule] });
  };

  const setWalk = (key: string, v: number) => change({ ...draft, circulation: { ...draft.circulation, [key]: v } });

  return (
    <section className="panel rules">
      <h2>
        Layout rules <small>{props.own ? "this project" : "defaults"}</small>
      </h2>
      <p className="hint">
        What the room generator works to. Saved with the project; layouts generated from now on
        follow them, existing ones stay as they are.
      </p>
      {props.error && (
        <p className="hint is-bad">The project's own rules could not be used ({props.error}); the defaults apply.</p>
      )}

      <details className="rules__group">
        <summary>Room sizes</summary>
        <table className="rules__sizes">
          <thead>
            <tr>
              <th>Room</th>
              <th title="Least net area">min m²</th>
              <th title="Least clear width">min width m</th>
            </tr>
          </thead>
          <tbody>
            {SIZED_ROOMS.map((kind) => {
              const size = draft.rooms[kind] ?? { minArea: NaN, minWidth: NaN };
              return (
                <tr key={kind}>
                  <td>{SIZE_LABEL[kind]}</td>
                  <td>
                    {kind === "corridor" ? (
                      <span className="hint">—</span>
                    ) : (
                      <Num value={size.minArea} step={0.5} label={`${SIZE_LABEL[kind]} least area`} onChange={(v) => setSize(kind, "minArea", v)} />
                    )}
                  </td>
                  <td>
                    <Num value={size.minWidth} step={0.05} label={`${SIZE_LABEL[kind]} least width`} onChange={(v) => setSize(kind, "minWidth", v)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>

      <details className="rules__group">
        <summary>Adjacency ({draft.adjacency.length})</summary>
        <ul className="rules__list">
          {draft.adjacency.map((r, i) => {
            const doorRule = r.rule === "opensTo" || r.rule === "notOpensTo";
            return (
              <li key={i}>
                <div className="rules__line">
                  <select value={r.a} aria-label="Room" onChange={(e) => setRule(i, { a: e.target.value })}>
                    {RULE_ROOMS.filter((k) => k !== "entrance" && (!doorRule || WITH_DOOR.includes(k))).map((k) => (
                      <option key={k} value={k}>
                        {ROOM_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  <select value={r.rule} aria-label="Relation" onChange={(e) => setRule(i, { rule: e.target.value })}>
                    {ADJACENCY_KINDS.map((k) => (
                      <option key={k} value={k} disabled={(k === "opensTo" || k === "notOpensTo") && !WITH_DOOR.includes(r.a as RuleRoom)}>
                        {VERB[k]}
                      </option>
                    ))}
                  </select>
                  <select value={r.b} aria-label="Other room" onChange={(e) => setRule(i, { b: e.target.value })}>
                    {RULE_ROOMS.map((k) => (
                      <option key={k} value={k}>
                        {ROOM_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  className="rules__text"
                  value={r.text}
                  aria-label="Rule as shown in the report"
                  onChange={(e) => setRule(i, { text: e.target.value })}
                />
                <div className="rules__line">
                  <label title="How much breaking it costs: 0.5 mild, 1 normal, 2-3 strong">
                    weight <Num value={r.weight} step={0.25} label="Weight" onChange={(v) => setRule(i, { weight: v })} />
                  </label>
                  <label className="check" title="Layouts that break it are never offered">
                    <input type="checkbox" checked={r.hard === true} onChange={(e) => setRule(i, { hard: e.target.checked })} />
                    must
                  </label>
                  <span className="spacer" />
                  <button
                    title="Remove this rule"
                    aria-label={`Remove rule ${r.text}`}
                    onClick={() => change({ ...draft, adjacency: draft.adjacency.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <button onClick={addRule}>Add rule</button>
      </details>

      <details className="rules__group">
        <summary>Walking</summary>
        {WALK_FIELDS.map((f) => {
          const raw = draft.circulation[f.key];
          const scale = f.scale ?? 1;
          return (
            <label key={f.key} className="field rules__walk" title={f.title}>
              <span>{f.label}</span>
              <span>
                <Num
                  value={Number.isFinite(raw) ? Math.round(raw * scale * 1000) / 1000 : NaN}
                  step={f.step}
                  label={f.label}
                  onChange={(v) => setWalk(f.key, v / scale)}
                />{" "}
                {f.unit}
              </span>
            </label>
          );
        })}
      </details>

      {problem && <p className="hint is-bad">Not applied yet: {problem}</p>}
      {props.own && (
        <button onClick={() => props.onChange(null)} title="Use the rules of src/config/layoutRules.json again">
          Back to the default rules
        </button>
      )}
      <p className="hint hint--warn">
        Defaults are placeholders — to be verified by a licensed engineer against the rules that
        apply to the project.
      </p>
    </section>
  );
}
