"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

type VideoLocation = {
  id: string;
  lat: number;
  lon: number;
  thumbnailUrl: string | null;
  originalName?: string;
  captureTime?: string;
};

type GeoJsonData = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: {
      type: "Point";
      coordinates: [number, number];
    };
    properties: {
      id: string;
      thumbnailUrl: string | null;
      originalName?: string;
      captureTime?: string;
    };
  }>;
};

type FootprintMapProps = {
  onVideoSelect?: (videoIds: string[]) => void;
};

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

export default function FootprintMap({ onVideoSelect }: FootprintMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  const initializeMap = useCallback((geojson: GeoJsonData) => {
    if (!mapContainer.current || mapRef.current) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [116.4, 39.9], // Default to Beijing
      zoom: 2,
    });

    mapRef.current = map;

    map.on("load", () => {
      // Add source with clustering
      map.addSource("videos", {
        type: "geojson",
        data: geojson,
        cluster: true,
        clusterMaxZoom: 15,
        clusterRadius: 60,
      });

      // Cluster circles layer
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "videos",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step",
            ["get", "point_count"],
            "#3b82f6", // Blue for small clusters
            10,
            "#8b5cf6", // Purple for medium
            50,
            "#ec4899", // Pink for large
          ],
          "circle-radius": [
            "step",
            ["get", "point_count"],
            20, // Small cluster
            10,
            30, // Medium cluster
            50,
            40, // Large cluster
          ],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
        },
      });

      // Cluster count label
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "videos",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
          "text-size": 14,
        },
        paint: {
          "text-color": "#ffffff",
        },
      });

      // Individual video markers (unclustered)
      map.addLayer({
        id: "unclustered-point",
        type: "circle",
        source: "videos",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#2563eb",
          "circle-radius": 10,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#fff",
        },
      });

      // Click on cluster to zoom in
      map.on("click", "clusters", (e: any) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ["clusters"],
        });
        if (!features.length) return;

        const clusterId = features[0].properties?.cluster_id;
        const source = map.getSource("videos") as mapboxgl.GeoJSONSource;
        const geometry = features[0].geometry;

        if (geometry.type !== "Point") return;

        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err || zoom == null) {
            console.error("Error expanding cluster:", err);
            return;
          }
          map.easeTo({
            center: geometry.coordinates as [number, number],
            zoom,
          });
        });
      });

      // Click on individual video
      map.on("click", "unclustered-point", (e: any) => {
        const features = e.features;
        if (!features?.length) return;

        const videoId = features[0].properties?.id;
        if (videoId && onVideoSelect) {
          onVideoSelect([videoId]);
        }

        // Show popup with thumbnail
        const geometry = features[0].geometry;
        if (geometry.type === "Point") {
          const coordinates = geometry.coordinates.slice() as [number, number];
          const props = features[0].properties;

          const popupContent = `
            <div class="map-popup">
              ${props?.thumbnailUrl ? `<img src="${props.thumbnailUrl}" alt="${props?.originalName || 'Video'}" />` : ""}
              <div class="map-popup__info">
                <p class="map-popup__name">${props?.originalName || "Untitled video"}</p>
                ${props?.captureTime ? `<p class="map-popup__time">${new Date(props.captureTime).toLocaleDateString("en-GB")}</p>` : ""}
              </div>
            </div>
          `;

          new mapboxgl.Popup()
            .setLngLat(coordinates)
            .setHTML(popupContent)
            .addTo(map);
        }
      });

      // Change cursor on hover
      map.on("mouseenter", "clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "clusters", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("mouseenter", "unclustered-point", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "unclustered-point", () => {
        map.getCanvas().style.cursor = "";
      });

      // Fit bounds to show all points
      if (geojson.features.length > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        geojson.features.forEach((feature) => {
          bounds.extend(feature.geometry.coordinates as [number, number]);
        });
        map.fitBounds(bounds, { padding: 50, maxZoom: 12 });
      }
    });

    // Add navigation controls
    map.addControl(new mapboxgl.NavigationControl(), "top-right");
  }, [onVideoSelect]);

  useEffect(() => {
    const fetchLocations = async () => {
      try {
        const resp = await fetch("/api/videos/locations");
        if (!resp.ok) {
          throw new Error("Failed to fetch location data.");
        }
        const data = await resp.json();
        setTotalCount(data.totalCount || 0);
        initializeMap(data.geojson);
      } catch (err: any) {
        setError(err?.message || "Failed to load.");
      } finally {
        setLoading(false);
      }
    };

    fetchLocations();

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [initializeMap]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="map-error">
        <p>Map configuration error: missing Mapbox token.</p>
      </div>
    );
  }

  return (
    <div className="footprint-map">
      {loading && (
        <div className="map-loading">
          <p>Loading map...</p>
        </div>
      )}
      {error && (
        <div className="map-error">
          <p>{error}</p>
        </div>
      )}
      {!loading && !error && totalCount === 0 && (
        <div className="map-empty">
          <p>No videos with location data yet.</p>
          <p className="muted">Upload a video with GPS metadata and it will appear on the map.</p>
        </div>
      )}
      <div
        ref={mapContainer}
        className="map-container"
        style={{ opacity: loading || error || totalCount === 0 ? 0 : 1 }}
      />
      {!loading && totalCount > 0 && (
        <div className="map-stats">
          <span className="pill">{totalCount} locations</span>
        </div>
      )}
    </div>
  );
}
