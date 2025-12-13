"use client";

import { useEffect, useMemo, useState } from "react";
import VideoUploader from "./VideoUploader";
import VideoGrid from "./VideoGrid";

type VideoItem = {
  id: string;
  originalName?: string;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  status?: string;
  createdAt?: string;
  size?: number;
};

type DashboardClientProps = {
  userId: string;
  username: string;
};

export default function DashboardClient({ userId, username }: DashboardClientProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);

  const greeting = useMemo(
    () => (username ? `欢迎，${username}` : "欢迎回来"),
    [username],
  );

  const fetchVideos = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/videos/list");
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error || "加载视频失败");
      }
      const data = (await resp.json()) as { videos?: VideoItem[] };
      setVideos(data.videos || []);
    } catch (err: any) {
      setError(err?.message || "加载视频失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVideos();
  }, []);

  return (
    <div className="dashboard-layout">
      <header className="dashboard-header">
        <div>
          <p className="auth-hero__eyebrow">PinHaoYun</p>
          <h1>{greeting}</h1>
          <p className="muted">
            上传你的原始视频（MOV/MP4/HEVC），我们会生成低清预览供在线播放，原视频用于下载。
          </p>
        </div>
        <VideoUploader onUploaded={fetchVideos} />
      </header>

      <section className="dashboard-panel">
        <div className="panel-heading">
          <h2>我的视频</h2>
          {loading ? <span className="pill">加载中...</span> : null}
          {error ? <span className="pill pill--error">{error}</span> : null}
        </div>
        <VideoGrid videos={videos} onRefresh={fetchVideos} />
      </section>
    </div>
  );
}
