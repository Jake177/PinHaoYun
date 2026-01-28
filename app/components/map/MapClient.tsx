"use client";

import Link from "next/link";
import dynamic from "next/dynamic";

// Dynamic import to avoid SSR issues with Mapbox
const FootprintMap = dynamic(
  () => import("@/app/components/map/FootprintMap"),
  {
    ssr: false,
    loading: () => (
      <div className="map-loading">
        <p>Loading the map...</p>
      </div>
    ),
  }
);

export default function MapClient() {
  const handleVideoSelect = (videoIds: string[]) => {
    console.log("Selected videos:", videoIds);
    // TODO: Open video preview modal or navigate to video
  };

  return (
    <div className="map-page">
      <div className="map-page__header">
        <Link href="/dashboard" className="back-link">
          ← Back to videos
        </Link>
        <h1>Footprint map</h1>
        <p className="muted">See where your videos were captured</p>
      </div>
      <div className="map-page__content">
        <FootprintMap onVideoSelect={handleVideoSelect} />
      </div>
    </div>
  );
}
