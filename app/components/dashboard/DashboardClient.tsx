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
  const [filter, setFilter] = useState(""); // YYYY 或 YYYY-MM
  const [videos, setVideos] = useState<VideoItem[]>([]);

  const greeting = useMemo(
    () => (username ? `欢迎，${username}` : "欢迎回来"),
    [username],
  );

  const fetchVideos = async (date?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      const resp = await fetch(`/api/videos/list${query}`);
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
            上传你的原始视频。
          </p>
        </div>
        <VideoUploader onUploaded={fetchVideos} />
      </header>

      <section className="dashboard-panel">
        <div className="panel-heading">
        <div className="panel-title">
          <h2>我的视频</h2>
          <input
            type="month"
            value={filter.length === 7 ? filter : ""}
            onChange={(e) => setFilter(e.target.value || "")}
            className="input"
            aria-label="按年月筛选"
            placeholder="按年月筛选"
            style={{ maxWidth: 160 }}
          />
          <input
            type="number"
            min="2000"
            max="2100"
            placeholder="按年份筛选"
            value={filter.length === 4 ? filter : ""}
            onChange={(e) => setFilter(e.target.value)}
            className="input"
            aria-label="按年份筛选"
            style={{ maxWidth: 120 }}
          />
          <button
            type="button"
            className="icon-button"
            onClick={() => fetchVideos(filter)}
            disabled={loading}
            aria-label="刷新视频列表"
            title="刷新"
          >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M20 12a8 8 0 1 1-2.34-5.66"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M20 4v6h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          <div className="panel-status">
            {loading ? <span className="pill">加载中...</span> : null}
            {error ? <span className="pill pill--error">{error}</span> : null}
          </div>
        </div>
        <VideoGrid videos={videos} onRefresh={fetchVideos} />
      </section>
    </div>
  );
}
