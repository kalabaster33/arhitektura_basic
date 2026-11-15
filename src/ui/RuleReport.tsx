/**
 * How a proposed apartment layout fares against the room size, adjacency and
 * circulation rules (src/config/layoutRules.json): a count in the preview bar
 * that opens to the full list.
 */
import type { RuleCheck } from "../roomSubdivision.ts";

const GROUPS: { key: RuleCheck["group"]; title: string }[] = [
  { key: "size", title: "Room sizes" },
  { key: "adjacency", title: "Adjacency" },
  { key: "circulation", title: "Walking" },
];

export function RuleReport(props: { checks: RuleCheck[] }) {
  const { checks } = props;
  const met = checks.filter((c) => c.ok).length;
  const all = met === checks.length;
  return (
    <details className="rule-report">
      <summary className={all ? "" : "is-bad"}>
        Rules: {met} of {checks.length} met
      </summary>
      <div className="rule-report__body">
        {GROUPS.map(({ key, title }) => {
          const list = checks.filter((c) => c.group === key);
          if (list.length === 0) return null;
          return (
            <section key={key}>
              <h3>{title}</h3>
              <ul>
                {list.map((c, i) => (
                  <li key={i} className={c.ok ? "is-ok" : "is-bad"}>
                    <span aria-label={c.ok ? "met" : "not met"}>{c.ok ? "✓" : "✗"}</span>
                    <span>
                      {c.text}
                      {c.detail && <small> — {c.detail}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <p className="hint">
          Rules and sizes: src/config/layoutRules.json (placeholders, to be verified by a licensed
          engineer). Areas are measured to the partition centrelines.
        </p>
      </div>
    </details>
  );
}
