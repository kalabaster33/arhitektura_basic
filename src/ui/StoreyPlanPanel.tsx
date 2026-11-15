/**
 * Storey generator panel: the wanted apartment mix (types, sizes, counts and
 * the rooms each type gets), how the apartments are reached, and the button
 * that divides the storey. Also the small room-programme editor used for a
 * single apartment.
 */
import type { ApartmentProgram } from "../core/model.ts";
import type { Access, UnitType } from "../core/storeySplit.ts";

const KITCHEN_LABEL: Record<ApartmentProgram["kitchen"], string> = {
  open: "open kitchen",
  separate: "separate kitchen",
  none: "no kitchen",
};

/** "2 bed · 1 bath · storage · open kitchen" */
export function describeProgram(p: ApartmentProgram): string {
  const parts = [p.bedrooms === 0 ? "studio" : `${p.bedrooms} bed`, `${p.bathrooms} bath`];
  if (p.wc > 0) parts.push(p.wc > 1 ? `${p.wc} WC` : "WC");
  if (p.storage > 0) parts.push(p.storage > 1 ? `${p.storage} storage` : "storage");
  parts.push(KITCHEN_LABEL[p.kitchen]);
  return parts.join(" · ");
}

function Count(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="program__count" title={props.label}>
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        aria-label={props.label}
        onChange={(e) => {
          const v = Math.round(Number(e.target.value));
          if (Number.isFinite(v)) props.onChange(Math.max(props.min, Math.min(props.max, v)));
        }}
      />
    </label>
  );
}

