"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

type GeoResult = {
  label: string;
  address: string;
  lat: number;
  lon: number;
  city?: string;
  region?: string;
  country?: string;
};

type LocationDraft = {
  lat: number;
  lon: number;
  address: string;
  city?: string;
  region?: string;
  country?: string;
};

type LocationEditorModalProps = {
  initialLat?: number;
  initialLon?: number;
  initialAddress?: string;
  onClose: () => void;
  onSave: (draft: LocationDraft) => Promise<void>;
  saving?: boolean;
  error?: string | null;
};

const DEFAULT_CENTER: [number, number] = [116.4, 39.9];

export default function LocationEditorModal({
  initialLat,
  initialLon,
  initialAddress,
  onClose,
  onSave,
  saving = false,
  error = null,
}: LocationEditorModalProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [draft, setDraft] = useState<LocationDraft>(() => ({
    lat: initialLat ?? DEFAULT_CENTER[1],
    lon: initialLon ?? DEFAULT_CENTER[0],
    address: initialAddress || "",
  }));

  const hasToken = useMemo(
    () => Boolean(process.env.NEXT_PUBLIC_MAPBOX_TOKEN),
    [],
  );

  const updateDraft = (next: Partial<LocationDraft>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  };

  const syncMarker = (lat: number, lon: number, zoom = 12) => {
    if (!mapRef.current || !markerRef.current) return;
    markerRef.current.setLngLat([lon, lat]);
    mapRef.current.easeTo({ center: [lon, lat], zoom });
  };

  const fetchReverse = async (lat: number, lon: number) => {
    try {
      setLocalError(null);
      const resp = await fetch(`/api/geo/reverse?lat=${lat}&lon=${lon}`);
      if (!resp.ok) {
        return;
      }
      const data = (await resp.json()) as {
        address?: string;
        city?: string;
        region?: string;
        country?: string;
      };
      updateDraft({
        address: data.address || "",
        city: data.city,
        region: data.region,
        country: data.country,
      });
    } catch {
      // ignore reverse errors
    }
  };

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearching(true);
    setLocalError(null);
    try {
      const resp = await fetch(`/api/geo/search?query=${encodeURIComponent(trimmed)}`);
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "搜索失败");
      }
      const data = (await resp.json()) as { results?: GeoResult[] };
      setResults(data.results || []);
    } catch (err: any) {
      setLocalError(err?.message || "搜索失败");
    } finally {
      setSearching(false);
    }
  };

  const handleSelect = (result: GeoResult) => {
    setLocalError(null);
    updateDraft({
      lat: result.lat,
      lon: result.lon,
      address: result.address,
      city: result.city,
      region: result.region,
      country: result.country,
    });
    syncMarker(result.lat, result.lon);
    setResults([]);
  };

  const handleSave = () => {
    if (!draft.address.trim()) {
      setLocalError("请先搜索或在地图上选择位置");
      return;
    }
    onSave(draft);
  };

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    if (!hasToken) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [draft.lon, draft.lat],
      zoom: initialLat && initialLon ? 12 : 3,
    });
    mapRef.current = map;

    const marker = new mapboxgl.Marker({ draggable: true })
      .setLngLat([draft.lon, draft.lat])
      .addTo(map);
    markerRef.current = marker;

    marker.on("dragend", () => {
      const lngLat = marker.getLngLat();
      updateDraft({ lat: lngLat.lat, lon: lngLat.lng });
      fetchReverse(lngLat.lat, lngLat.lng);
    });

    map.on("click", (event) => {
      const { lngLat } = event;
      marker.setLngLat([lngLat.lng, lngLat.lat]);
      updateDraft({ lat: lngLat.lat, lon: lngLat.lng });
      fetchReverse(lngLat.lat, lngLat.lng);
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [draft.lat, draft.lon, hasToken, initialLat, initialLon]);

  return (
    <div className="location-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="location-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="location-dialog__header">
          <h3>编辑位置</h3>
          <button type="button" className="pill" onClick={onClose}>
            关闭
          </button>
        </header>
        {!hasToken ? (
          <p className="pill pill--error">缺少 Mapbox Token</p>
        ) : (
          <div className="location-dialog__body">
            <div className="location-search">
              <input
                className="input"
                placeholder="搜索地址或城市"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
              />
              <button
                type="button"
                className="pill pill--primary"
                onClick={handleSearch}
                disabled={searching}
              >
                {searching ? "搜索中..." : "搜索"}
              </button>
            </div>
            {results.length > 0 && (
              <div className="location-results">
                {results.map((result) => (
                  <button
                    key={`${result.lat}-${result.lon}-${result.label}`}
                    type="button"
                    className="location-result"
                    onClick={() => handleSelect(result)}
                  >
                    {result.label}
                  </button>
                ))}
              </div>
            )}
            <div className="location-map" ref={mapContainer} />
            <div className="location-fields">
              <label className="location-field">
                地址
                <input
                  className="input"
                  value={draft.address}
                  readOnly
                />
              </label>
              <div className="location-meta">
                <span>经度：{draft.lon.toFixed(5)}</span>
                <span>纬度：{draft.lat.toFixed(5)}</span>
              </div>
            </div>
          </div>
        )}
        {(localError || error) && (
          <p className="pill pill--error">{localError || error}</p>
        )}
        <div className="location-dialog__actions">
          <button type="button" className="pill" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="pill pill--error"
            onClick={handleSave}
            disabled={saving || !draft.address.trim()}
          >
            {saving ? "保存中..." : "保存位置"}
          </button>
        </div>
      </div>
    </div>
  );
}
