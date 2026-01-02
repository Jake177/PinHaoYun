"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type VideoItem = {
  id: string;
  originalName?: string;
  thumbnailUrl?: string | null;
  originalUrl?: string | null;
  status?: string;
  createdAt?: string;
  captureTime?: string;
  captureLocation?: string;
  captureLat?: number;
  captureLon?: number;
  deviceMake?: string;
  deviceModel?: string;
  deviceSoftware?: string;
  size?: number;
};

type VideoGridProps = {
  videos: VideoItem[];
  onRefresh?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
};

const formatSize = (value?: number) => {
  if (!value) return "";
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = value / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = value / 1024;
  return `${kb.toFixed(0)} KB`;
};

const formatDate = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

export default function VideoGrid({
  videos,
  onRefresh,
  hasMore,
  loadingMore,
  onLoadMore,
}: VideoGridProps) {
  const [preview, setPreview] = useState<VideoItem | null>(null);
  const [showMeta, setShowMeta] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Infinite scroll observer
  useEffect(() => {
    if (!hasMore || !onLoadMore) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && hasMore && !loadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    // 每次切换预览，重置属性折叠状态
    setShowMeta(false);
  }, [previewKey]);

  const groups = useMemo(() => {
    const buckets: Record<string, VideoItem[]> = {};
    videos.forEach((vid) => {
      const dateStr = vid.captureTime || vid.createdAt || "";
      const date = Date.parse(dateStr) ? new Date(dateStr) : null;
      const key = date
        ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
        : "unknown";
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(vid);
    });
    // Sort groups by key desc (unknown last)
    const sortedKeys = Object.keys(buckets).sort((a, b) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return b.localeCompare(a);
    });
    return sortedKeys.map((key) => ({ key, items: buckets[key] }));
  }, [videos]);

  const renderLabel = (key: string) => {
    if (key === "unknown") return "未知日期";
    const [y, m] = key.split("-");
    return `${y}年${Number(m)}月`;
  };

  // 重置属性开关
  const handleClose = () => {
    setPreview(null);
    setShowMeta(false);
    setPreviewKey(null);
  };

  return (
    <>
      {videos.length === 0 ? (
        <div className="empty-state">
          <p>还没有上传视频，点击上方“上传视频”开始吧。</p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="video-group">
            <h3 className="video-group__title">{renderLabel(group.key)}</h3>
            <div className="video-grid">
              {group.items.map((video) => {
                const previewUrl = video.thumbnailUrl || video.originalUrl || "";
                return (
                  <article className="video-card" key={video.id}>
                    <div className="video-thumb">
                      {previewUrl ? (
                        <>
                          <video
                            src={previewUrl}
                            muted
                            preload="metadata"
                            onClick={() => {
                              setPreview(video);
                              setPreviewKey(video.originalUrl || video.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                setPreview(video);
                                setPreviewKey(video.originalUrl || video.id);
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            playsInline
                            poster={video.thumbnailUrl || video.originalUrl || undefined}
                          />
                          <span className="video-play">▶</span>
                        </>
                      ) : (
                        <div className="thumb-fallback">暂无预览</div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ))
      )}

      {/* Infinite scroll sentinel */}
      {videos.length > 0 && (
        <div ref={sentinelRef} className="load-more-sentinel">
          {loadingMore ? (
            <span className="pill">加载更多...</span>
          ) : hasMore ? (
            <button
              type="button"
              className="pill"
              onClick={onLoadMore}
            >
              加载更多
            </button>
          ) : null}
        </div>
      )}

      {preview ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          onClick={handleClose}
        >
          <div
            className="modal__body"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal__header">
              <div>
                <p className="muted">预览</p>
              </div>
              <button
                type="button"
                className="pill"
                onClick={handleClose}
              >
                关闭
              </button>
            </header>
            {preview.originalUrl ? (
              <video
                key={previewKey || preview.id}
                src={preview.originalUrl}
                controls
                playsInline
                preload="metadata"
                poster={preview.thumbnailUrl || undefined}
                style={{ width: "100%", maxHeight: "60vh" }}
                />
            ) : (
              <div className="empty-state">暂无预览</div>
            )}
            <div className="metadata-toggle">
              <button
                type="button"
                className="pill"
                onClick={() => setShowMeta((v) => !v)}
              >
                {showMeta ? "收起属性" : "查看属性"}
              </button>
              {preview.originalUrl ? (
                <a
                  className="pill pill--primary"
                  href={preview.originalUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: "0.5rem" }}
                >
                  下载原视频
                </a>
              ) : null}
            </div>
            <div
              className={`metadata-panel ${showMeta ? "metadata-panel--open" : ""}`}
              aria-expanded={showMeta}
            >
              <ul>
                <li>拍摄时间：{formatDate(preview.captureTime || preview.createdAt) || "未知"}</li>
                <li>文件大小：{formatSize(preview.size)}</li>
                <li>
                  设备：
                  {preview.deviceMake || preview.deviceModel
                    ? `${preview.deviceMake || ""} ${preview.deviceModel || ""}`.trim()
                    : "未知"}
                </li>
                <li>
                  软件版本：{preview.deviceSoftware || "未知"}
                </li>
                <li>
                  拍摄地点：
                  {preview.captureLocation ||
                    (preview.captureLat && preview.captureLon
                      ? `${preview.captureLat}, ${preview.captureLon}`
                      : "未知")}
                </li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
