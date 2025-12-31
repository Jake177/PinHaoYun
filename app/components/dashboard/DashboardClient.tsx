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
  const [filterYear, setFilterYear] = useState("");
  const [filterMonth, setFilterMonth] = useState(""); // 01-12
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

  useEffect(() => {
    const date =
      filterYear && filterMonth
        ? `${filterYear}-${filterMonth}`
        : filterYear
          ? filterYear
          : undefined;
    fetchVideos(date);
  }, [filterYear, filterMonth]);

  const yearOptions = useMemo(() => {
    const years = new Set<string>();
    videos.forEach((v) => {
      const d = v.captureTime || v.createdAt;
      if (!d) return;
      const t = Date.parse(d);
      if (!Number.isNaN(t)) {
        years.add(String(new Date(t).getFullYear()));
      }
    });
    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }, [videos]);

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
          <select
            className="input"
            style={{ maxWidth: 140 }}
            value={filterYear}
            onChange={(e) => {
              setFilterYear(e.target.value);
              setFilterMonth("");
            }}
            aria-label="按年份筛选"
          >
            <option value="">全部年份</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ maxWidth: 140 }}
            value={filterMonth}
            onChange={(e) => setFilterMonth(e.target.value)}
            aria-label="按月份筛选"
            disabled={!filterYear}
          >
            <option value="">全部月份</option>
            {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map(
              (m) => (
                <option key={m} value={m}>
                  {Number(m)}月
                </option>
              ),
            )}
          </select>
          <button
            type="button"
            className="icon-button"
            onClick={() =>
              fetchVideos(
                filterYear
                  ? filterMonth
                    ? `${filterYear}-${filterMonth}`
                    : filterYear
                  : undefined,
              )
            }
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
