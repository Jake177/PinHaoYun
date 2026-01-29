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
  captureAddress?: string;
  captureCity?: string;
  captureRegion?: string;
  captureCountry?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  codec?: string;
  rotation?: number;
  captureAlt?: number;
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
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [profileStats, setProfileStats] = useState<{
    usedBytes: number;
    quotaBytes: number;
    videosCount: number;
  } | null>(null);

  const greeting = useMemo(
    () => (username ? `Welcome, ${username}` : "Welcome back"),
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
      nextCursorRef.current = null;
      setNextCursor(null);
    } else {
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    }
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));

      const date = buildDateQuery();
      if (date) params.set("date", date);
      if (!reset && nextCursorRef.current) {
        params.set("cursor", nextCursorRef.current);
      }

      const resp = await fetch(`/api/videos/list?${params.toString()}`);
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        throw new Error(data.error || "Failed to load videos.");
      }

      const data = (await resp.json()) as {
        videos?: VideoItem[];
        nextCursor?: string | null;
        hasMore?: boolean;
      };

      if (reset) {
        setVideos(data.videos || []);
      } else {
        setVideos((prev) => {
          const existing = new Set(prev.map((v) => v.id));
          const merged = [...prev];
          (data.videos || []).forEach((v) => {
            if (!existing.has(v.id)) {
              merged.push(v);
            }
          });
          return merged;
        });
      }
      const newCursor = data.nextCursor || null;
      nextCursorRef.current = newCursor;
      setNextCursor(newCursor);
      setHasMore(data.hasMore ?? false);
    } catch (err: any) {
      setError(err?.message || "Failed to load videos.");
    } finally {
      if (reset) {
        setLoading(false);
      } else {
        setLoadingMore(false);
        loadingMoreRef.current = false;
      }
    }
  }, [buildDateQuery]);

  const loadMore = useCallback(() => {
    if (!loadingMoreRef.current && hasMore) {
      fetchVideos(false);
    }
  }, [fetchVideos, hasMore]);

  // Initial load and refresh when filter changes.
  useEffect(() => {
    fetchVideos(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterYear, filterMonth]);


  const fetchProfile = useCallback(async () => {
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
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchVideos(true), fetchProfile()]);
  }, [fetchProfile, fetchVideos]);

  // Fetch user storage stats.
  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleDelete = useCallback(
    async (videoId: string) => {
      const resp = await fetch("/api/videos/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Delete failed.");
      }
      await fetchVideos(true);
      await fetchProfile();
    },
    [fetchProfile, fetchVideos],
  );

  const resetSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setShowBatchConfirm(false);
    setBatchError(null);
  }, []);

  const toggleSelection = useCallback((videoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
  }, []);

  const handleBatchDelete = useCallback(async () => {
    if (batchDeleting || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const previousVideos = videos;
    const previousStats = profileStats;
    const removedVideos = videos.filter((v) => selectedIds.has(v.id));
    const removedBytes = removedVideos.reduce((sum, v) => sum + (v.size || 0), 0);

    setBatchDeleting(true);
    setBatchError(null);
    setVideos((prev) => prev.filter((v) => !selectedIds.has(v.id)));
    if (profileStats) {
      setProfileStats({
        usedBytes: Math.max(0, profileStats.usedBytes - removedBytes),
        quotaBytes: profileStats.quotaBytes,
        videosCount: Math.max(0, profileStats.videosCount - removedVideos.length),
      });
    }

    try {
      const resp = await fetch("/api/videos/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoIds: ids }),
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Deletion failed");
      }
      resetSelection();
    } catch (err: any) {
      setVideos(previousVideos);
      if (previousStats) setProfileStats(previousStats);
      setBatchError(err?.message || "Deletion failed");
    } finally {
      setBatchDeleting(false);
    }
  }, [batchDeleting, profileStats, resetSelection, selectedIds, videos]);

  const handleUpdateLocation = useCallback(
    async (
      videoId: string,
      data: {
        lat: number;
        lon: number;
        address: string;
        city?: string;
        region?: string;
        country?: string;
      },
    ) => {
      const resp = await fetch("/api/videos/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, ...data }),
      });
      if (!resp.ok) {
        const err = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || "Failed to save location.");
      }
      await fetchVideos(true);
    },
    [fetchVideos],
  );

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
        </div>
        <div className="dashboard-header__actions">
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
                  <span className="dashboard-stats__label">Storage</span>
                  <span className="dashboard-stats__value">
                    {formatBytes(profileStats.usedBytes)} / {formatBytes(profileStats.quotaBytes)}
                  </span>
                </div>
              </div>
              <div className="dashboard-stats__divider" />
              <div className="dashboard-stats__item">
                <span className="material-symbols-outlined">
                  video_camera_front
                </span>
                <div className="dashboard-stats__text">
                  <span className="dashboard-stats__label">Videos</span>
                  <span className="dashboard-stats__value">{profileStats.videosCount}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      <section className="dashboard-panel">
          <div className="panel-heading">
          <div className="panel-title">
            <h2>My videos</h2>
            <div className="panel-filters">
              <select
                className="input"
                value={filterYear}
                onChange={(e) => {
                  setFilterYear(e.target.value);
                  setFilterMonth("");
                  resetSelection();
                }}
                aria-label="Filter by year"
              >
                <option value="">All years</option>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={filterMonth}
                onChange={(e) => {
                  setFilterMonth(e.target.value);
                  resetSelection();
                }}
                aria-label="Filter by month"
                disabled={!filterYear}
              >
                <option value="">All months</option>
                {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map(
                  (m) => (
                    <option key={m} value={m}>
                      {new Date(2000, Number(m) - 1, 1).toLocaleString("en-GB", { month: "long" })}
                    </option>
                  ),
                )}
              </select>
            </div>
          </div>
          <div className="panel-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                resetSelection();
                void refreshAll();
              }}
              disabled={loading}
              aria-label="Refresh video list"
              title="Refresh"
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
            {!selectionMode ? (
              <div className="panel-actions__swap panel-actions__default">
                <VideoUploader onUploaded={refreshAll} variant="inline" />
                <button
                  type="button"
                  className="pill"
                  onClick={() => {
                    setSelectionMode(true);
                    setSelectedIds(new Set());
                    setBatchError(null);
                    setShowBatchConfirm(false);
                  }}
                  disabled={videos.length === 0}
                >
                  Select
                </button>
              </div>
            ) : (
              <div className="panel-actions__swap panel-actions__confirm">
                <button
                  type="button"
                  className="pill pill--error"
                  onClick={() => setShowBatchConfirm(true)}
                  disabled={selectedIds.size === 0 || batchDeleting}
                >
                  {batchDeleting ? "Deleting..." : "Delete"}
                </button>
                <button
                  type="button"
                  className="pill"
                  onClick={resetSelection}
                  disabled={batchDeleting}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          <div className="panel-status">
            {loading ? <span className="pill">Loading...</span> : null}
            {loadingMore ? <span className="pill">Loading more...</span> : null}
            {error ? <span className="pill pill--error">{error}</span> : null}
            {batchError ? <span className="pill pill--error">{batchError}</span> : null}
          </div>
        </div>
        <VideoGrid
          videos={videos}
          onRefresh={refreshAll}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onDelete={(video) => handleDelete(video.id)}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelection}
          onUpdateLocation={handleUpdateLocation}
        />
      </section>
      {showBatchConfirm ? (
        <div
          className="confirm-modal"
          role="alertdialog"
          aria-modal="true"
          onClick={() => {
            if (!batchDeleting) setShowBatchConfirm(false);
          }}
        >
          <div
            className="confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="confirm-dialog__title">Confirm deletion</h3>
            <p className="confirm-dialog__text">
              Delete {selectedIds.size} video{selectedIds.size === 1 ? "" : "s"}?
            </p>
            {batchError ? (
              <p className="pill pill--error">{batchError}</p>
            ) : null}
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="pill"
                onClick={() => setShowBatchConfirm(false)}
                disabled={batchDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pill pill--error"
                onClick={handleBatchDelete}
                disabled={batchDeleting || selectedIds.size === 0}
              >
                {batchDeleting ? "Deleting..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
