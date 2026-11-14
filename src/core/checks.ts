/**
 * Plan checks on one storey: apartments without an entrance, rooms without a
 * door, and rooms that need daylight but have no window in an exterior wall.
 * Which room types each rule covers comes from a config
 * (src/config/roomChecks.json), not from this code.
 */
import { describeApartments } from "./apartments.ts";
import { type Building, type SpaceType, type Storey, SPACE_TYPES } from "./model.ts";
import { openingSides } from "./openings.ts";
import { linkSpaces } from "./spaces.ts";

export interface RoomCheckConfig {
  daylightSpaceTypes: SpaceType[];
  doorExemptSpaceTypes: SpaceType[];
}

export function parseRoomCheckConfig(raw: unknown): RoomCheckConfig {
  const c = raw as RoomCheckConfig;
  const list = (key: "daylightSpaceTypes" | "doorExemptSpaceTypes"): SpaceType[] => {
    const value = c?.[key];
    if (!Array.isArray(value)) throw new Error(`Room checks: invalid or missing "${key}".`);
    for (const t of value) {
      if (!SPACE_TYPES.includes(t)) throw new Error(`Room checks: unknown space type "${t}".`);
    }
    return [...value];
  };
  return {
    daylightSpaceTypes: list("daylightSpaceTypes"),
    doorExemptSpaceTypes: list("doorExemptSpaceTypes"),
  };
}

export interface PlanIssue {
  kind: "apartmentNoEntrance" | "roomNoDoor" | "roomNoDaylight";
  storeyId: string;
  /** The room the warning is about, for the two room rules. */
  spaceId?: string;
  /** The apartment the warning is about, for the entrance rule. */
  apartmentId?: string;
  message: string;
}

export function checkStoreyPlan(storey: Storey, config: RoomCheckConfig): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const linked = linkSpaces(storey);

  for (const info of describeApartments(storey, linked)) {
    if (info.spaceIds.length === 0 || info.entrances.length > 0) continue;
    issues.push({
      kind: "apartmentNoEntrance",
      storeyId: storey.id,
      apartmentId: info.apartmentId,
      spaceId: info.spaceIds[0],
      message: `"${info.name}" on ${storey.name} has no entrance door.`,
    });
  }

  const hasDoor = new Set<string>();
  const hasDaylight = new Set<string>();
  const wallKind = new Map(storey.walls.map((w) => [w.id, w.kind]));
  for (const opening of storey.openings) {
    const [left, right] = openingSides(storey, opening, linked);
    if (left === right) continue; // a gap in a wall standing free inside one room
    const target =
      opening.kind === "door"
        ? hasDoor
        : wallKind.get(opening.wallId) === "exterior"
          ? hasDaylight
          : null;
    if (!target) continue;
    if (left) target.add(left);
    if (right) target.add(right);
  }

  for (const space of storey.spaces) {
    if (!linked.faceBySpaceId.has(space.id)) continue;
    if (!hasDoor.has(space.id) && !config.doorExemptSpaceTypes.includes(space.type)) {
      issues.push({
        kind: "roomNoDoor",
        storeyId: storey.id,
        spaceId: space.id,
        message: `"${space.name}" on ${storey.name} has no door.`,
      });
    }
    if (!hasDaylight.has(space.id) && config.daylightSpaceTypes.includes(space.type)) {
      issues.push({
        kind: "roomNoDaylight",
        storeyId: storey.id,
        spaceId: space.id,
        message: `${space.type} "${space.name}" on ${storey.name} has no window in an exterior wall.`,
      });
    }
  }
  return issues;
}

export function checkBuildingPlan(building: Building, config: RoomCheckConfig): PlanIssue[] {
  return building.storeys.flatMap((s) => checkStoreyPlan(s, config));
}
