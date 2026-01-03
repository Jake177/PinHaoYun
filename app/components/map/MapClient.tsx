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
        <p>加载地图组件中...</p>
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
          ← 返回视频
        </Link>
        <h1>足迹地图</h1>
        <p className="muted">查看你的视频拍摄地点</p>
      </div>
      <div className="map-page__content">
        <FootprintMap onVideoSelect={handleVideoSelect} />
      </div>
    </div>
  );
}