/** Rooms of one apartment or apartment type. */
export function ProgramEditor(props: { program: ApartmentProgram; onChange: (p: ApartmentProgram) => void }) {
  const { program: p, onChange } = props;
  const set = (patch: Partial<ApartmentProgram>) => onChange({ ...p, ...patch });
  return (
    <div className="program">
      <Count label="Bedrooms" value={p.bedrooms} min={0} max={5} onChange={(bedrooms) => set({ bedrooms })} />
      <Count label="Bathrooms" value={p.bathrooms} min={1} max={3} onChange={(bathrooms) => set({ bathrooms })} />
      <Count label="WC" value={p.wc} min={0} max={2} onChange={(wc) => set({ wc })} />
      <Count label="Storage" value={p.storage} min={0} max={2} onChange={(storage) => set({ storage })} />
      <label className="program__kitchen">
        <span>Kitchen</span>
        <select
          value={p.kitchen}
          aria-label="Kitchen"
          onChange={(e) => set({ kitchen: e.target.value as ApartmentProgram["kitchen"] })}
        >
          <option value="open">Open, in the living room</option>
          <option value="separate">Separate room</option>
          <option value="none">None</option>
        </select>
      </label>
    </div>
  );
}

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function StoreyPlanPanel(props: {
  storeyName: string;
  /** Floor left for apartments, to wall centrelines; null when there is no structure yet. */
  usable: number | null;
  mix: UnitType[];
  onMix: (mix: UnitType[]) => void;
  access: Access | "auto";
  onAccess: (a: Access | "auto") => void;
  /** Other storeys with the same outline the plan can be copied to. */
  similarCount: number;
  alsoSimilar: boolean;
  onAlsoSimilar: (v: boolean) => void;
  /** The storey already has apartments or walls of its own, which a new plan replaces. */
  hasOwnPlan: boolean;
  busy: boolean;
  error: string | null;
  disabled: boolean;
  onGenerate: () => void;
}) {
  const { mix, onMix } = props;
  const count = mix.reduce((s, u) => s + u.count, 0);
  const wanted = mix.reduce((s, u) => s + u.count * u.area, 0);
  const scale = props.usable && wanted > 0 ? props.usable / wanted : null;
  const update = (i: number, patch: Partial<UnitType>) => onMix(mix.map((u, j) => (j === i ? { ...u, ...patch } : u)));

  /** Scales the counts so the mix fills the floor, keeping its proportions. */
  const fitCounts = () => {
    if (!props.usable || wanted <= 0) return;
    const k = props.usable / wanted;
    const next = mix.map((u) => ({ ...u, count: u.count > 0 ? Math.max(1, Math.round(u.count * k)) : 0 }));
    // Then nudge one type up or down while that brings the total closer.
    for (let pass = 0; pass < 8; pass++) {
      const total = next.reduce((s, u) => s + u.count * u.area, 0);
      const gap = props.usable - total;
      let best = -1;
      let bestGap = Math.abs(gap);
      next.forEach((u, i) => {
        if (u.count === 0 && !mix[i].count) return;
        const step = gap > 0 ? 1 : -1;
        if (u.count + step < 0) return;
        const g = Math.abs(gap - step * u.area);
        if (g < bestGap) {
          bestGap = g;
          best = i;
        }
      });
      if (best < 0) break;
      next[best].count += gap > 0 ? 1 : -1;
    }
    onMix(next);
  };

  return (
    <section className="panel">
      <h2>
        Storey plan <small>{props.storeyName}</small>
      </h2>
      <p className="hint">
        Divides the floor around the hall, stairs and elevator into apartments of the sizes below,
        each with its entrance door from the hall or a corridor and a stretch of facade.
      </p>
      <ul className="mix">
        {mix.map((u, i) => (
          <li key={i}>
            <div className="mix__head">
              <input
                value={u.name}
                aria-label="Apartment type"
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <label className="mix__num" title="Wanted area, to wall centrelines">
                <input
                  type="number"
                  min={15}
                  step={1}
                  value={u.area}
                  aria-label={`${u.name} area`}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v > 0) update(i, { area: v });
                  }}
                />
                <em>m²</em>
              </label>
              <label className="mix__num" title="How many on this storey">
                <em>×</em>
                <input
                  type="number"
                  min={0}
                  max={16}
                  step={1}
                  value={u.count}
                  aria-label={`${u.name} count`}
                  onChange={(e) => {
                    const v = Math.round(Number(e.target.value));
                    if (v >= 0 && v <= 16) update(i, { count: v });
                  }}
                />
              </label>
              <button
                title="Remove this type"
                aria-label={`Remove ${u.name}`}
                onClick={() => onMix(mix.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
            <label className="check" title="Put these at the corners of the plan, where two facades meet">
              <input
                type="checkbox"
                checked={u.corner === true}
                onChange={(e) => update(i, { corner: e.target.checked || undefined })}
              />
              At the corners
            </label>
            <details className="mix__rooms">
              <summary>{describeProgram(u.program)}</summary>
              <ProgramEditor program={u.program} onChange={(program) => update(i, { program })} />
            </details>
          </li>
        ))}
      </ul>
      <div className="row">
        <button
          onClick={() =>
            onMix([
              ...mix,
              {
                name: `Type ${mix.length + 1}`,
                area: 55,
                count: 1,
                program: { bedrooms: 1, bathrooms: 1, wc: 0, storage: 0, kitchen: "open" },
              },
            ])
          }
        >
          Add type
        </button>
        <button disabled={!props.usable || wanted <= 0} onClick={fitCounts} title="Change the counts so the mix fills the floor">
          Fit counts to floor
        </button>
      </div>
      <p className="hint">
        {count} apartment{count === 1 ? "" : "s"} · {fmt(wanted)} m² wanted
        {props.usable !== null && <> · {fmt(props.usable)} m² of floor</>}
        {scale !== null && Math.abs(scale - 1) > 0.005 && (
          <span className={Math.abs(scale - 1) > 0.15 ? "is-bad" : ""}>
            {" "}
            · sizes {scale > 1 ? "grow" : "shrink"} by {Math.round(Math.abs(scale - 1) * 100)} % to use it all
          </span>
        )}
      </p>
      <label className="field">
        <span>Access</span>
        <select value={props.access} onChange={(e) => props.onAccess(e.target.value as Access | "auto")}>
          <option value="auto">Automatic: from the hall, a corridor if needed</option>
          <option value="hall">From the hall only</option>
          <option value="corridor">Along a corridor from the hall</option>
        </select>
      </label>
      {props.similarCount > 0 && (
        <label className="check">
          <input type="checkbox" checked={props.alsoSimilar} onChange={(e) => props.onAlsoSimilar(e.target.checked)} />
          Also apply to the {props.similarCount} other storey{props.similarCount > 1 ? "s" : ""} with this outline
        </label>
      )}
      <button className="is-active" disabled={props.disabled || props.busy || count === 0} onClick={props.onGenerate}>
        {props.busy ? "Working…" : "Generate storey plan"}
      </button>
      {props.error && <p className="hint is-bad">{props.error}</p>}
      {props.hasOwnPlan && (
        <p className="hint">A generated plan replaces the apartments and walls drawn on this storey.</p>
      )}
      <p className="hint hint--warn">
        Sizes and widths are placeholders — to be verified by a licensed engineer
        (src/config/storeySplit.json).
      </p>
    </section>
  );
}
