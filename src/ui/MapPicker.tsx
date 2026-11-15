import { useEffect, useRef, useState } from "react";
import {
  type MapSettings,
  TILE_SIZE,
  formatLatLon,
  fromWorldPixel,
  parseLatLon,
  tileUrl,
  worldPixel,
} from "../core/geo.ts";
import type { GeoLocation } from "../core/model.ts";

interface SearchHit {
  name: string;
  place: GeoLocation;
}

/**
 * A map to point at the place of the plot. Drag to move, wheel to zoom, click
 * to drop the pin; the pin becomes the origin of the plan.
 */
export function MapPicker(props: {
  settings: MapSettings;
  /** The location the project has now, if any. */
  current: GeoLocation | null;
  onPick: (place: GeoLocation) => void;
  onClose: () => void;
}) {
  const { settings } = props;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [centre, setCentre] = useState<GeoLocation>(props.current ?? settings.defaultCentre);
  const [zoom, setZoom] = useState(props.current ? Math.min(18, settings.maxZoom) : settings.defaultZoom);
  const [pin, setPin] = useState<GeoLocation | null>(props.current);
  const [text, setText] = useState(props.current ? formatLatLon(props.current) : "");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; centre: GeoLocation; moved: boolean } | null>(null);

  useEffect(() => {
    const el = box.current!;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const c = worldPixel(centre, zoom);
  const left = c.x - size.w / 2;
  const top = c.y - size.h / 2;
  const toPlace = (clientX: number, clientY: number): GeoLocation => {
    const rect = box.current!.getBoundingClientRect();
    return fromWorldPixel({ x: left + clientX - rect.left, y: top + clientY - rect.top }, zoom);
  };

  const zoomTo = (next: number, about?: { clientX: number; clientY: number }) => {
    const z = Math.max(2, Math.min(settings.maxZoom, next));
    if (z === zoom) return;
    if (!about) {
      setZoom(z);
      return;
    }
    // Keep the place under the pointer where it is.
    const rect = box.current!.getBoundingClientRect();
    const px = about.clientX - rect.left - size.w / 2;
    const py = about.clientY - rect.top - size.h / 2;
    const under = worldPixel(toPlace(about.clientX, about.clientY), z);
    setCentre(fromWorldPixel({ x: under.x - px, y: under.y - py }, z));
    setZoom(z);
  };

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  const live = useRef(zoomTo);
  live.current = zoomTo;
  useEffect(() => {
    const el = box.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      live.current(zoom + (e.deltaY < 0 ? 1 : -1), e);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  const place = (p: GeoLocation, recentre: boolean) => {
    setPin(p);
    setText(formatLatLon(p));
    if (recentre) {
      setCentre(p);
      setZoom((z) => Math.max(z, Math.min(17, settings.maxZoom)));
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q || !settings.searchUrl) return;
    const typed = parseLatLon(q);
    if (typed) {
      place(typed, true);
      setHits(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const response = await fetch(settings.searchUrl + encodeURIComponent(q), {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`the search answered ${response.status}`);
      const rows: any[] = await response.json();
      const found = rows
        .map((r) => ({ name: String(r.display_name ?? ""), place: { lat: Number(r.lat), lon: Number(r.lon) } }))
        .filter((h) => Number.isFinite(h.place.lat) && Number.isFinite(h.place.lon));
      setHits(found);
      if (found.length === 1) place(found[0].place, true);
    } catch (e) {
      setHits(null);
      setSearchError(`The search did not work (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setSearching(false);
    }
  };

  const tiles: { key: string; url: string; x: number; y: number }[] = [];
  if (size.w > 0) {
    const count = 2 ** zoom;
    for (let ty = Math.max(0, Math.floor(top / TILE_SIZE)); ty <= Math.min(count - 1, Math.floor((top + size.h) / TILE_SIZE)); ty++) {
      for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((left + size.w) / TILE_SIZE); tx++) {
        tiles.push({
          key: `${zoom}/${tx}/${ty}`,
          url: tileUrl(settings.tileUrl, zoom, ((tx % count) + count) % count, ty),
          x: Math.round(tx * TILE_SIZE - left),
          y: Math.round(ty * TILE_SIZE - top),
        });
      }
    }
  }
  const pinAt = pin && worldPixel(pin, zoom);
  const typed = parseLatLon(text);

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="dialog dialog--map" role="dialog" aria-modal="true" aria-label="Location of the plot">
        <h2>Location of the plot</h2>
        {settings.searchUrl && (
          <form
            className="map-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input
              value={query}
              placeholder="Search a place or an address, or paste latitude, longitude"
              aria-label="Search a place"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" disabled={searching || query.trim() === ""}>
              {searching ? "Searching…" : "Search"}
            </button>
          </form>
        )}
        {searchError && <p className="hint hint--warn">{searchError}</p>}
        {hits && hits.length === 0 && <p className="hint">Nothing found for that. Try the town or the street name.</p>}
        {hits && hits.length > 1 && (
          <ul className="map-hits">
            {hits.map((h, i) => (
              <li key={i}>
                <button onClick={() => place(h.place, true)}>{h.name}</button>
              </li>
            ))}
          </ul>
        )}
        <div
          ref={box}
          className="map"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, centre, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            if (!d.moved) return;
            const from = worldPixel(d.centre, zoom);
            setCentre(fromWorldPixel({ x: from.x - dx, y: from.y - dy }, zoom));
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && !d.moved) place(toPlace(e.clientX, e.clientY), false);
          }}
        >
          {tiles.map((t) => (
            <img key={t.key} src={t.url} alt="" draggable={false} style={{ left: t.x, top: t.y }} />
          ))}
          {pinAt && (
            <span className="map__pin" style={{ left: pinAt.x - left, top: pinAt.y - top }} aria-label="Chosen place" />
          )}
          <div className="map__zoom" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => zoomTo(zoom + 1)} disabled={zoom >= settings.maxZoom} aria-label="Zoom in">
              +
            </button>
            <button onClick={() => zoomTo(zoom - 1)} disabled={zoom <= 2} aria-label="Zoom out">
              −
            </button>
          </div>
          <span className="map__credit">{settings.attribution}</span>
        </div>
        <label className="field">
          <span>Latitude, longitude of the pin</span>
          <input
            value={text}
            placeholder="click the map, or type 41.996500, 21.431400"
            className={text.trim() !== "" && !typed ? "is-invalid" : ""}
            onChange={(e) => {
              setText(e.target.value);
              const p = parseLatLon(e.target.value);
              if (p) {
                setPin(p);
                setCentre(p);
              }
            }}
          />
        </label>
        <p className="hint">
          Click the map to drop the pin on a corner of the plot or another point you can find again.
          The pin becomes the origin of the plan (x 0, y 0) and the map is shown under the plan, so
          the plot can be traced over it. The map is a guide, not a survey: take the plot corners
          from the cadastral record.
        </p>
        <div className="dialog__actions">
          <button onClick={props.onClose}>Cancel</button>
          <button className="is-active" disabled={!pin} onClick={() => pin && props.onPick(pin)}>
            Use this place
          </button>
        </div>
      </div>
    </div>
  );
}
