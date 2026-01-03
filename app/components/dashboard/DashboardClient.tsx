"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VideoUploader from "./VideoUploader";
import VideoGrid from "./VideoGrid";
import StorageRing from "../profile/StorageRing";

type VideoItem = {
  id: string;
  originalName?: string;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  status?: string;
  createdAt?: string;
  captureTime?: string;
  size?: number;
};

type DashboardClientProps = {
  userId: string;
  username: string;
};

const PAGE_SIZE = 20;

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
};

export default function DashboardClient({ userId, username }: DashboardClientProps) {
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterYear, setFilterYear] = useState("");
  const [filterMonth, setFilterMonth] = useState(""); // 01-12
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [profileStats, setProfileStats] = useState<{
    usedBytes: number;
    quotaBytes: number;
    videosCount: number;
  } | null>(null);

  const greeting = useMemo(
    () => (username ? `欢迎，${username}` : "欢迎回来"),
    [username],
  );

  const buildDateQuery = useCallback(() => {
    if (filterYear && filterMonth) return `${filterYear}-${filterMonth}`;
    if (filterYear) return filterYear;
    return undefined;
  }, [filterYear, filterMonth]);

  const fetchVideos = useCallback(async (reset = true) => {
    if (reset) {
      setLoading(true);
      setNextCursor(null);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));

      const date = buildDateQuery();
      if (date) params.set("date", date);
      if (!reset && nextCursor) params.set("cursor", nextCursor);

      const resp = await fetch(`/api/videos/list?${params.toString()}`);
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error || "加载视频失败");
      }

      const data = (await resp.json()) as {
        videos?: VideoItem[];
        nextCursor?: string | null;
        hasMore?: boolean;
      };

      if (reset) {
        setVideos(data.videos || []);
      } else {
        setVideos((prev) => [...prev, ...(data.videos || [])]);
      }
      setNextCursor(data.nextCursor || null);
      setHasMore(data.hasMore ?? false);
    } catch (err: any) {
      setError(err?.message || "加载视频失败");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [buildDateQuery, nextCursor]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchVideos(false);
    }
  }, [fetchVideos, loadingMore, hasMore]);

  // 初次加载 + 筛选条件变化时重新获取
  useEffect(() => {
    fetchVideos(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterYear, filterMonth]);

  // 获取用户存储统计
  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const resp = await fetch("/api/user/profile");
        if (resp.ok) {
          const data = await resp.json();
          setProfileStats({
            usedBytes: data.usedBytes || 0,
            quotaBytes: data.quotaBytes || 256 * 1024 * 1024 * 1024,
            videosCount: data.videosCount || 0,
          });
        }
      } catch {
        // ignore
      }
    };
    fetchProfile();
  }, []);

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
        <div className="dashboard-header__top">
          <div className="dashboard-header__greeting">
            <p className="auth-hero__eyebrow">PinHaoYun</p>
            <h1>{greeting}</h1>
          </div>
          <VideoUploader onUploaded={fetchVideos} />
        </div>
        {profileStats && (
          <div className="dashboard-stats">
            <div className="dashboard-stats__item">
              <StorageRing
                usedBytes={profileStats.usedBytes}
                quotaBytes={profileStats.quotaBytes}
                size={48}
                strokeWidth={5}
              />
              <div className="dashboard-stats__text">
                <span className="dashboard-stats__label">存储空间</span>
                <span className="dashboard-stats__value">
                  {formatBytes(profileStats.usedBytes)} / {formatBytes(profileStats.quotaBytes)}
                </span>
              </div>
            </div>
            <div className="dashboard-stats__divider" />
            <div className="dashboard-stats__item">
              <span className="dashboard-stats__icon">🎬</span>
              <div className="dashboard-stats__text">
                <span className="dashboard-stats__label">视频数量</span>
                <span className="dashboard-stats__value">{profileStats.videosCount} 个</span>
              </div>
            </div>
          </div>
        )}
      </header>

      <section className="dashboard-panel">
        <div className="panel-heading">
        <div className="panel-title">
          <h2>我的视频</h2>
          <select
            className="input"
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
            onClick={() => fetchVideos(true)}
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
            {loadingMore ? <span className="pill">加载更多...</span> : null}
            {error ? <span className="pill pill--error">{error}</span> : null}
          </div>
        </div>
        <VideoGrid
          videos={videos}
          onRefresh={() => fetchVideos(true)}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
        />
      </section>
    </div>
  );
}
